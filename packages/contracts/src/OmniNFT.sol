// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Demo collection with fully on-chain metadata (no IPFS dependency for the demo).
/// Anyone can mint a few tokens on testnets.
contract OmniNFT is ERC721 {
    using Strings for uint256;

    uint256 public constant MAX_PER_TX = 5;

    uint256 public totalSupply;

    error MintAmountInvalid(uint256 amount);

    constructor() ERC721("Omni Genesis", "OMNI") {}

    function mint(uint256 amount) external returns (uint256 firstTokenId) {
        if (amount == 0 || amount > MAX_PER_TX) revert MintAmountInvalid(amount);
        firstTokenId = totalSupply + 1;
        // Effects before interactions: `_safeMint` calls `onERC721Received` on contract minters.
        totalSupply += amount;
        for (uint256 i; i < amount; ++i) {
            _safeMint(msg.sender, firstTokenId + i);
        }
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        uint256 hue = uint256(keccak256(abi.encode(tokenId))) % 360;
        string memory svg = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
            '<rect width="100" height="100" fill="hsl(',
            hue.toString(),
            ',70%,55%)"/><text x="50" y="58" font-size="20" text-anchor="middle" fill="#fff" font-family="monospace">#',
            tokenId.toString(),
            "</text></svg>"
        );
        string memory json = string.concat(
            '{"name":"Omni Genesis #',
            tokenId.toString(),
            '","description":"OmniMarket demo token","image":"data:image/svg+xml;base64,',
            Base64.encode(bytes(svg)),
            '"}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }
}
