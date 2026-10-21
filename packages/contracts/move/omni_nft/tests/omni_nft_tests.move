#[test_only]
module omni_nft::omni_nft_tests;

use omni_nft::omni_nft::{Self, OmniNft, Registry};
use sui::test_scenario;

const ALICE: address = @0xA11CE;

#[test]
fun mints_sequential_numbers() {
    let mut scenario = test_scenario::begin(ALICE);
    omni_nft::init_for_testing(scenario.ctx());
    scenario.next_tx(ALICE);
    let mut registry = scenario.take_shared<Registry>();
    omni_nft::mint(&mut registry, 2, scenario.ctx());
    test_scenario::return_shared(registry);

    scenario.next_tx(ALICE);
    let first = scenario.take_from_sender<OmniNft>();
    let second = scenario.take_from_sender<OmniNft>();
    assert!(first.number() + second.number() == 3);
    scenario.return_to_sender(first);
    scenario.return_to_sender(second);
    scenario.end();
}

#[test, expected_failure(abort_code = omni_nft::EInvalidAmount)]
fun rejects_more_than_five() {
    let mut scenario = test_scenario::begin(ALICE);
    omni_nft::init_for_testing(scenario.ctx());
    scenario.next_tx(ALICE);
    let mut registry = scenario.take_shared<Registry>();
    omni_nft::mint(&mut registry, 6, scenario.ctx());
    abort
}
