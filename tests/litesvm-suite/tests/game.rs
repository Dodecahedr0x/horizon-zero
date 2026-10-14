use horizon_combat::{
    army_cost, behavior_charge, behavior_charge_cast, behavior_flank_left, behavior_flank_left_cast, behavior_flank_right, behavior_flank_right_cast, behavior_hash, behavior_kite,
    behavior_kite_cast, behavior_march, behavior_march_cast, simulate, stats_for, AshbornKind, BehaviorBody, DeeplingsKind, Geometry, Race, RootbornKind, Side, SnapshotUnit, MAX_UNITS,
};
use horizon_litesvm_tests::{sha256, sighash, HYDRA_ID, PROGRAM_ID, VRF_ID};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::{address, Address};
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const STAKE: u64 = 50_000_000;

/// One army unit: its kind and its zone-local column and row.
type Placement = (AshbornKind, u8, u8);
const BUDGET: u16 = 8;

struct Env {
    svm: LiteSVM,
    program: Address,
    vrf: Address,
    hydra: Address,
    queue: Address,
    admin: Keypair,
    config: Address,
}

fn pda(seeds: &[&[u8]], program: &Address) -> (Address, u8) {
    Address::find_program_address(seeds, program)
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) -> Vec<String> {
    svm.expire_blockhash();
    let hash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &hash);
    let tx = Transaction::new(&[payer], msg, hash);
    let meta = svm.send_transaction(tx).unwrap_or_else(|err| {
        panic!("tx failed: {:?}\n{}", err.err, err.meta.pretty_logs());
    });
    meta.logs
}

fn send_expect_err(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction]) {
    svm.expire_blockhash();
    let hash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &hash);
    let tx = Transaction::new(&[payer], msg, hash);
    let err = svm.send_transaction(tx).expect_err("transaction should fail");
    assert!(!err.meta.logs.is_empty(), "{:?}", err.err);
}

/// Sends a transaction that must fail with a log line containing `reason`.
fn send_expect_reason(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction], reason: &str) {
    svm.expire_blockhash();
    let hash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &hash);
    let tx = Transaction::new(&[payer], msg, hash);
    let err = svm.send_transaction(tx).expect_err("transaction should fail");
    assert!(err.meta.logs.iter().any(|line| line.contains(reason)), "expected {reason}:\n{}", err.meta.pretty_logs());
}

/// As [`send_expect_reason`], building the instructions from the environment first.
fn send_expect_reason_with(env: &mut Env, payer: &Keypair, build: impl Fn(&Env) -> Vec<Instruction>, reason: &str) {
    let ixs = build(env);
    send_expect_reason(&mut env.svm, payer, &ixs, reason);
}

fn ix(program: Address, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction { program_id: program, accounts, data }
}

fn disc(name: &str, rest: &[u8]) -> Vec<u8> {
    let mut data = sighash(name).to_vec();
    data.extend_from_slice(rest);
    data
}

fn meta(key: Address, writable: bool, signer: bool) -> AccountMeta {
    AccountMeta { pubkey: key, is_signer: signer, is_writable: writable }
}

fn setup() -> Env {
    setup_on(LiteSVM::new())
}

/// LiteSVM's usual VM on mainnet's runtime features, plus `sol_remaining_compute_units` for the
/// profiler. The syscall table is built with the builtins, so the features are set first; this is
/// the same chain as `LiteSVM::new`.
fn bench_vm() -> LiteSVM {
    let mut features = LiteSVM::mainnet_feature_set();
    features.activate(&agave_feature_set::remaining_compute_units_syscall_enabled::id(), 0);
    LiteSVM::default()
        .with_feature_set(features)
        .with_builtins()
        .with_lamports(1_000_000_000_000_000)
        .with_sysvars()
        .with_feature_accounts()
        .with_default_programs()
        .with_sigverify(true)
        .with_blockhash_check(true)
        // Profiling probes add their own cost; a larger limit lets a profiled battle finish. The
        // reported numbers are per battle, so the limit does not change them.
        .with_compute_budget(solana_compute_budget::compute_budget::ComputeBudget {
            compute_unit_limit: 10_000_000,
            ..solana_compute_budget::compute_budget::ComputeBudget::new_with_defaults(false)
        })
}

/// The fixture on a given VM, for example one with the profiler's syscall enabled.
fn setup_on(svm: LiteSVM) -> Env {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let horizon = root.join("target/deploy/horizon_zero.so");
    let mock = root.join("target/deploy/mock_vrf.so");
    // HZ_HYDRA_SO points at a real Hydra build (github.com/magicblock-labs/hydra) instead of the mock.
    let mock_hydra = std::env::var_os("HZ_HYDRA_SO").map(std::path::PathBuf::from).unwrap_or_else(|| root.join("target/deploy/mock_hydra.so"));
    assert!(horizon.exists(), "missing {horizon:?}; run cargo build-sbf for horizon-zero --features inline-mock-vrf");
    assert!(mock.exists(), "missing {mock:?}; run cargo build-sbf for mock-vrf");
    assert!(mock_hydra.exists(), "missing {mock_hydra:?}; run cargo build-sbf for mock-hydra");

    let mut svm = svm;
    let program: Address = PROGRAM_ID.parse().unwrap();
    let vrf: Address = VRF_ID.parse().unwrap();
    svm.add_program(program, &std::fs::read(&horizon).unwrap()).unwrap();
    svm.add_program(vrf, &std::fs::read(&mock).unwrap()).unwrap();
    let hydra: Address = HYDRA_ID.parse().unwrap();
    svm.add_program(hydra, &std::fs::read(&mock_hydra).unwrap()).unwrap();

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 20_000_000_000).unwrap();
    let queue = Address::new_unique();
    svm.set_account(queue, Account { lamports: 1_000_000_000, data: vec![0; 256], owner: vrf, executable: false, rent_epoch: 0 }).unwrap();

    let (config, _) = pda(&[b"config"], &program);
    let identity = pda(&[b"identity"], &program).0;
    send(
        &mut svm,
        &admin,
        &[ix(
            program,
            vec![meta(admin.pubkey(), true, true), meta(config, true, false), meta(identity, true, false), meta(address!("11111111111111111111111111111111"), false, false)],
            disc("initialize", &[]),
        )],
    );

    let mut env = Env { svm, program, vrf, hydra, queue, admin, config };
    env.create_battleground(0, BUDGET, STAKE, 8, 6);
    env.create_battleground(1, 16, 200_000_000, 10, 8);
    env.create_battleground(2, 32, 1_000_000_000, 12, 10);
    env
}

impl Env {
    fn create_battleground(&mut self, id: u8, budget: u16, stake: u64, cols: u8, rows: u8) {
        let (ground, _) = pda(&[b"battleground", &[id]], &self.program);
        let mut data = vec![id];
        data.extend_from_slice(&budget.to_le_bytes());
        data.extend_from_slice(&stake.to_le_bytes());
        data.push(cols);
        data.push(rows);
        send(
            &mut self.svm,
            &self.admin,
            &[ix(
                self.program,
                vec![
                    meta(self.admin.pubkey(), true, true),
                    meta(self.config, false, false),
                    meta(ground, true, false),
                    meta(address!("11111111111111111111111111111111"), false, false),
                ],
                disc("create_battleground", &data),
            )],
        );
        let account = self.svm.get_account(&ground).unwrap();
        assert_eq!(account.data.len(), 576);
        assert_eq!(account.data[51], cols);
        assert_eq!(account.data[52], rows);
        assert_eq!(account.data[53], 2);
    }

