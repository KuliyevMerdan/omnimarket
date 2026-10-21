/// Demo collection for the Sui side of OmniMarket. Trading goes through Kiosk, Sui's native
/// marketplace primitive, so this module only needs a TransferPolicy, not its own market contract.
module omni_nft::omni_nft;

use std::string::String;
use sui::display;
use sui::event;
use sui::package;
use sui::transfer_policy;

/// One-time witness: proves we are the publisher (needed for Display and TransferPolicy).
public struct OMNI_NFT has drop {}

public struct OmniNft has key, store {
    id: UID,
    name: String,
    number: u64,
    image_url: String,
}

/// Shared counter so numbers are sequential across all minters.
public struct Registry has key {
    id: UID,
    minted: u64,
}

public struct Minted has copy, drop {
    object_id: ID,
    number: u64,
    owner: address,
}

const MAX_PER_TX: u64 = 5;

#[error]
const EInvalidAmount: vector<u8> = b"Mint 1 to 5 at a time";

#[allow(lint(share_owned))] // the policy is created right here; sharing it is the documented pattern
fun init(otw: OMNI_NFT, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);

    let mut display = display::new<OmniNft>(&publisher, ctx);
    display.add(b"name".to_string(), b"{name}".to_string());
    display.add(b"image_url".to_string(), b"{image_url}".to_string());
    display.add(b"description".to_string(), b"OmniMarket demo token".to_string());
    display.update_version();

    // Empty policy: Kiosk purchases resolve their TransferRequest against it (no royalty/lock rules).
    let (policy, policy_cap) = transfer_policy::new<OmniNft>(&publisher, ctx);
    transfer::public_share_object(policy);

    transfer::public_transfer(policy_cap, ctx.sender());
    transfer::public_transfer(display, ctx.sender());
    transfer::public_transfer(publisher, ctx.sender());
    transfer::share_object(Registry { id: object::new(ctx), minted: 0 });
}

/// Composable: returns the object, so a programmable transaction can mint and list it in a
/// Kiosk in one go (`mint_one` → `kiosk::place_and_list`).
public fun mint_one(registry: &mut Registry, ctx: &mut TxContext): OmniNft {
    registry.minted = registry.minted + 1;
    let number = registry.minted;
    let nft = OmniNft { id: object::new(ctx), name: name(number), number, image_url: image(number) };
    event::emit(Minted { object_id: object::id(&nft), number, owner: ctx.sender() });
    nft
}

/// Convenience entry point for wallets/CLIs: mint `amount` straight to the sender.
#[allow(lint(self_transfer))]
entry fun mint(registry: &mut Registry, amount: u64, ctx: &mut TxContext) {
    assert!(amount >= 1 && amount <= MAX_PER_TX, EInvalidAmount);
    amount.do!(|_| transfer::public_transfer(mint_one(registry, ctx), ctx.sender()));
}

public fun number(nft: &OmniNft): u64 { nft.number }

fun name(number: u64): String {
    let mut s = b"Omni Sui #".to_string();
    s.append(number.to_string());
    s
}

/// Percent-encoded SVG data URI; renders through `<img>` only (no script execution).
fun image(number: u64): String {
    let hue = (number * 47) % 360;
    let mut s = b"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E%3Crect%20width='100'%20height='100'%20fill='hsl(".to_string();
    s.append(hue.to_string());
    s.append(b",70%25,55%25)'/%3E%3Ctext%20x='50'%20y='58'%20font-size='20'%20text-anchor='middle'%20fill='white'%20font-family='monospace'%3E%23".to_string());
    s.append(number.to_string());
    s.append(b"%3C/text%3E%3C/svg%3E".to_string());
    s
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(OMNI_NFT {}, ctx)
}
