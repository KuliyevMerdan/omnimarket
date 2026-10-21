// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {OmniMarket} from "../src/OmniMarket.sol";
import {OmniNFT} from "../src/OmniNFT.sol";

/// Smart-contract wallet that accepts signatures from its owner key (EIP-1271).
contract ContractWallet is IERC1271, IERC721Receiver {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return ECDSA.recover(hash, signature) == owner ? IERC1271.isValidSignature.selector : bytes4(0);
    }

    function approve(OmniNFT nft, address operator) external {
        nft.setApprovalForAll(operator, true);
    }

    function mint(OmniNFT nft) external {
        nft.mint(1);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}
}

/// Buyer that tries to fill the same order again from inside the ERC-721 callback.
contract ReentrantBuyer is IERC721Receiver {
    OmniMarket internal immutable market;
    OmniMarket.Order internal order;
    bytes internal signature;
    bool internal attacked;

    constructor(OmniMarket market_) {
        market = market_;
    }

    function buy(OmniMarket.Order calldata order_, bytes calldata signature_) external payable {
        order = order_;
        signature = signature_;
        market.fillOrder{value: msg.value}(order_, signature_);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!attacked) {
            attacked = true;
            market.fillOrder{value: 0}(order, signature);
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract OmniMarketTest is Test {
    OmniMarket internal market;
    OmniNFT internal nft;

    uint256 internal sellerKey = 0xA11CE;
    address internal seller = vm.addr(sellerKey);
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        market = new OmniMarket();
        nft = new OmniNFT();
        vm.deal(buyer, 10 ether);

        vm.startPrank(seller);
        nft.mint(1);
        nft.setApprovalForAll(address(market), true);
        vm.stopPrank();
    }

    function _order(uint256 price) internal view returns (OmniMarket.Order memory) {
        return OmniMarket.Order({
            seller: seller,
            collection: address(nft),
            tokenId: 1,
            price: price,
            nonce: market.nonces(seller),
            deadline: block.timestamp + 1 days
        });
    }

    function _sign(uint256 key, OmniMarket.Order memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, market.hashOrder(order));
        return abi.encodePacked(r, s, v);
    }

    function test_FillOrder_TransfersTokenAndPaysSeller() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);

        vm.expectEmit(address(market));
        emit OmniMarket.OrderFilled(market.hashOrder(order), seller, buyer, address(nft), 1, 1 ether);
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);

        assertEq(nft.ownerOf(1), buyer);
        assertEq(seller.balance, 1 ether);
        assertTrue(market.orderUsed(market.hashOrder(order)));
    }

    function test_RevertWhen_OrderReplayed() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);

        vm.expectRevert(abi.encodeWithSelector(OmniMarket.OrderUnavailable.selector, market.hashOrder(order)));
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);
    }

    function test_RevertWhen_Expired() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);
        vm.warp(order.deadline + 1);

        vm.expectRevert(abi.encodeWithSelector(OmniMarket.OrderExpired.selector, order.deadline));
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);
    }

    function test_RevertWhen_WrongPayment() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);

        vm.expectRevert(abi.encodeWithSelector(OmniMarket.IncorrectPayment.selector, 1 ether, 0.5 ether));
        vm.prank(buyer);
        market.fillOrder{value: 0.5 ether}(order, signature);
    }

    function test_RevertWhen_SignedByAnotherKey() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(0xBAD, order);

        vm.expectRevert(OmniMarket.InvalidSignature.selector);
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);
    }

    function test_RevertWhen_PriceTampered() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);
        order.price = 0.01 ether;

        vm.expectRevert(OmniMarket.InvalidSignature.selector);
        vm.prank(buyer);
        market.fillOrder{value: 0.01 ether}(order, signature);
    }

    function test_CancelOrder() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);

        vm.expectRevert(OmniMarket.NotSeller.selector);
        vm.prank(buyer);
        market.cancelOrder(order);

        vm.prank(seller);
        market.cancelOrder(order);

        vm.expectRevert(abi.encodeWithSelector(OmniMarket.OrderUnavailable.selector, market.hashOrder(order)));
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);
    }

    function test_IncrementNonce_VoidsAllOpenOrders() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);

        vm.prank(seller);
        market.incrementNonce();

        vm.expectRevert(abi.encodeWithSelector(OmniMarket.InvalidNonce.selector, 1, 0));
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);
    }

    function test_RevertWhen_SellerRevokedApproval() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);
        vm.prank(seller);
        nft.setApprovalForAll(address(market), false);

        // The collection's error bubbles up through the market; the frontend decodes it with the NFT ABI.
        vm.expectRevert(
            abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, address(market), 1)
        );
        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);
    }

    function test_ContractWalletSeller_Eip1271() public {
        uint256 ownerKey = 0xC0FFEE;
        ContractWallet wallet = new ContractWallet(vm.addr(ownerKey));
        wallet.mint(nft);
        wallet.approve(nft, address(market));

        OmniMarket.Order memory order = OmniMarket.Order({
            seller: address(wallet),
            collection: address(nft),
            tokenId: 2,
            price: 1 ether,
            nonce: 0,
            deadline: block.timestamp + 1 days
        });
        bytes memory signature = _sign(ownerKey, order);

        vm.prank(buyer);
        market.fillOrder{value: 1 ether}(order, signature);
        assertEq(nft.ownerOf(2), buyer);
        assertEq(address(wallet).balance, 1 ether);
    }

    function test_RevertWhen_ReentrantFill() public {
        OmniMarket.Order memory order = _order(1 ether);
        bytes memory signature = _sign(sellerKey, order);
        ReentrantBuyer attacker = new ReentrantBuyer(market);
        vm.deal(address(attacker), 1 ether);

        vm.expectRevert();
        attacker.buy{value: 1 ether}(order, signature);
        assertEq(nft.ownerOf(1), seller);
    }

    function testFuzz_FillOrder_AnyPrice(uint96 price) public {
        OmniMarket.Order memory order = _order(price);
        bytes memory signature = _sign(sellerKey, order);
        vm.deal(buyer, price);

        vm.prank(buyer);
        market.fillOrder{value: price}(order, signature);
        assertEq(seller.balance, price);
    }
}