    fn behavior(&mut self, body: &[u8]) -> Address {
        let hash = behavior_hash(body);
        let (key, _) = pda(&[b"behavior", &hash], &self.program);
        send(
            &mut self.svm,
            &self.admin,
            &[ix(
                self.program,
                vec![meta(self.admin.pubkey(), true, true), meta(key, true, false), meta(address!("11111111111111111111111111111111"), false, false)],
                disc("create_behavior", &behavior_args(&hash, body)),
            )],
        );
        key
    }

    fn fund(&mut self, player: &Keypair) {
        self.svm.airdrop(&player.pubkey(), 10_000_000_000).unwrap();
    }

    /// An army of several units that all follow one behavior.
    fn squad(&mut self, owner: &Keypair, ground_id: u8, index: u32, units: &[Placement], behavior: Address) -> Address {
        let (ground, _) = pda(&[b"battleground", &[ground_id]], &self.program);
        let index_bytes = index.to_le_bytes();
        let (army, _) = pda(&[b"army", owner.pubkey().as_ref(), &index_bytes], &self.program);
        let mut rest = index_bytes.to_vec();
        rest.push(0);
        rest.extend_from_slice(&(units.len() as u32).to_le_bytes());
        for &(kind, col, row) in units {
            rest.push(kind.id());
            rest.extend_from_slice(behavior.as_ref());
            rest.push(col);
            rest.push(row);
        }
        let mut accounts =
            vec![meta(owner.pubkey(), true, true), meta(ground, false, false), meta(army, true, false), meta(address!("11111111111111111111111111111111"), false, false)];
        accounts.extend(units.iter().map(|_| meta(behavior, false, false)));
        send(&mut self.svm, owner, &[ix(self.program, accounts, disc("create_army", &rest))]);
        army
    }

    fn army(&mut self, owner: &Keypair, ground_id: u8, index: u32, kind: u8, behavior: Address) -> Address {
        let (ground, _) = pda(&[b"battleground", &[ground_id]], &self.program);
        let index_bytes = index.to_le_bytes();
        let (army, _) = pda(&[b"army", owner.pubkey().as_ref(), &index_bytes], &self.program);
        let mut rest = index_bytes.to_vec();
        rest.push(0);
        rest.extend_from_slice(&1u32.to_le_bytes());
        rest.push(kind);
        rest.extend_from_slice(behavior.as_ref());
        rest.push(0);
        rest.push(0);
        send(
            &mut self.svm,
            owner,
            &[ix(
                self.program,
                vec![
                    meta(owner.pubkey(), true, true),
                    meta(ground, false, false),
                    meta(army, true, false),
                    meta(address!("11111111111111111111111111111111"), false, false),
                    meta(behavior, false, false),
                ],
                disc("create_army", &rest),
            )],
        );
        let stored = &self.svm.get_account(&army).unwrap().data;
        assert_eq!(stored.len(), 1360);
        assert_eq!(stored[78 + 111], 0);
        assert_eq!(stored[78 + 112], 0);
        let stats = stats_for(Race::Ashborn.id(), kind).unwrap();
        assert_eq!(u16::from_le_bytes(stored[78 + 113..78 + 115].try_into().unwrap()), stats.cost);
        assert_eq!(stored[78 + 115], stats.hp as u8);
        assert_eq!(stored[78 + 119], stats.cast.damage);
        assert_eq!(stored[78 + 120], stats.cast.range);
        assert_eq!(stored[78 + 121], stats.cast.aoe);
        assert_eq!(stored[78 + 122], stats.cast.effect.id());
        assert_eq!(stored[78 + 123], stats.cast.aim.id());
        assert_eq!(stored[78 + 124], stats.cast.power);
        assert_eq!(stored[78 + 125], stats.cast.rounds);
        assert_eq!(stored[78 + 126], stats.cast.cooldown);
        assert_eq!(stored[78 + 127], stats.actions as u8);
        army
    }

    fn balance(&self, key: &Address) -> u64 {
        self.svm.get_account(key).map(|account| account.lamports).unwrap_or(0)
    }
}

fn cu_limit() -> Instruction {
    let mut data = vec![2];
    data.extend_from_slice(&1_400_000u32.to_le_bytes());
    Instruction { program_id: address!("ComputeBudget111111111111111111111111111111"), accounts: vec![], data }
}

fn behavior_args(hash: &[u8; 32], body: &[u8]) -> Vec<u8> {
    let mut rest = hash.to_vec();
    rest.extend_from_slice(&(body.len() as u32).to_le_bytes());
    rest.extend_from_slice(body);
    rest
}

fn still_body() -> Vec<u8> {
    BehaviorBody::parse(&[1, 0, 0]).unwrap().canonical_bytes()
}

#[test]
fn behavior_pda_rejects_duplicates_and_a_mismatched_hash() {
    let mut env = setup();
    let march = behavior_march().canonical_bytes();
    let hash = behavior_hash(&march);
    let (key, _) = pda(&[b"behavior", &hash], &env.program);
    let rest = behavior_args(&hash, &march);
    let accounts = vec![meta(env.admin.pubkey(), true, true), meta(key, true, false), meta(address!("11111111111111111111111111111111"), false, false)];
    send(&mut env.svm, &env.admin, &[ix(env.program, accounts.clone(), disc("create_behavior", &rest))]);
    send_expect_err(&mut env.svm, &env.admin, &[ix(env.program, accounts, disc("create_behavior", &rest))]);

    let charge = behavior_charge().canonical_bytes();
    let mut wrong = [0u8; 32];
    wrong[0] = 1;
    assert_ne!(behavior_hash(&charge), wrong);
    let (bad_key, _) = pda(&[b"behavior", &wrong], &env.program);
    send_expect_err(
        &mut env.svm,
        &env.admin,
        &[ix(
            env.program,
            vec![meta(env.admin.pubkey(), true, true), meta(bad_key, true, false), meta(address!("11111111111111111111111111111111"), false, false)],
            disc("create_behavior", &behavior_args(&wrong, &charge)),
        )],
    );
    assert!(env.svm.get_account(&bad_key).is_none());

    let other = behavior_hash(&charge);
    assert_ne!(hash, other);
    let (other_key, _) = pda(&[b"behavior", &other], &env.program);
    assert_ne!(key, other_key);
    env.behavior(&charge);
    assert!(env.svm.get_account(&other_key).is_some());
}

