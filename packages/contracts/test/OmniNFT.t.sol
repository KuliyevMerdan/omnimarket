// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OmniNFT} from "../src/OmniNFT.sol";

contract OmniNFTTest is Test {
    OmniNFT internal nft = new OmniNFT();

    function test_MintAssignsSequentialIds() public {
        uint256 first = nft.mint(3);
        assertEq(first, 1);
        assertEq(nft.ownerOf(3), address(this));
        assertEq(nft.totalSupply(), 3);
        assertEq(nft.mint(1), 4);
    }

    function test_RevertWhen_MintAmountInvalid() public {
        vm.expectRevert(abi.encodeWithSelector(OmniNFT.MintAmountInvalid.selector, 6));
        nft.mint(6);
        vm.expectRevert(abi.encodeWithSelector(OmniNFT.MintAmountInvalid.selector, 0));
        nft.mint(0);
    }

    function test_TokenURI_IsBase64Json() public {
        nft.mint(1);
        string memory uri = nft.tokenURI(1);
        assertEq(bytes(uri).length > 29, true);
        assertEq(_prefix(uri, 29), "data:application/json;base64,");
    }

    function _prefix(string memory value, uint256 length) internal pure returns (string memory) {
        bytes memory out = new bytes(length);
        for (uint256 i; i < length; ++i) {
            out[i] = bytes(value)[i];
        }
        return string(out);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
