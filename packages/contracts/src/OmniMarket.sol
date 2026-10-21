// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Gasless listings: sellers sign EIP-712 orders off-chain, buyers fill them on-chain.
/// The seller pays gas only once, for `setApprovalForAll` on the collection.
contract OmniMarket is EIP712, ReentrancyGuard {
    struct Order {
        address seller;
        address collection;
        uint256 tokenId;
        uint256 price;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address seller,address collection,uint256 tokenId,uint256 price,uint256 nonce,uint256 deadline)"
    );

    /// @notice Orders signed with an older nonce are void: one tx cancels every open listing.
    mapping(address seller => uint256) public nonces;
    /// @notice Filled or individually cancelled orders.
    mapping(bytes32 orderHash => bool) public orderUsed;

    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed seller,
        address indexed buyer,
        address collection,
        uint256 tokenId,
        uint256 price
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed seller);
    event NonceIncremented(address indexed seller, uint256 newNonce);

    error OrderExpired(uint256 deadline);
    error OrderUnavailable(bytes32 orderHash);
    error InvalidNonce(uint256 expected, uint256 actual);
    error IncorrectPayment(uint256 expected, uint256 received);
    error InvalidSignature();
    error NotSeller();
    error PaymentFailed();

    constructor() EIP712("OmniMarket", "1") {}

    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.seller,
                    order.collection,
                    order.tokenId,
                    order.price,
                    order.nonce,
                    order.deadline
                )
            )
        );
    }

    /// @dev Checks-effects-interactions plus a reentrancy guard: `safeTransferFrom` calls into the buyer.
    function fillOrder(Order calldata order, bytes calldata signature) external payable nonReentrant {
        bytes32 orderHash = hashOrder(order);

        if (block.timestamp > order.deadline) revert OrderExpired(order.deadline);
        if (orderUsed[orderHash]) revert OrderUnavailable(orderHash);
        if (order.nonce != nonces[order.seller]) revert InvalidNonce(nonces[order.seller], order.nonce);
        if (msg.value != order.price) revert IncorrectPayment(order.price, msg.value);
        // Supports EOAs (ecrecover) and smart-contract wallets (EIP-1271).
        if (!SignatureChecker.isValidSignatureNow(order.seller, orderHash, signature)) revert InvalidSignature();

        orderUsed[orderHash] = true;
        emit OrderFilled(orderHash, order.seller, msg.sender, order.collection, order.tokenId, order.price);

        IERC721(order.collection).safeTransferFrom(order.seller, msg.sender, order.tokenId);
        (bool paid,) = order.seller.call{value: msg.value}("");
        if (!paid) revert PaymentFailed();
    }

    function cancelOrder(Order calldata order) external {
        if (msg.sender != order.seller) revert NotSeller();
        bytes32 orderHash = hashOrder(order);
        orderUsed[orderHash] = true;
        emit OrderCancelled(orderHash, msg.sender);
    }

    function incrementNonce() external returns (uint256 newNonce) {
        newNonce = ++nonces[msg.sender];
        emit NonceIncremented(msg.sender, newNonce);
    }
}