#[test]
fn budget_unknown_behavior_and_wrong_owner_fail() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    assert!(army_cost(Race::Ashborn.id(), &[AshbornKind::Warden.id(), AshbornKind::Warden.id(), AshbornKind::Warden.id()]).unwrap() > BUDGET);

    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let index = 0u32.to_le_bytes();
    let (army, _) = pda(&[b"army", player.pubkey().as_ref(), &index], &env.program);
    let mut rest = index.to_vec();
    rest.push(0);
    rest.extend_from_slice(&3u32.to_le_bytes());
    for col in 0..3u8 {
        rest.push(AshbornKind::Warden.id());
        rest.extend_from_slice(hold.as_ref());
        rest.push(col);
        rest.push(0);
    }
    send_expect_err(
        &mut env.svm,
        &player,
        &[ix(
            env.program,
            vec![
                meta(player.pubkey(), true, true),
                meta(ground, false, false),
                meta(army, true, false),
                meta(address!("11111111111111111111111111111111"), false, false),
                meta(hold, false, false),
                meta(hold, false, false),
                meta(hold, false, false),
            ],
            disc("create_army", &rest),
        )],
    );

    let bogus = Address::new_unique();
    let mut rest = index.to_vec();
    rest.push(0);
    rest.extend_from_slice(&1u32.to_le_bytes());
    rest.push(AshbornKind::Guard.id());
    rest.extend_from_slice(bogus.as_ref());
    rest.push(0);
    rest.push(0);
    send_expect_err(
        &mut env.svm,
        &player,
        &[ix(
            env.program,
            vec![
                meta(player.pubkey(), true, true),
                meta(ground, false, false),
                meta(army, true, false),
                meta(address!("11111111111111111111111111111111"), false, false),
                meta(bogus, false, false),
            ],
            disc("create_army", &rest),
        )],
    );

    let army = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let other = Keypair::new();
    env.fund(&other);
    fund_pot(&mut env, &other, 0, STAKE);
    let lock = lock_ix(&env, &other, ground, army, Address::new_unique(), &[hold], vec![]);
    send_expect_reason(&mut env.svm, &other, &[cu_limit(), lock], "NotOwner");
}

#[test]
fn positions_must_sit_in_the_zone_and_stay_unique() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let index = 4u32.to_le_bytes();
    let (army, _) = pda(&[b"army", player.pubkey().as_ref(), &index], &env.program);
    let system = address!("11111111111111111111111111111111");

    let mut outside = index.to_vec();
    outside.push(0);
    outside.extend_from_slice(&1u32.to_le_bytes());
    outside.push(AshbornKind::Guard.id());
    outside.extend_from_slice(hold.as_ref());
    outside.push(0);
    outside.push(2);
    send_expect_err(
        &mut env.svm,
        &player,
        &[ix(
            env.program,
            vec![meta(player.pubkey(), true, true), meta(ground, false, false), meta(army, true, false), meta(system, false, false), meta(hold, false, false)],
            disc("create_army", &outside),
        )],
    );

    let mut shared = index.to_vec();
    shared.push(0);
    shared.extend_from_slice(&2u32.to_le_bytes());
    for _ in 0..2 {
        shared.push(AshbornKind::Guard.id());
        shared.extend_from_slice(hold.as_ref());
        shared.push(1);
        shared.push(0);
    }
    send_expect_err(
        &mut env.svm,
        &player,
        &[ix(
            env.program,
            vec![
                meta(player.pubkey(), true, true),
                meta(ground, false, false),
                meta(army, true, false),
                meta(system, false, false),
                meta(hold, false, false),
                meta(hold, false, false),
            ],
            disc("create_army", &shared),
        )],
    );

    let mut placed = index.to_vec();
    placed.push(0);
    placed.extend_from_slice(&2u32.to_le_bytes());
    for col in 0..2u8 {
        placed.push(AshbornKind::Guard.id());
        placed.extend_from_slice(hold.as_ref());
        placed.push(col);
        placed.push(0);
    }
    send(
        &mut env.svm,
        &player,
        &[ix(
            env.program,
            vec![
                meta(player.pubkey(), true, true),
                meta(ground, false, false),
                meta(army, true, false),
                meta(system, false, false),
                meta(hold, false, false),
                meta(hold, false, false),
            ],
            disc("create_army", &placed),
        )],
    );
    let data = env.svm.get_account(&army).unwrap().data;
    assert_eq!(data[78 + 111], 0);
    assert_eq!(data[78 + 112], 0);
    assert_eq!(data[78 + 128 + 111], 1);
    assert_eq!(data[78 + 128 + 112], 0);
}

#[test]
fn locking_needs_a_pot_that_covers_the_stake_and_unlock_dequeues() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    let army = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let lock = |env: &Env| lock_ix(env, &player, ground, army, Address::new_unique(), &[hold], vec![]);

    // No pot yet, then a pot one lamport short of the stake.
    send_expect_reason_with(&mut env, &player, |env| vec![cu_limit(), lock(env)], "AccountNotInitialized");
    fund_pot(&mut env, &player, 0, STAKE - 1);
    send_expect_reason_with(&mut env, &player, |env| vec![cu_limit(), lock(env)], "PotTooLow");

    fund_pot(&mut env, &player, 0, 1);
    let pot = pot_pda(&env, 0, &player.pubkey());
    let held = env.balance(&pot);
    let ixs = [cu_limit(), lock(&env)];
    let logs = send(&mut env.svm, &player, &ixs);
    assert!(logs.iter().any(|line| line.contains("HZ_QUEUED")));
    // Queuing reserves nothing: the stake leaves the pot only when a match opens.
    assert_eq!(env.balance(&pot), held);
    assert_eq!(pot_state(&env, &pot), (STAKE, 0, false, 0));
    assert_eq!(env.svm.get_account(&army).unwrap().data[1358], 1);

    let call = [unlock_ix(&env, &player, ground, army)];
    send(&mut env.svm, &player, &call);
    assert_eq!(env.svm.get_account(&army).unwrap().data[1358], 0);
    assert_eq!(ground_queue_len(&env, &ground), 0);
}

#[test]
fn close_army_needs_the_owner_and_an_idle_army() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    let stranger = Keypair::new();
    env.fund(&player);
    env.fund(&stranger);
    let army = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let program = env.program;
    let close = |owner: &Keypair| ix(program, vec![meta(owner.pubkey(), true, true), meta(army, true, false)], disc("close_army", &[]));

    send_expect_reason(&mut env.svm, &stranger, &[close(&stranger)], "NotOwner");

    queue(&mut env, &player, army, hold);
    send_expect_reason(&mut env.svm, &player, &[close(&player)], "BadStatus");

    let call = [unlock_ix(&env, &player, ground, army)];
    send(&mut env.svm, &player, &call);
    let rent = env.balance(&army);
    let before = env.balance(&player.pubkey());
    let logs = send(&mut env.svm, &player, &[close(&player)]);
    assert!(logs.iter().any(|line| line.contains("HZ_ARMY_CLOSE")));
    assert_eq!(env.balance(&army), 0);
    assert!(env.svm.get_account(&army).map_or(true, |account| account.data.is_empty()));
    assert!(env.balance(&player.pubkey()) + 10_000 > before + rent);

    // The index is free again: a new army can take the same address.
    let again = env.army(&player, 0, 0, AshbornKind::Archer.id(), hold);
    assert_eq!(again, army);
}

#[test]
fn match_pays_the_simulated_winner_and_a_draw_refunds() {
    let mut env = setup();
    let advance = env.behavior(&behavior_march().canonical_bytes());
    let hold = env.behavior(&still_body());
    let first = Keypair::new();
    let second = Keypair::new();
    env.fund(&first);
    env.fund(&second);
    let army_a = env.army(&first, 0, 0, AshbornKind::Guard.id(), advance);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), advance);
    queue(&mut env, &first, army_a, advance);
    fund_pot(&mut env, &second, 0, STAKE);
    let (pot_a, pot_b) = (pot_pda(&env, 0, &first.pubkey()), pot_pda(&env, 0, &second.pubkey()));
    let (battle, logs) = lock_and_seed(&mut env, 0, &second, army_b, advance, army_a, &first, None);
    // Each pot staked once and counts one unsettled battle; the battle holds both stakes.
    assert_eq!(pot_state(&env, &pot_a), (0, 0, false, 1));
    assert_eq!(pot_state(&env, &pot_b), (0, 0, false, 1));
    let call = [pot_ix(&env, &first, 0, "close_pot", &[])];
    send_expect_reason(&mut env.svm, &first, &call, "PotBusy");
    // The oracle gives its callback transaction 300 000 CU; seeding needs a small part of it.
    let seeding = program_cost(&env, &logs);
    println!("seed_match consumed {seeding} CU");
    assert!(seeding < 100_000, "seed_match consumed {seeding} CU");

    // The callback stored the seed and scheduled a one-shot crank paid from the emptied vault.
    let data = env.svm.get_account(&battle).unwrap().data;
    assert_eq!(data.len(), 2145);
    assert_eq!(data[186], 8);
    assert_eq!(data[187], 6);
    assert_eq!(data[2108], 2, "seeded");
    assert_eq!(data[2141], 0, "no outcome yet");
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&data[2109..2141]);
    assert_eq!(&seed, &sha256(battle.as_ref()));
    let (fund, crank) = crank_keys(&env, &battle);
    assert_eq!(env.balance(&fund), 0, "the vault is spent");
    let crank_account = env.svm.get_account(&crank).unwrap();
    assert_eq!(crank_account.owner, env.hydra);
    assert_eq!(&crank_account.data[..32], battle.as_ref(), "the battle is the cancel authority");
    assert_eq!(u64::from_le_bytes(crank_account.data[80..88].try_into().unwrap()), 1, "runs once");
    let crank_lamports = crank_account.lamports;
    let replay = mock_fulfill(&env, &battle, &second.pubkey(), &seed);
    send_expect_reason(&mut env.svm, &second, &[cu_limit(), replay], "AlreadyResolved");

    // Settling needs the Hydra trigger for this battle's crank right before it.
    let settle = scheduled(&crank_account.data).remove(0);
    send_expect_reason(&mut env.svm, &second, &[cu_limit(), settle.clone()], "NotCranked");
    let mut stray = settle.clone();
    stray.accounts.push(meta(Address::new_unique(), false, false));
    let cranker = Keypair::new();
    env.fund(&cranker);
    let pull = trigger(&env, &crank, &cranker.pubkey());
    // Hydra's MismatchedFollowupIx.
    send_expect_reason(&mut env.svm, &cranker, &[cu_limit(), pull, stray], "custom program error: 0x7");
    assert_eq!(env.svm.get_account(&battle).unwrap().data[2108], 2);

    // A crank someone else created with the same template triggers, but the settlement refuses it.
    let impostor = Keypair::new();
    env.fund(&impostor);
    let fake = hydra_create(&env, &impostor, [7; 32], &settle);
    send(&mut env.svm, &impostor, &[fake]);
    let fake_crank = pda(&[b"crank", impostor.pubkey().as_ref(), &[7; 32]], &env.hydra).0;
    env.svm.airdrop(&fake_crank, 100_000).unwrap();
    let pull = trigger(&env, &fake_crank, &cranker.pubkey());
    send_expect_reason(&mut env.svm, &cranker, &[cu_limit(), pull, settle.clone()], "NotCranked");

    let cranker_before = env.balance(&cranker.pubkey());
    let second_before_settle = env.balance(&second.pubkey());
    let settled = vec![cu_limit(), trigger(&env, &crank, &cranker.pubkey()), settle.clone()];
    let logs = send(&mut env.svm, &cranker, &settled);
    assert!(logs.iter().any(|line| line.contains("HZ_MATCH_RESOLVED")));
    let data = env.svm.get_account(&battle).unwrap().data;
    assert_eq!(data[2108], 1, "resolved");
    let outcome = data[2141];
    let guard = SnapshotUnit::catalog(Race::Ashborn.id(), AshbornKind::Guard.id(), behavior_march(), 0, 0).unwrap();
    let (winner, _) = simulate(&[guard], &[guard], seed, Geometry { cols: 8, rows: 6 });
    let expected = match winner {
        Some(Side::A) => 1,
        Some(Side::B) => 2,
        None => 3,
    };
    assert_eq!(outcome, expected);
    assert_eq!(env.svm.get_account(&army_a).unwrap().data[1358], 0);
    assert_eq!(env.svm.get_account(&army_b).unwrap().data[1358], 0);
    // The cranker paid one fee and earned the reward; the crank is closed and its rent went back
    // to the player who funded it.
    assert_eq!(env.balance(&cranker.pubkey()), cranker_before + 10_000 - 5_000);
    assert!(env.svm.get_account(&crank).is_none_or(|account| account.lamports == 0));
    let (prize_a, prize_b) = match outcome {
        1 => (2 * STAKE, 0),
        2 => (0, 2 * STAKE),
        _ => (STAKE, STAKE),
    };
    // The payout goes back into the pots' budgets; player B's wallet only gets the crank's rent.
    assert_eq!(env.balance(&second.pubkey()), second_before_settle + crank_lamports - 10_000);
    assert_eq!(pot_state(&env, &pot_a), (prize_a, 0, false, 0));
    assert_eq!(pot_state(&env, &pot_b), (prize_b, 0, false, 0));
    // A spent crank cannot settle again.
    send_expect_err(&mut env.svm, &cranker, &settled);

    let third = Keypair::new();
    let fourth = Keypair::new();
    env.fund(&third);
    env.fund(&fourth);
    let hold_a = env.army(&third, 0, 1, AshbornKind::Guard.id(), hold);
    let hold_b = env.army(&fourth, 0, 1, AshbornKind::Guard.id(), hold);
    queue(&mut env, &third, hold_a, hold);
    let fourth_before = env.balance(&fourth.pubkey());
    // Lamports sent to the next battle's crank address ahead of time do not block its settlement.
    let draw = battle_pda(&env, 0, 1);
    env.svm.airdrop(&crank_keys(&env, &draw).1, 1_000_000).unwrap();
    lock_match(&mut env, &fourth, hold_b, hold, hold_a, &third);
    assert_eq!(env.svm.get_account(&draw).unwrap().data[2141], 3);
    // A draw refunds each stake into its pot. The locker's wallet paid the pot, the battle rent
    // and the cranker reward.
    assert_eq!(pot_state(&env, &pot_pda(&env, 0, &third.pubkey())), (STAKE, 0, false, 0));
    assert_eq!(pot_state(&env, &pot_pda(&env, 0, &fourth.pubkey())), (STAKE, 0, false, 0));
    assert!(env.balance(&fourth.pubkey()) + STAKE < fourth_before);
}

#[test]
fn a_player_does_not_match_their_own_army_or_another_battleground() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    let first = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let second = env.army(&player, 0, 1, AshbornKind::Guard.id(), hold);
    queue(&mut env, &player, first, hold);
    queue(&mut env, &player, second, hold);
    assert_eq!(env.svm.get_account(&first).unwrap().data[1358], 1);
    assert_eq!(env.svm.get_account(&second).unwrap().data[1358], 1);

    let other = Keypair::new();
    env.fund(&other);
    let elsewhere = env.army(&other, 1, 0, AshbornKind::Guard.id(), hold);
    queue(&mut env, &other, elsewhere, hold);
    assert_eq!(env.svm.get_account(&elsewhere).unwrap().data[1358], 1);
}

#[test]
fn one_pot_backs_many_armies_until_it_runs_dry() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let owner = Keypair::new();
    env.fund(&owner);
    // Three queued armies, one pot that covers two stakes.
    fund_pot(&mut env, &owner, 0, 2 * STAKE);
    let armies: Vec<Address> = (0..3).map(|index| env.army(&owner, 0, index, AshbornKind::Guard.id(), hold)).collect();
    for &army in &armies {
        queue(&mut env, &owner, army, hold);
    }
    assert_eq!(ground_queue_len(&env, &ground), 3);
    let pot = pot_pda(&env, 0, &owner.pubkey());
    assert_eq!(pot_state(&env, &pot), (2 * STAKE, 0, false, 0));

    // Two lockers each meet one of the owner's armies; both stakes come from the one pot.
    let mut met = Vec::new();
    for index in 0..2u8 {
        let locker = Keypair::new();
        env.fund(&locker);
        let army = env.army(&locker, 0, 0, AshbornKind::Guard.id(), hold);
        let queued = queued_armies(&env, &ground);
        let battle = battle_pda(&env, 0, ground_seq(&env, &ground));
        cover_stake(&mut env, &locker, &ground);
        let mut rest: Vec<AccountMeta> = queued.iter().map(|&key| meta(key, true, false)).collect();
        rest.push(meta(pot, true, false));
        rest.push(meta(crank_keys(&env, &battle).0, true, false));
        let lock = lock_ix(&env, &locker, ground, army, battle, &[hold], rest);
        let logs = send(&mut env.svm, &locker, &[cu_limit(), lock]);
        assert!(logs.iter().any(|line| line.contains("HZ_MATCH_OPEN")), "locker {index} matched");
        let data = env.svm.get_account(&battle).unwrap().data;
        let opponent = Address::try_from(&data[40..72]).unwrap();
        assert!(armies.contains(&opponent) && !met.contains(&opponent));
        met.push(opponent);
        assert_eq!(pot_state(&env, &pot), ((1 - index as u64) * STAKE, 0, false, index as u16 + 1));
    }

    // The pot is empty: the third army stays queued but no locker can meet it, so the next
    // locker queues instead. The owner cannot lock another army either.
    let locker = Keypair::new();
    env.fund(&locker);
    let army = env.army(&locker, 0, 0, AshbornKind::Guard.id(), hold);
    cover_stake(&mut env, &locker, &ground);
    let mut rest: Vec<AccountMeta> = queued_armies(&env, &ground).iter().map(|&key| meta(key, true, false)).collect();
    rest.push(meta(pot, true, false));
    let lock = lock_ix(&env, &locker, ground, army, Address::new_unique(), &[hold], rest);
    let logs = send(&mut env.svm, &locker, &[cu_limit(), lock]);
    assert!(logs.iter().any(|line| line.contains("HZ_QUEUED")));
    assert_eq!(ground_queue_len(&env, &ground), 2);
    let spare = env.army(&owner, 0, 3, AshbornKind::Guard.id(), hold);
    let lock = lock_ix(&env, &owner, ground, spare, Address::new_unique(), &[hold], vec![]);
    send_expect_reason(&mut env.svm, &owner, &[cu_limit(), lock], "PotTooLow");
}

#[test]
fn segregated_payouts_stay_out_of_the_budget_and_withdraw_first() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let first = Keypair::new();
    let second = Keypair::new();
    env.fund(&first);
    env.fund(&second);
    let army_a = env.army(&first, 0, 0, AshbornKind::Guard.id(), hold);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), hold);
    fund_pot(&mut env, &first, 0, 3 * STAKE);
    let pot = pot_pda(&env, 0, &first.pubkey());
    let stranger = Keypair::new();
    env.fund(&stranger);
    let mut seized = pot_ix(&env, &first, 0, "set_segregation", &[1]);
    seized.accounts[0] = meta(stranger.pubkey(), true, true);
    send_expect_reason(&mut env.svm, &stranger, &[seized], "NotOwner");
    let call = [pot_ix(&env, &first, 0, "set_segregation", &[1])];
    let logs = send(&mut env.svm, &first, &call);
    assert!(logs.iter().any(|line| line.contains("HZ_POT")));

    // Two idle armies draw: the stake comes back as winnings, not budget.
    queue(&mut env, &first, army_a, hold);
    lock_match(&mut env, &second, army_b, hold, army_a, &first);
    assert_eq!(pot_state(&env, &pot), (2 * STAKE, STAKE, true, 0));
    assert_eq!(pot_state(&env, &pot_pda(&env, 0, &second.pubkey())), (STAKE, 0, false, 0));

    // Withdrawals drain the winnings first, then the budget, and never more than both.
    let before = env.balance(&first.pubkey());
    let call = [pot_ix(&env, &first, 0, "withdraw_pot", &(STAKE + 1).to_le_bytes())];
    send(&mut env.svm, &first, &call);
    assert_eq!(pot_state(&env, &pot), (2 * STAKE - 1, 0, true, 0));
    assert_eq!(env.balance(&first.pubkey()), before + STAKE + 1 - 5_000);
    let call = [pot_ix(&env, &first, 0, "withdraw_pot", &(2 * STAKE).to_le_bytes())];
    send_expect_reason(&mut env.svm, &first, &call, "PotShort");

    // Closing returns the rest, rent included.
    let held = env.balance(&pot);
    let before = env.balance(&first.pubkey());
    let call = [pot_ix(&env, &first, 0, "close_pot", &[])];
    send(&mut env.svm, &first, &call);
    assert_eq!(env.balance(&pot), 0);
    assert_eq!(env.balance(&first.pubkey()), before + held - 5_000);
}

/// The armies in the battleground queue, in queue order.
fn queued_armies(env: &Env, ground: &Address) -> Vec<Address> {
    let data = env.svm.get_account(ground).unwrap().data;
    (0..data[54] as usize).map(|at| Address::try_from(&data[55 + 32 * at..87 + 32 * at]).unwrap()).collect()
}

/// Compute the program spent in its last top-level or callback run, from its own "consumed" line.
fn program_cost(env: &Env, logs: &[String]) -> u64 {
    let program = format!("Program {} consumed ", env.program);
    logs.iter().filter_map(|line| line.strip_prefix(&program)).filter_map(|rest| rest.split(' ').next()?.parse().ok()).next_back().expect("the program ran")
}

#[test]
fn full_armies_resolve_on_every_battleground() {
    // Approach, then cast and attack: every unit spends its point each round where it can.
    let cast_and_strike = BehaviorBody::parse(&[1, 1, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    let rosters: [(u8, &[Placement]); 3] = [
        (0, &[(AshbornKind::Skirmisher, 2, 1), (AshbornKind::Skirmisher, 5, 1), (AshbornKind::Guard, 3, 0), (AshbornKind::Guard, 4, 0)]),
        (1, &[(AshbornKind::Vanguard, 3, 1), (AshbornKind::Archer, 5, 0), (AshbornKind::Archer, 6, 0), (AshbornKind::Skirmisher, 4, 1), (AshbornKind::Guard, 7, 1)]),
        (
            2,
            &[
                (AshbornKind::Vanguard, 2, 1),
                (AshbornKind::Vanguard, 9, 1),
                (AshbornKind::Archer, 4, 0),
                (AshbornKind::Archer, 7, 0),
                (AshbornKind::Skirmisher, 5, 1),
                (AshbornKind::Skirmisher, 6, 1),
                (AshbornKind::Warden, 6, 0),
                (AshbornKind::Guard, 3, 1),
                (AshbornKind::Guard, 7, 1),
                (AshbornKind::Guard, 8, 1),
            ],
        ),
    ];
    for (ground_id, units) in rosters {
        let mut env = setup();
        let behavior = env.behavior(&cast_and_strike.canonical_bytes());
        let first = Keypair::new();
        let second = Keypair::new();
        env.fund(&first);
        env.fund(&second);
        let army_a = env.squad(&first, ground_id, 0, units, behavior);
        let army_b = env.squad(&second, ground_id, 0, units, behavior);
        queue(&mut env, &first, army_a, behavior);
        let logs = lock_match_on(&mut env, ground_id, &second, army_b, behavior, army_a, &first);
        println!("ground {ground_id}: settle_match consumed {} CU", program_cost(&env, &logs));
        assert_eq!(env.svm.get_account(&battle_pda(&env, ground_id, 0)).unwrap().data[2108], 1);
    }
}

/// Compute benchmark: `settle_match` on a fixed, seeded set of battles. Each battleground gets
/// `BENCH_BATTLES` pairs of random budget-legal armies, each army on one random standard behavior,
/// with a random VRF seed. Run with
/// `cargo test -p horizon-litesvm-tests cu_benchmark -- --ignored --nocapture`
/// after building the program with `--features inline-mock-vrf`. Results go to stdout and to
/// `target/cu-bench.json`, with each battle's winner and rounds so an optimization can be checked
/// to leave every outcome unchanged.
#[test]
#[ignore]
fn cu_benchmark() {
    const BENCH_BATTLES: usize = 8;
    let standards = [
        behavior_march(),
        behavior_charge(),
        behavior_kite(),
        behavior_flank_left(),
        behavior_flank_right(),
        behavior_march_cast(),
        behavior_charge_cast(),
        behavior_kite_cast(),
        behavior_flank_left_cast(),
        behavior_flank_right_cast(),
    ];
    let grounds = [(0u8, 8u8, 8u16), (1, 10, 16), (2, 12, 32)];
    let mut state = 0x2545_f491_4f6c_dd1du64;
    let mut next = move |bound: usize| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state % bound as u64) as usize
    };
    let mut rows = Vec::new();
    let mut totals = Vec::new();
    // Per phase: compute units and probe calls, from a `--features cu-profile` build.
    let mut phases = [(0u64, 0u64); 10];
    for (ground_id, cols, budget) in grounds {
        let mut total = 0u64;
        let mut worst = 0u64;
        for battle in 0..BENCH_BATTLES {
            let army = |next: &mut dyn FnMut(usize) -> usize| {
                let mut tiles: Vec<(u8, u8)> = (0..2).flat_map(|row| (0..cols).map(move |col| (col, row))).collect();
                let mut units: Vec<Placement> = Vec::new();
                let mut cost = 0u16;
                while units.len() < MAX_UNITS {
                    let affordable: Vec<AshbornKind> =
                        AshbornKind::ALL.iter().copied().filter(|kind| cost + stats_for(Race::Ashborn.id(), kind.id()).unwrap().cost <= budget).collect();
                    if affordable.is_empty() {
                        break;
                    }
                    let kind = affordable[next(affordable.len())];
                    let (col, row) = tiles.swap_remove(next(tiles.len()));
                    units.push((kind, col, row));
                    cost += stats_for(Race::Ashborn.id(), kind.id()).unwrap().cost;
                }
                (units, standards[next(standards.len())])
            };
            let (units_a, body_a) = army(&mut next);
            let (units_b, body_b) = army(&mut next);
            let mut seed = [0u8; 32];
            seed.iter_mut().for_each(|byte| *byte = next(256) as u8);

            let mut env = setup_on(bench_vm());
            let behavior_a = env.behavior(&body_a.canonical_bytes());
            let behavior_b = if body_b == body_a { behavior_a } else { env.behavior(&body_b.canonical_bytes()) };
            let first = Keypair::new();
            let second = Keypair::new();
            env.fund(&first);
            env.fund(&second);
            let army_a = env.squad(&first, ground_id, 0, &units_a, behavior_a);
            let army_b = env.squad(&second, ground_id, 0, &units_b, behavior_b);
            queue(&mut env, &first, army_a, behavior_a);
            let logs = lock_match_seeded(&mut env, ground_id, &second, army_b, behavior_b, army_a, &first, Some(seed));
            let cost = program_cost(&env, &logs);
            for line in &logs {
                let Some(rest) = line.strip_prefix("Program log: ") else { continue };
                let fields: Vec<u64> = rest.split(", ").filter_map(|field| u64::from_str_radix(field.trim_start_matches("0x"), 16).ok()).collect();
                if fields.len() == 5 && fields[0] == 0xC0FFEE {
                    phases[fields[1] as usize].0 += fields[2];
                    phases[fields[1] as usize].1 += fields[3];
                }
            }

            // The same battle off-chain, for the outcome fingerprint.
            let snapshot = |units: &[Placement], body: BehaviorBody| -> Vec<SnapshotUnit> {
                units.iter().map(|&(kind, col, row)| SnapshotUnit::catalog(Race::Ashborn.id(), kind.id(), body, col, row).unwrap()).collect()
            };
            let rows_count = match ground_id {
                0 => 6,
                1 => 8,
                _ => 10,
            };
            let (winner, events) = simulate(&snapshot(&units_a, body_a), &snapshot(&units_b, body_b), seed, Geometry { cols: cols as i32, rows: rows_count });
            let rounds = events.iter().filter(|event| matches!(event, horizon_combat::TraceEvent::Round)).count();
            let data = &env.svm.get_account(&battle_pda(&env, ground_id, 0)).unwrap().data;
            let stored = match winner {
                Some(Side::A) => 1,
                Some(Side::B) => 2,
                None => 3,
            };
            assert_eq!(data[2141], stored, "on-chain outcome matches the host simulation");
            total += cost;
            worst = worst.max(cost);
            rows.push(format!(
                "{{\"ground\":{ground_id},\"battle\":{battle},\"units\":[{},{}],\"cu\":{cost},\"rounds\":{rounds},\"outcome\":{stored}}}",
                units_a.len(),
                units_b.len()
            ));
        }
        println!("ground {ground_id}: mean {} CU, max {worst} CU over {BENCH_BATTLES} battles", total / BENCH_BATTLES as u64);
        totals.push(total);
    }
    let all: u64 = totals.iter().sum();
    println!("total {all} CU");
    if phases.iter().any(|&(units, _)| units > 0) {
        // Each probe costs about 100 CU of its own (one syscall), so subtract that per call.
        let names = ["rubble", "setup", "move", "  move target", "  move path", "actions", "  action target", "expire", "    path wave step", "program pre-sim"];
        for (name, (units, calls)) in names.iter().zip(phases) {
            let net = units.saturating_sub(calls * 100);
            println!("phase {name:16} {:>9} CU net {:>5.1}% of total, {calls} calls, {} CU per call", net, 100.0 * net as f64 / all as f64, net / calls.max(1));
        }
    }
    let json = format!("{{\"total\":{all},\"battles\":[{}]}}", rows.join(","));
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/cu-bench.json"), json).unwrap();
}

/// The mock VRF's fulfillment: it calls `seed_match` with `seed` as the randomness.
fn mock_fulfill(env: &Env, battle: &Address, payer: &Address, seed: &[u8; 32]) -> Instruction {
    let (fund, crank) = crank_keys(env, battle);
    let system = address!("11111111111111111111111111111111");
    let mut body = Vec::new();
    body.extend_from_slice(seed);
    body.extend_from_slice(env.program.as_ref());
    body.extend_from_slice(&8u32.to_le_bytes());
    body.extend_from_slice(&sighash("seed_match"));
    let metas = [(*battle, true), (fund, true), (crank, true), (env.hydra, false), (system, false)];
    body.extend_from_slice(&(metas.len() as u32).to_le_bytes());
    for (key, writable) in metas {
        body.extend_from_slice(key.as_ref());
        body.push(0);
        body.push(writable as u8);
    }
    body.extend_from_slice(&0u32.to_le_bytes());
    let mut data = vec![12, 0, 0, 0, 0, 0, 0, 0];
    data.extend_from_slice(&body);
    let mut accounts = vec![
        meta(*payer, true, true),
        meta(pda(&[b"identity"], &env.program).0, false, false),
        meta(env.queue, true, false),
        meta(system, false, false),
        meta(address!("SysvarS1otHashes111111111111111111111111111"), false, false),
        meta(env.program, false, false),
        meta(scoped(env), false, false),
    ];
    accounts.extend(metas.iter().map(|&(key, writable)| meta(key, writable, false)));
    ix(env.vrf, accounts, data)
}

/// The battle's crank vault and crank.
fn crank_keys(env: &Env, battle: &Address) -> (Address, Address) {
    let fund = pda(&[b"crank-fund", battle.as_ref()], &env.program).0;
    let crank = pda(&[b"crank", fund.as_ref(), battle.as_ref()], &env.hydra).0;
    (fund, crank)
}

/// The instructions a crank schedules, read back from its account as a cranker does.
fn scheduled(data: &[u8]) -> Vec<Instruction> {
    let mut out = Vec::new();
    let mut at = 120;
    while at < data.len() {
        let count = u16::from_le_bytes([data[at], data[at + 1]]) as usize;
        let metas = &data[at + 2..at + 2 + 33 * count];
        let program_at = at + 2 + 33 * count;
        let program = Address::try_from(&data[program_at..program_at + 32]).unwrap();
        let len = u16::from_le_bytes([data[program_at + 32], data[program_at + 33]]) as usize;
        let body = data[program_at + 34..program_at + 34 + len].to_vec();
        let accounts = metas.chunks(33).map(|chunk| meta(Address::try_from(&chunk[1..]).unwrap(), chunk[0] & 2 != 0, false)).collect();
        out.push(ix(program, accounts, body));
        at = program_at + 34 + len;
    }
    out
}

/// Hydra `Create` for a one-shot crank under `payer` that runs `scheduled`, with no authority.
fn hydra_create(env: &Env, payer: &Keypair, seed: [u8; 32], scheduled: &Instruction) -> Instruction {
    let mut data = vec![0];
    data.extend_from_slice(&seed);
    data.extend_from_slice(&[0; 32]);
    for value in [0u64, 0, 1, 0] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    data.extend_from_slice(&0u32.to_le_bytes());
    data.push(scheduled.accounts.len() as u8);
    data.extend_from_slice(&(scheduled.data.len() as u16).to_le_bytes());
    data.extend_from_slice(scheduled.program_id.as_ref());
    for account in &scheduled.accounts {
        data.push(if account.is_writable { 2 } else { 0 });
        data.extend_from_slice(account.pubkey.as_ref());
    }
    data.extend_from_slice(&scheduled.data);
    let crank = pda(&[b"crank", payer.pubkey().as_ref(), &seed], &env.hydra).0;
    ix(env.hydra, vec![meta(payer.pubkey(), true, true), meta(crank, true, false), meta(address!("11111111111111111111111111111111"), false, false)], data)
}

fn trigger(env: &Env, crank: &Address, cranker: &Address) -> Instruction {
    ix(env.hydra, vec![meta(*crank, true, false), meta(*cranker, true, true), meta(address!("Sysvar1nstructions1111111111111111111111111"), false, false)], vec![1])
}

/// What an off-chain cranker does with the battle's crank: `Trigger`, then the scheduled settlement,
/// with a compute limit first. Returns the logs.
fn crank_battle(env: &mut Env, battle: &Address) -> Vec<String> {
    let (_, crank) = crank_keys(env, battle);
    let data = env.svm.get_account(&crank).expect("the callback created the crank").data;
    let cranker = Keypair::new();
    env.fund(&cranker);
    let mut ixs = vec![cu_limit(), trigger(env, &crank, &cranker.pubkey())];
    ixs.extend(scheduled(&data));
    send(&mut env.svm, &cranker, &ixs)
}

fn scoped(env: &Env) -> Address {
    pda(&[b"identity", env.program.as_ref()], &env.vrf).0
}

fn battle_pda(env: &Env, ground_id: u8, seq: u64) -> Address {
    let (ground, _) = pda(&[b"battleground", &[ground_id]], &env.program);
    pda(&[b"match", ground.as_ref(), &seq.to_le_bytes()], &env.program).0
}

/// Queues `army`, first funding its owner's pot with one stake when it holds less.
fn queue(env: &mut Env, player: &Keypair, army: Address, behavior: Address) {
    let stored: [u8; 32] = env.svm.get_account(&army).unwrap().data[40..72].try_into().unwrap();
    let ground = Address::from(stored);
    cover_stake(env, player, &ground);
    let lock = lock_ix(env, player, ground, army, Address::new_unique(), &[behavior], vec![]);
    send(&mut env.svm, player, &[cu_limit(), lock]);
}

/// `lock_army`: the fixed accounts, then the army's behaviors, then `rest`.
fn lock_ix(env: &Env, player: &Keypair, ground: Address, army: Address, battle: Address, behaviors: &[Address], rest: Vec<AccountMeta>) -> Instruction {
    let mut accounts = vec![
        meta(player.pubkey(), true, true),
        meta(ground, true, false),
        meta(army, true, false),
        meta(pda(&[b"pot", ground.as_ref(), player.pubkey().as_ref()], &env.program).0, true, false),
        meta(battle, true, false),
        meta(env.queue, true, false),
        meta(pda(&[b"identity"], &env.program).0, false, false),
        meta(env.vrf, false, false),
        meta(address!("SysvarS1otHashes111111111111111111111111111"), false, false),
        meta(address!("11111111111111111111111111111111"), false, false),
    ];
    accounts.extend(behaviors.iter().map(|&key| meta(key, false, false)));
    accounts.extend(rest);
    ix(env.program, accounts, disc("lock_army", &[]))
}

fn unlock_ix(env: &Env, player: &Keypair, ground: Address, army: Address) -> Instruction {
    ix(env.program, vec![meta(player.pubkey(), true, true), meta(ground, true, false), meta(army, true, false)], disc("unlock_army", &[]))
}

fn pot_pda(env: &Env, ground_id: u8, owner: &Address) -> Address {
    let (ground, _) = pda(&[b"battleground", &[ground_id]], &env.program);
    pda(&[b"pot", ground.as_ref(), owner.as_ref()], &env.program).0
}

fn fund_pot(env: &mut Env, owner: &Keypair, ground_id: u8, amount: u64) {
    let (ground, _) = pda(&[b"battleground", &[ground_id]], &env.program);
    let pot = pot_pda(env, ground_id, &owner.pubkey());
    let accounts = vec![meta(owner.pubkey(), true, true), meta(ground, false, false), meta(pot, true, false), meta(address!("11111111111111111111111111111111"), false, false)];
    send(&mut env.svm, owner, &[ix(env.program, accounts, disc("fund_pot", &amount.to_le_bytes()))]);
}

/// `withdraw_pot`, `set_segregation` and `close_pot` share the owner-and-pot account list.
fn pot_ix(env: &Env, owner: &Keypair, ground_id: u8, name: &str, args: &[u8]) -> Instruction {
    let pot = pot_pda(env, ground_id, &owner.pubkey());
    ix(env.program, vec![meta(owner.pubkey(), true, true), meta(pot, true, false)], disc(name, args))
}

/// Budget, winnings, segregation and fighting count.
fn pot_state(env: &Env, pot: &Address) -> (u64, u64, bool, u16) {
    let data = env.svm.get_account(pot).unwrap().data;
    assert_eq!(data.len(), 92);
    (
        u64::from_le_bytes(data[72..80].try_into().unwrap()),
        u64::from_le_bytes(data[80..88].try_into().unwrap()),
        data[88] != 0,
        u16::from_le_bytes(data[89..91].try_into().unwrap()),
    )
}

/// Tops the owner's pot up to one stake of `ground`.
fn cover_stake(env: &mut Env, owner: &Keypair, ground: &Address) {
    let data = env.svm.get_account(ground).unwrap().data;
    let id = data[40];
    let stake = u64::from_le_bytes(data[43..51].try_into().unwrap());
    let pot = pot_pda(env, id, &owner.pubkey());
    let budget = env.svm.get_account(&pot).map_or(0, |_| pot_state(env, &pot).0);
    if budget < stake {
        fund_pot(env, owner, id, stake - budget);
    }
}

fn ground_queue_len(env: &Env, ground: &Address) -> u8 {
    env.svm.get_account(ground).unwrap().data[54]
}

fn lock_match(env: &mut Env, player: &Keypair, army: Address, behavior: Address, opponent: Address, opponent_owner: &Keypair) -> Vec<String> {
    lock_match_on(env, 0, player, army, behavior, opponent, opponent_owner)
}

/// Locks into a queued opponent and fulfills the VRF in the same transaction, then cranks the
/// settlement. Returns the settlement's logs.
fn lock_match_on(env: &mut Env, ground_id: u8, player: &Keypair, army: Address, behavior: Address, opponent: Address, opponent_owner: &Keypair) -> Vec<String> {
    lock_match_seeded(env, ground_id, player, army, behavior, opponent, opponent_owner, None)
}

/// As [`lock_match_on`], with the VRF randomness given instead of `SHA-256(battle)`.
#[allow(clippy::too_many_arguments)]
fn lock_match_seeded(
    env: &mut Env,
    ground_id: u8,
    player: &Keypair,
    army: Address,
    behavior: Address,
    opponent: Address,
    opponent_owner: &Keypair,
    seed: Option<[u8; 32]>,
) -> Vec<String> {
    let (battle, _) = lock_and_seed(env, ground_id, player, army, behavior, opponent, opponent_owner, seed);
    crank_battle(env, &battle)
}

/// Locks into a queued opponent and fulfills the VRF in the same transaction, leaving the battle
/// seeded with its crank scheduled. Returns the battle and the logs.
#[allow(clippy::too_many_arguments)]
fn lock_and_seed(
    env: &mut Env,
    ground_id: u8,
    player: &Keypair,
    army: Address,
    behavior: Address,
    opponent: Address,
    opponent_owner: &Keypair,
    seed: Option<[u8; 32]>,
) -> (Address, Vec<String>) {
    let (ground, _) = pda(&[b"battleground", &[ground_id]], &env.program);
    cover_stake(env, player, &ground);
    let battle = battle_pda(env, ground_id, ground_seq(env, &ground));
    let scoped_key = scoped(env);
    for key in [scoped_key, pda(&[b"identity"], &env.program).0] {
        if env.svm.get_account(&key).is_none() {
            env.svm.set_account(key, Account { lamports: 1_000_000, data: vec![], owner: address!("11111111111111111111111111111111"), executable: false, rent_epoch: 0 }).unwrap();
        }
    }
    let seed = seed.unwrap_or_else(|| sha256(battle.as_ref()));
    let (fund, _) = crank_keys(env, &battle);
    let fulfill = mock_fulfill(env, &battle, &player.pubkey(), &seed);
    let opponent_pot = pot_pda(env, ground_id, &opponent_owner.pubkey());
    let lock = lock_ix(env, player, ground, army, battle, &[behavior], vec![meta(opponent, true, false), meta(opponent_pot, true, false), meta(fund, true, false)]);
    let logs = send(&mut env.svm, player, &[cu_limit(), lock, fulfill]);
    (battle, logs)
}

fn ground_seq(env: &Env, ground: &Address) -> u64 {
    let data = &env.svm.get_account(ground).unwrap().data;
    // disc, admin, id, budget, stake, cols, rows, zone_depth, queue_len, queue, then match_seq
    let offset = 8 + 32 + 1 + 2 + 8 + 1 + 1 + 1 + 1 + 32 * 16;
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[test]
fn a_rootborn_army_stores_its_own_catalog_rows() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let create = |index: u32, race: u8, kinds: &[u8]| {
        let index_bytes = index.to_le_bytes();
        let (army, _) = pda(&[b"army", player.pubkey().as_ref(), &index_bytes], &env.program);
        let mut rest = index_bytes.to_vec();
        rest.push(race);
        rest.extend_from_slice(&(kinds.len() as u32).to_le_bytes());
        for (col, &kind) in kinds.iter().enumerate() {
            rest.push(kind);
            rest.extend_from_slice(hold.as_ref());
            rest.push(col as u8);
            rest.push(0);
        }
        let mut accounts =
            vec![meta(player.pubkey(), true, true), meta(ground, false, false), meta(army, true, false), meta(address!("11111111111111111111111111111111"), false, false)];
        accounts.extend(kinds.iter().map(|_| meta(hold, false, false)));
        (army, ix(env.program, accounts, disc("create_army", &rest)))
    };

    // Kind 3 exists for Ashborn but not for Rootborn, and race 3 is not in the catalog.
    let (_, bad_kind) = create(0, Race::Rootborn.id(), &[3]);
    send_expect_reason(&mut env.svm, &player, &[bad_kind], "BadUnit");
    let (_, bad_race) = create(0, 3, &[0]);
    send_expect_reason(&mut env.svm, &player, &[bad_race], "BadRace");
    // Two Thornlings fill Outpost's budget of 8.
    let (_, over) = create(0, Race::Rootborn.id(), &[RootbornKind::Thornling.id(), RootbornKind::Thornling.id(), RootbornKind::Thornling.id()]);
    send_expect_err(&mut env.svm, &player, &[over]);

    let (army, ok) = create(0, Race::Rootborn.id(), &[RootbornKind::Thornling.id(), RootbornKind::Thornling.id()]);
    send(&mut env.svm, &player, &[ok]);
    let stored = &env.svm.get_account(&army).unwrap().data;
    assert_eq!(stored[72], Race::Rootborn.id());
    let stats = stats_for(Race::Rootborn.id(), RootbornKind::Thornling.id()).unwrap();
    assert_eq!(u16::from_le_bytes(stored[78 + 113..78 + 115].try_into().unwrap()), stats.cost);
    assert_eq!(stored[78 + 115], stats.hp as u8);

    // Deeplings are race 2: a Clawling and a Spineshot (cost 7) fit Outpost.
    let (deep, ok) = create(1, Race::Deeplings.id(), &[DeeplingsKind::Clawling.id(), DeeplingsKind::Spineshot.id()]);
    send(&mut env.svm, &player, &[ok]);
    let stored = &env.svm.get_account(&deep).unwrap().data;
    assert_eq!(stored[72], Race::Deeplings.id());
    assert_eq!(stored[78 + 119], stats_for(Race::Deeplings.id(), DeeplingsKind::Clawling.id()).unwrap().cast.damage);
}
