use horizon_combat::{
    army_cost, behavior_charge, behavior_charge_cast, behavior_flank_left, behavior_flank_left_cast, behavior_flank_right, behavior_flank_right_cast, behavior_hash, behavior_kite,
    behavior_kite_cast, behavior_march, behavior_march_cast, simulate, stats_for, AshbornKind, BehaviorBody, DeeplingsKind, Geometry, Race, RootbornKind, Side, SnapshotUnit, MAX_UNITS,
};
use horizon_litesvm_tests::{sha256, sighash, PROGRAM_ID, VRF_ID};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::{address, Address};
use solana_clock::Clock;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const STAKE: u64 = 10_000_000;
/// What a won battle at `STAKE` and the default 500 bps fee moves (`fees::win_payout`): the fee to
/// Config, the loser's lamports to the winner, and what the winner's budget or winnings grows by.
const FEE: u64 = 1_000_000;
const TO_WINNER: u64 = 9_000_000;
const CREDIT: u64 = 19_000_000;

/// One army unit: its kind and its zone-local column and row.
type Placement = (AshbornKind, u8, u8);
const BUDGET: u16 = 8;

/// The rollup's ephemeral rent vault and magic program. The mock build checks neither.
const VAULT: Address = address!("MagicVau1t999999999999999999999999999999999");
const MAGIC: Address = address!("Magic11111111111111111111111111111111111111");
const SYSTEM: Address = address!("11111111111111111111111111111111");
/// The local rollup validator's identity, which `initialize` pins in Config.
const VALIDATOR: Address = address!("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
/// Owns a delegated account's Solana copy.
const DELEGATION: Address = address!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
/// What a helper deposits when it registers a wallet that has no Player yet.
const DEPOSIT: u64 = 200_000_000;
/// Free lamports `cover_stake` leaves on a Player for a battle's rent.
const BATTLE_ROOM: u64 = 20_000_000;
const PLAYER_LEN: usize = 68;
const BATTLE_LEN: usize = 2155;

struct Env {
    svm: LiteSVM,
    program: Address,
    vrf: Address,
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

/// The fixture on a given VM, for example one with the profiler's syscall enabled. The admin is
/// registered, so its Player sponsors the behaviors `Env::behavior` creates.
fn setup_on(svm: LiteSVM) -> Env {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let horizon = root.join("target/deploy/horizon_zero.so");
    let mock = root.join("target/deploy/mock_vrf.so");
    assert!(horizon.exists(), "missing {horizon:?}; run cargo build-sbf for horizon-zero --features inline-mock-vrf,inline-mock-magic");
    assert!(mock.exists(), "missing {mock:?}; run cargo build-sbf for mock-vrf");

    let mut svm = svm;
    let program: Address = PROGRAM_ID.parse().unwrap();
    let vrf: Address = VRF_ID.parse().unwrap();
    svm.add_program(program, &std::fs::read(&horizon).unwrap()).unwrap();
    svm.add_program(vrf, &std::fs::read(&mock).unwrap()).unwrap();

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 20_000_000_000).unwrap();
    let queue = Address::new_unique();
    svm.set_account(queue, Account { lamports: 1_000_000_000, data: vec![0; 256], owner: vrf, executable: false, rent_epoch: 0 }).unwrap();

    // `add_program` deploys through the upgradeable loader with no upgrade authority; the admin
    // becomes it, as the deployer would be, so `initialize` accepts the admin.
    set_upgrade_authority(&mut svm, &program, Some(&admin.pubkey()));
    let (config, _) = pda(&[b"config"], &program);
    send(&mut svm, &admin, &[initialize_ix(&program, &admin.pubkey(), &program, VALIDATOR)]);

    let mut env = Env { svm, program, vrf, queue, admin, config };
    env.create_battleground(0, BUDGET, STAKE, 8, 6);
    env.create_battleground(1, 16, 50_000_000, 10, 8);
    env.create_battleground(2, 32, 100_000_000, 12, 10);
    let admin = env.admin.insecure_clone();
    register(&mut env, &admin, 1_000_000_000);
    env
}

/// The upgradeable loader, which owns each program's ProgramData `[program_id]`.
const UPGRADEABLE_LOADER: Address = address!("BPFLoaderUpgradeab1e11111111111111111111111");

fn program_data(program: &Address) -> Address {
    pda(&[program.as_ref()], &UPGRADEABLE_LOADER).0
}

/// Rewrites a deployed program's ProgramData upgrade authority: the metadata is the `u32` state
/// tag 3, the `u64` deploy slot, then an `Option<Pubkey>` (tag byte at 12, key at 13..45).
fn set_upgrade_authority(svm: &mut LiteSVM, program: &Address, authority: Option<&Address>) {
    let key = program_data(program);
    let mut account = svm.get_account(&key).unwrap();
    assert_eq!(u32::from_le_bytes(account.data[0..4].try_into().unwrap()), 3, "ProgramData");
    account.data[12] = authority.is_some() as u8;
    account.data[13..45].copy_from_slice(authority.map(|key| key.as_ref()).unwrap_or(&[0; 32]));
    svm.set_account(key, account).unwrap();
}

/// `initialize(500, validator)` signed by `admin`, with `data_of`'s ProgramData as the program's.
fn initialize_ix(program: &Address, admin: &Address, data_of: &Address, validator: Address) -> Instruction {
    let accounts = vec![
        meta(*admin, true, true),
        meta(pda(&[b"config"], program).0, true, false),
        meta(pda(&[b"identity"], program).0, true, false),
        meta(SYSTEM, false, false),
        meta(*program, false, false),
        meta(program_data(data_of), false, false),
    ];
    ix(*program, accounts, disc("initialize", &[&500u16.to_le_bytes()[..], validator.as_ref()].concat()))
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
                vec![meta(self.admin.pubkey(), true, true), meta(self.config, false, false), meta(ground, true, false), meta(SYSTEM, false, false)],
                disc("create_battleground", &data),
            )],
        );
        let account = self.svm.get_account(&ground).unwrap();
        assert_eq!(account.data.len(), 576);
        assert_eq!(account.data[51], cols);
        assert_eq!(account.data[52], rows);
        assert_eq!(account.data[53], 2);
    }

    /// A behavior the admin's Player sponsors.
    fn behavior(&mut self, body: &[u8]) -> Address {
        let admin = self.admin.insecure_clone();
        self.behavior_by(&admin, body)
    }

    /// A behavior `creator`'s Player sponsors, registering the creator first when needed.
    fn behavior_by(&mut self, creator: &Keypair, body: &[u8]) -> Address {
        ensure_player(self, creator);
        let call = behavior_by_ix(self, creator, body);
        let key = call.accounts[2].pubkey;
        send(&mut self.svm, creator, &[call]);
        key
    }

    fn fund(&mut self, player: &Keypair) {
        self.svm.airdrop(&player.pubkey(), 10_000_000_000).unwrap();
    }

    /// An army of several units that all follow one behavior.
    fn squad(&mut self, owner: &Keypair, ground_id: u8, index: u32, units: &[Placement], behavior: Address) -> Address {
        ensure_player(self, owner);
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
        let mut accounts = army_accounts(self, owner, ground, army);
        accounts.extend(units.iter().map(|_| meta(behavior, false, false)));
        send(&mut self.svm, owner, &[ix(self.program, accounts, disc("create_army", &rest))]);
        army
    }

    fn army(&mut self, owner: &Keypair, ground_id: u8, index: u32, kind: u8, behavior: Address) -> Address {
        ensure_player(self, owner);
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
        let mut accounts = army_accounts(self, owner, ground, army);
        accounts.push(meta(behavior, false, false));
        send(&mut self.svm, owner, &[ix(self.program, accounts, disc("create_army", &rest))]);
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

    fn close_army(&mut self, owner: &Keypair, army: Address) -> Vec<String> {
        let call = close_army_ix(self, owner, army);
        send(&mut self.svm, owner, &[call])
    }

    fn balance(&self, key: &Address) -> u64 {
        self.svm.get_account(key).map(|account| account.lamports).unwrap_or(0)
    }
}

fn player_pda(env: &Env, owner: &Address) -> Address {
    pda(&[b"player", owner.as_ref()], &env.program).0
}

fn outbox_pda(env: &Env, owner: &Address) -> Address {
    pda(&[b"outbox", owner.as_ref()], &env.program).0
}

/// register_player(deposit): creates Player and Outbox and moves `deposit` into the Player.
fn register(env: &mut Env, owner: &Keypair, deposit: u64) {
    let accounts = vec![
        meta(owner.pubkey(), true, true),
        meta(player_pda(env, &owner.pubkey()), true, false),
        meta(outbox_pda(env, &owner.pubkey()), true, false),
        meta(SYSTEM, false, false),
    ];
    send(&mut env.svm, owner, &[ix(env.program, accounts, disc("register_player", &deposit.to_le_bytes()))]);
}

/// Registers `owner` with `DEPOSIT` unless their Player exists.
fn ensure_player(env: &mut Env, owner: &Keypair) {
    if env.svm.get_account(&player_pda(env, &owner.pubkey())).is_none_or(|account| account.data.is_empty()) {
        register(env, owner, DEPOSIT);
    }
}

/// `fund_budget` and `set_segregation` take the owner and their Player.
fn player_ix(env: &Env, owner: &Keypair, name: &str, args: &[u8]) -> Instruction {
    let accounts = vec![meta(owner.pubkey(), true, true), meta(player_pda(env, &owner.pubkey()), true, false)];
    ix(env.program, accounts, disc(name, args))
}

/// (budget, winnings, locked, segregate, fighting), at the offsets in the accounts chapter.
fn player_state(env: &Env, owner: &Address) -> (u64, u64, u64, bool, u16) {
    let data = env.svm.get_account(&player_pda(env, owner)).unwrap().data;
    assert_eq!(data.len(), PLAYER_LEN);
    let u64_at = |at: usize| u64::from_le_bytes(data[at..at + 8].try_into().unwrap());
    (u64_at(40), u64_at(48), u64_at(56), data[64] == 1, u16::from_le_bytes([data[65], data[66]]))
}

/// The Player's lamports that its counters and rent do not claim.
fn player_free(env: &Env, owner: &Address) -> u64 {
    let (budget, winnings, locked, _, _) = player_state(env, owner);
    env.balance(&player_pda(env, owner)) - env.svm.minimum_balance_for_rent_exemption(PLAYER_LEN) - budget - winnings - locked
}

/// A top-up: a plain transfer from the wallet into its Player, where it lands in free lamports.
fn top_up(env: &mut Env, owner: &Keypair, lamports: u64) {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    let call = ix(SYSTEM, vec![meta(owner.pubkey(), true, true), meta(player_pda(env, &owner.pubkey()), true, false)], data);
    send(&mut env.svm, owner, &[call]);
}

/// Config's `fees` field.
fn config_fees(env: &Env) -> u64 {
    u64::from_le_bytes(env.svm.get_account(&env.config).unwrap().data[42..50].try_into().unwrap())
}

/// `create_behavior` for `body` under `hash`, sponsored by the creator's Player.
fn behavior_ix(env: &Env, creator: &Keypair, hash: &[u8; 32], body: &[u8]) -> Instruction {
    let (key, _) = pda(&[b"behavior", hash], &env.program);
    let accounts = vec![
        meta(creator.pubkey(), true, true),
        meta(player_pda(env, &creator.pubkey()), true, false),
        meta(key, true, false),
        meta(VAULT, true, false),
        meta(MAGIC, false, false),
        meta(SYSTEM, false, false),
    ];
    ix(env.program, accounts, disc("create_behavior", &behavior_args(hash, body)))
}

fn behavior_by_ix(env: &Env, creator: &Keypair, body: &[u8]) -> Instruction {
    behavior_ix(env, creator, &behavior_hash(body), body)
}

/// `create_army`'s fixed accounts; the behaviors follow.
fn army_accounts(env: &Env, owner: &Keypair, ground: Address, army: Address) -> Vec<AccountMeta> {
    vec![
        meta(owner.pubkey(), true, true),
        meta(player_pda(env, &owner.pubkey()), true, false),
        meta(ground, false, false),
        meta(army, true, false),
        meta(VAULT, true, false),
        meta(MAGIC, false, false),
        meta(SYSTEM, false, false),
    ]
}

fn close_army_ix(env: &Env, owner: &Keypair, army: Address) -> Instruction {
    let accounts =
        vec![meta(owner.pubkey(), true, true), meta(player_pda(env, &owner.pubkey()), true, false), meta(army, true, false), meta(VAULT, true, false), meta(MAGIC, false, false)];
    ix(env.program, accounts, disc("close_army", &[]))
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
fn initialize_needs_a_validator_identity() {
    let mut env = setup();
    // Config and the identity exist after setup; clear both so `initialize` can run again.
    let identity = pda(&[b"identity"], &env.program).0;
    for key in [env.config, identity] {
        env.svm.set_account(key, Account::default()).unwrap();
    }
    let init = |env: &Env, admin: &Keypair, validator: Address| initialize_ix(&env.program, &admin.pubkey(), &env.program, validator);
    let admin = env.admin.insecure_clone();
    send_expect_reason_with(&mut env, &admin, |env| vec![init(env, &admin, Address::default())], "BadValidator");
    send_with(&mut env, &admin, |env| vec![init(env, &admin, VALIDATOR)]);
    assert_eq!(Address::try_from(&env.svm.get_account(&env.config).unwrap().data[50..82]).unwrap(), VALIDATOR);
}

#[test]
fn only_the_upgrade_authority_initializes_and_a_funded_identity_does_not_block_it() {
    let mut env = setup();
    let identity = pda(&[b"identity"], &env.program).0;
    for key in [env.config, identity] {
        env.svm.set_account(key, Account::default()).unwrap();
    }
    let admin = env.admin.insecure_clone();
    let stranger = Keypair::new();
    env.fund(&stranger);
    // A signer that is not the upgrade authority, with the real ProgramData.
    send_expect_reason_with(&mut env, &stranger, |env| vec![initialize_ix(&env.program, &stranger.pubkey(), &env.program, VALIDATOR)], "NotUpgradeAuthority");
    // Another program's ProgramData whose authority is the stranger: not this program's.
    let vrf = env.vrf;
    set_upgrade_authority(&mut env.svm, &vrf, Some(&stranger.pubkey()));
    send_expect_reason_with(&mut env, &stranger, |env| vec![initialize_ix(&env.program, &stranger.pubkey(), &env.vrf, VALIDATOR)], "NotUpgradeAuthority");
    // A program with no upgrade authority (made immutable) cannot be initialized by anyone.
    let program = env.program;
    set_upgrade_authority(&mut env.svm, &program, None);
    send_expect_reason_with(&mut env, &admin, |env| vec![initialize_ix(&env.program, &admin.pubkey(), &env.program, VALIDATOR)], "NotUpgradeAuthority");
    set_upgrade_authority(&mut env.svm, &program, Some(&admin.pubkey()));
    assert!(env.svm.get_account(&env.config).is_none_or(|account| account.data.is_empty()), "no failed call made a Config");

    // Lamports sent to the identity address beforehand, short of its rent, are topped up.
    env.svm.set_account(identity, Account { lamports: 1_000, data: vec![], owner: SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
    send_with(&mut env, &admin, |env| vec![initialize_ix(&env.program, &admin.pubkey(), &env.program, VALIDATOR)]);
    let stored = env.svm.get_account(&identity).unwrap();
    assert_eq!((stored.owner, stored.data.len(), stored.lamports), (env.program, 0, env.svm.minimum_balance_for_rent_exemption(0)));
    assert_eq!(&env.svm.get_account(&env.config).unwrap().data[8..40], admin.pubkey().as_ref());

    // More than its rent already there: nothing is added.
    for key in [env.config, identity] {
        env.svm.set_account(key, Account::default()).unwrap();
    }
    env.svm.set_account(identity, Account { lamports: 5_000_000, data: vec![], owner: SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
    send_with(&mut env, &admin, |env| vec![initialize_ix(&env.program, &admin.pubkey(), &env.program, VALIDATOR)]);
    assert_eq!(env.balance(&identity), 5_000_000);
    assert_eq!(env.svm.get_account(&identity).unwrap().owner, env.program);
}

#[test]
fn fee_is_capped_and_only_the_admin_sets_it() {
    let mut env = setup();
    let set = |env: &Env, signer: &Keypair, bps: u16| ix(env.program, vec![meta(signer.pubkey(), false, true), meta(env.config, true, false)], disc("set_fee", &bps.to_le_bytes()));
    let data = env.svm.get_account(&env.config).unwrap().data;
    assert_eq!(data.len(), CONFIG_LEN);
    assert_eq!(u16::from_le_bytes([data[40], data[41]]), 500, "initialize stored the fee rate");
    let admin = env.admin.insecure_clone();
    send_expect_reason_with(&mut env, &admin, |env| vec![set(env, &admin, 1_001)], "FeeTooHigh");
    let stranger = Keypair::new();
    env.fund(&stranger);
    send_expect_reason_with(&mut env, &stranger, |env| vec![set(env, &stranger, 100)], "NotAdmin");
    let ixs = vec![set(&env, &admin, 1_000)];
    let logs = send(&mut env.svm, &admin, &ixs);
    assert!(logs.iter().any(|line| line.contains("HZ_FEE 1000")));
    let data = env.svm.get_account(&env.config).unwrap().data;
    assert_eq!(u16::from_le_bytes([data[40], data[41]]), 1_000);
}

#[test]
fn register_then_fund_budget_moves_free_lamports_only() {
    let mut env = setup();
    let owner = Keypair::new();
    env.fund(&owner);
    register(&mut env, &owner, 100_000_000);
    let player = player_pda(&env, &owner.pubkey());
    let held = env.balance(&player);
    assert_eq!(held, env.svm.minimum_balance_for_rent_exemption(PLAYER_LEN) + 100_000_000, "the deposit lands on top of the rent");
    assert_eq!(env.svm.get_account(&outbox_pda(&env, &owner.pubkey())).unwrap().data.len(), 49);
    assert_eq!(player_state(&env, &owner.pubkey()), (0, 0, 0, false, 0));
    let ixs = vec![player_ix(&env, &owner, "fund_budget", &60_000_000u64.to_le_bytes())];
    let logs = send(&mut env.svm, &owner, &ixs);
    assert!(logs.iter().any(|line| line.contains("HZ_PLAYER")));
    assert_eq!(player_state(&env, &owner.pubkey()).0, 60_000_000);
    assert_eq!(env.balance(&player), held, "funding the budget moves no lamports");
    send_expect_reason_with(&mut env, &owner, |env| vec![player_ix(env, &owner, "fund_budget", &50_000_000u64.to_le_bytes())], "BalanceShort");
    // A top-up lands in free lamports, which the budget can then take.
    top_up(&mut env, &owner, 10_000_000);
    let ixs = vec![player_ix(&env, &owner, "fund_budget", &50_000_000u64.to_le_bytes())];
    send(&mut env.svm, &owner, &ixs);
    assert_eq!(player_state(&env, &owner.pubkey()).0, 110_000_000);
}

#[test]
fn army_rent_comes_from_the_player_and_returns_on_close() {
    let mut env = setup();
    let owner = Keypair::new();
    env.fund(&owner);
    register(&mut env, &owner, 100_000_000);
    let player = player_pda(&env, &owner.pubkey());
    let before = env.balance(&player);
    let wallet = env.balance(&owner.pubkey());
    let behavior = env.behavior_by(&owner, &still_body());
    let army = env.army(&owner, 0, 0, AshbornKind::Guard.id(), behavior);
    let behavior_rent = env.balance(&behavior);
    let army_rent = env.balance(&army);
    assert_eq!(env.balance(&player), before - behavior_rent - army_rent, "the player paid the army and behavior rent");
    assert_eq!(env.balance(&owner.pubkey()), wallet - 2 * 5_000, "the wallet paid only the fees");
    let logs = env.close_army(&owner, army);
    assert!(logs.iter().any(|line| line.contains("HZ_ARMY_CLOSE")));
    assert_eq!(env.balance(&player), before - behavior_rent);
}

#[test]
fn rent_cannot_dip_into_the_budget() {
    let mut env = setup();
    let owner = Keypair::new();
    env.fund(&owner);
    let rent = env.svm.minimum_balance_for_rent_exemption(PLAYER_LEN);
    register(&mut env, &owner, 10_000_000);
    let all = env.balance(&player_pda(&env, &owner.pubkey())) - rent;
    let ixs = [player_ix(&env, &owner, "fund_budget", &all.to_le_bytes())];
    send(&mut env.svm, &owner, &ixs);
    send_expect_reason_with(&mut env, &owner, |env| vec![behavior_by_ix(env, &owner, &still_body())], "RentShort");
}

#[test]
fn behavior_pda_rejects_duplicates_and_a_mismatched_hash() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let march = behavior_march().canonical_bytes();
    let hash = behavior_hash(&march);
    let (key, _) = pda(&[b"behavior", &hash], &env.program);
    let create = behavior_by_ix(&env, &admin, &march);
    let logs = send(&mut env.svm, &admin, std::slice::from_ref(&create));
    assert!(logs.iter().any(|line| line.contains("HZ_BEHAVIOR")));
    let stored = env.svm.get_account(&key).unwrap();
    assert_eq!(stored.data.len(), 119);
    assert_eq!(stored.owner, env.program);
    assert_eq!(&stored.data[8..40], admin.pubkey().as_ref());
    send_expect_reason(&mut env.svm, &admin, &[create], "AlreadyExists");

    let charge = behavior_charge().canonical_bytes();
    let mut wrong = [0u8; 32];
    wrong[0] = 1;
    assert_ne!(behavior_hash(&charge), wrong);
    let (bad_key, _) = pda(&[b"behavior", &wrong], &env.program);
    let mismatched = behavior_ix(&env, &admin, &wrong, &charge);
    send_expect_reason(&mut env.svm, &admin, &[mismatched], "HashMismatch");
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
    ensure_player(&mut env, &player);
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
    let mut accounts = army_accounts(&env, &player, ground, army);
    accounts.extend([meta(hold, false, false), meta(hold, false, false), meta(hold, false, false)]);
    send_expect_reason(&mut env.svm, &player, &[ix(env.program, accounts, disc("create_army", &rest))], "BudgetExceeded");

    let bogus = Address::new_unique();
    let mut rest = index.to_vec();
    rest.push(0);
    rest.extend_from_slice(&1u32.to_le_bytes());
    rest.push(AshbornKind::Guard.id());
    rest.extend_from_slice(bogus.as_ref());
    rest.push(0);
    rest.push(0);
    let mut accounts = army_accounts(&env, &player, ground, army);
    accounts.push(meta(bogus, false, false));
    send_expect_err(&mut env.svm, &player, &[ix(env.program, accounts, disc("create_army", &rest))]);
    assert!(env.svm.get_account(&army).is_none_or(|account| account.data.is_empty()), "a failed create leaves no army");

    let army = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let other = Keypair::new();
    env.fund(&other);
    cover_stake(&mut env, &other, &ground);
    let lock = lock_ix(&env, &other, ground, army, Address::new_unique(), &[hold], vec![]);
    send_expect_reason(&mut env.svm, &other, &[cu_limit(), lock], "NotOwner");
}

#[test]
fn positions_must_sit_in_the_zone_and_stay_unique() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    ensure_player(&mut env, &player);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let index = 4u32.to_le_bytes();
    let (army, _) = pda(&[b"army", player.pubkey().as_ref(), &index], &env.program);

    let mut outside = index.to_vec();
    outside.push(0);
    outside.extend_from_slice(&1u32.to_le_bytes());
    outside.push(AshbornKind::Guard.id());
    outside.extend_from_slice(hold.as_ref());
    outside.push(0);
    outside.push(2);
    let call = ix(env.program, [army_accounts(&env, &player, ground, army), vec![meta(hold, false, false)]].concat(), disc("create_army", &outside));
    send_expect_err(&mut env.svm, &player, &[call]);

    let mut shared = index.to_vec();
    shared.push(0);
    shared.extend_from_slice(&2u32.to_le_bytes());
    for _ in 0..2 {
        shared.push(AshbornKind::Guard.id());
        shared.extend_from_slice(hold.as_ref());
        shared.push(1);
        shared.push(0);
    }
    let call = ix(env.program, [army_accounts(&env, &player, ground, army), vec![meta(hold, false, false); 2]].concat(), disc("create_army", &shared));
    send_expect_err(&mut env.svm, &player, &[call]);

    let mut placed = index.to_vec();
    placed.push(0);
    placed.extend_from_slice(&2u32.to_le_bytes());
    for col in 0..2u8 {
        placed.push(AshbornKind::Guard.id());
        placed.extend_from_slice(hold.as_ref());
        placed.push(col);
        placed.push(0);
    }
    let call = ix(env.program, [army_accounts(&env, &player, ground, army), vec![meta(hold, false, false); 2]].concat(), disc("create_army", &placed));
    send(&mut env.svm, &player, &[call]);
    let data = env.svm.get_account(&army).unwrap().data;
    assert_eq!(data[78 + 111], 0);
    assert_eq!(data[78 + 112], 0);
    assert_eq!(data[78 + 128 + 111], 1);
    assert_eq!(data[78 + 128 + 112], 0);
}

#[test]
fn locking_needs_a_budget_that_covers_the_stake_and_unlock_dequeues() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    let army = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let lock = |env: &Env| lock_ix(env, &player, ground, army, Address::new_unique(), &[hold], vec![]);

    // An empty budget, then a budget one lamport short of the stake.
    send_expect_reason_with(&mut env, &player, |env| vec![cu_limit(), lock(env)], "BudgetTooLow");
    let ixs = [player_ix(&env, &player, "fund_budget", &(STAKE - 1).to_le_bytes())];
    send(&mut env.svm, &player, &ixs);
    send_expect_reason_with(&mut env, &player, |env| vec![cu_limit(), lock(env)], "BudgetTooLow");

    let ixs = [player_ix(&env, &player, "fund_budget", &1u64.to_le_bytes())];
    send(&mut env.svm, &player, &ixs);
    let account = player_pda(&env, &player.pubkey());
    let held = env.balance(&account);
    let ixs = [cu_limit(), lock(&env)];
    let logs = send(&mut env.svm, &player, &ixs);
    assert!(logs.iter().any(|line| line.contains("HZ_QUEUED")));
    // Queuing reserves nothing: the stake is locked only when a match opens.
    assert_eq!(env.balance(&account), held);
    assert_eq!(player_state(&env, &player.pubkey()), (STAKE, 0, 0, false, 0));
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
    ensure_player(&mut env, &stranger);
    let army = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);

    let call = [close_army_ix(&env, &stranger, army)];
    send_expect_reason(&mut env.svm, &stranger, &call, "NotOwner");

    queue(&mut env, &player, army, hold);
    let call = [close_army_ix(&env, &player, army)];
    send_expect_reason(&mut env.svm, &player, &call, "BadStatus");

    let call = [unlock_ix(&env, &player, ground, army)];
    send(&mut env.svm, &player, &call);
    let rent = env.balance(&army);
    let sponsor = player_pda(&env, &player.pubkey());
    let before = env.balance(&sponsor);
    let logs = env.close_army(&player, army);
    assert!(logs.iter().any(|line| line.contains("HZ_ARMY_CLOSE")));
    assert_eq!(env.balance(&army), 0);
    assert!(env.svm.get_account(&army).is_none_or(|account| account.data.is_empty()));
    assert_eq!(env.balance(&sponsor), before + rent, "the rent goes back to the Player that paid it");

    // The index is free again: a new army can take the same address.
    let again = env.army(&player, 0, 0, AshbornKind::Archer.id(), hold);
    assert_eq!(again, army);
}

#[test]
fn match_pays_the_simulated_winner_and_a_draw_refunds() {
    let mut env = setup();
    let advance = env.behavior(&behavior_march().canonical_bytes());
    let hold = env.behavior(&still_body());
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let first = Keypair::new();
    let second = Keypair::new();
    env.fund(&first);
    env.fund(&second);
    let army_a = env.army(&first, 0, 0, AshbornKind::Guard.id(), advance);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), advance);
    queue(&mut env, &first, army_a, advance);
    cover_stake(&mut env, &second, &ground);
    let (player_a, player_b) = (player_pda(&env, &first.pubkey()), player_pda(&env, &second.pubkey()));
    let (held_a, held_b, config_held) = (env.balance(&player_a), env.balance(&player_b), env.balance(&env.config));
    let (battle, logs) = lock_and_seed(&mut env, 0, &second, army_b, advance, army_a, &first, None);
    // Locking moves no stake: each Player locks one stake of its budget and counts one unsettled
    // battle, and the locker's Player paid the battle's rent.
    let battle_rent = env.svm.minimum_balance_for_rent_exemption(BATTLE_LEN);
    assert_eq!(player_state(&env, &first.pubkey()), (0, 0, STAKE, false, 1));
    assert_eq!(player_state(&env, &second.pubkey()), (0, 0, STAKE, false, 1));
    assert_eq!(env.balance(&player_a), held_a);
    assert_eq!(env.balance(&player_b), held_b - battle_rent);
    // The oracle gives its callback transaction 300 000 CU; seeding needs a small part of it.
    let seeding = program_cost(&env, &logs);
    println!("seed_match consumed {seeding} CU");
    assert!(seeding < 100_000, "seed_match consumed {seeding} CU");

    // The callback stored the seed; the battle carries the fee rate it opened with.
    let data = env.svm.get_account(&battle).unwrap().data;
    assert_eq!(data.len(), BATTLE_LEN);
    assert_eq!(data[186], 8);
    assert_eq!(data[187], 6);
    assert_eq!(data[2108], 2, "seeded");
    assert_eq!(data[2141], 0, "no outcome yet");
    assert_eq!(u16::from_le_bytes([data[2144], data[2145]]), 500, "fee_bps");
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&data[2109..2141]);
    assert_eq!(&seed, &sha256(battle.as_ref()));
    let replay = mock_fulfill(&env, &battle, &second.pubkey(), &seed);
    send_expect_reason(&mut env.svm, &second, &[cu_limit(), replay], "AlreadyResolved");

    // Anyone settles: `settle` signs with a fresh wallet.
    let logs = settle(&mut env, &battle);
    let (outcome, fee) = resolved(&logs);
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
    // The battle is closed and its rent is back on the locker's Player.
    assert!(env.svm.get_account(&battle).is_none_or(|account| account.lamports == 0));
    // The loser's Player pays the winner's Player and the fee; the winner's budget takes the pot
    // less the fee. A draw moves no lamports and returns each stake to its budget.
    let (paid_a, paid_b, budget_a, budget_b, taken) = match outcome {
        1 => (held_a + TO_WINNER, held_b - STAKE, CREDIT, 0, FEE),
        2 => (held_a - STAKE, held_b + TO_WINNER, 0, CREDIT, FEE),
        _ => (held_a, held_b, STAKE, STAKE, 0),
    };
    assert_eq!(fee, taken);
    assert_eq!(env.balance(&player_a), paid_a);
    assert_eq!(env.balance(&player_b), paid_b);
    assert_eq!(player_state(&env, &first.pubkey()), (budget_a, 0, 0, false, 0));
    assert_eq!(player_state(&env, &second.pubkey()), (budget_b, 0, 0, false, 0));
    assert_eq!(env.balance(&env.config), config_held + taken);
    assert_eq!(config_fees(&env), taken);

    let third = Keypair::new();
    let fourth = Keypair::new();
    env.fund(&third);
    env.fund(&fourth);
    let hold_a = env.army(&third, 0, 1, AshbornKind::Guard.id(), hold);
    let hold_b = env.army(&fourth, 0, 1, AshbornKind::Guard.id(), hold);
    queue(&mut env, &third, hold_a, hold);
    cover_stake(&mut env, &fourth, &ground);
    let (player_c, player_d) = (player_pda(&env, &third.pubkey()), player_pda(&env, &fourth.pubkey()));
    let (held_c, held_d) = (env.balance(&player_c), env.balance(&player_d));
    let logs = lock_match(&mut env, &fourth, hold_b, hold, hold_a, &third);
    assert_eq!(resolved(&logs), (3, 0));
    // A draw takes no fee and moves no lamports: each stake goes back to its budget.
    assert_eq!(player_state(&env, &third.pubkey()), (STAKE, 0, 0, false, 0));
    assert_eq!(player_state(&env, &fourth.pubkey()), (STAKE, 0, 0, false, 0));
    assert_eq!((env.balance(&player_c), env.balance(&player_d)), (held_c, held_d));
    assert_eq!(config_fees(&env), taken);
}

#[test]
fn a_second_settle_fails() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let first = Keypair::new();
    let second = Keypair::new();
    env.fund(&first);
    env.fund(&second);
    let army_a = env.army(&first, 0, 0, AshbornKind::Guard.id(), hold);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), hold);
    queue(&mut env, &first, army_a, hold);
    // Before the VRF callback the battle has no seed to settle on.
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    cover_stake(&mut env, &second, &ground);
    let battle = battle_pda(&env, 0, 0);
    let lock = lock_ix(&env, &second, ground, army_b, battle, &[hold], vec![meta(army_a, true, false), meta(player_pda(&env, &first.pubkey()), true, false)]);
    send(&mut env.svm, &second, &[cu_limit(), lock]);
    let early = settle_ix(&env, &battle);
    send_expect_reason(&mut env.svm, &first, &[cu_limit(), early], "NotSeeded");
    let scoped_key = scoped(&env);
    env.svm.set_account(scoped_key, Account { lamports: 1_000_000, data: vec![], owner: SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
    let fulfill = mock_fulfill(&env, &battle, &second.pubkey(), &sha256(battle.as_ref()));
    send(&mut env.svm, &second, &[cu_limit(), fulfill]);
    let call = settle_ix(&env, &battle);
    // The Players must be the battle's.
    let mut swapped = call.clone();
    swapped.accounts.swap(3, 4);
    send_expect_reason(&mut env.svm, &first, &[cu_limit(), swapped], "BadPda");
    let logs = send(&mut env.svm, &first, &[cu_limit(), call.clone()]);
    assert!(logs.iter().any(|line| line.contains("HZ_MATCH_RESOLVED")));
    let budgets = (player_state(&env, &first.pubkey()), player_state(&env, &second.pubkey()));
    // The battle is closed, so the same settlement finds nothing to pay.
    send_expect_reason(&mut env.svm, &first, &[cu_limit(), call], "AlreadyResolved");
    assert_eq!((player_state(&env, &first.pubkey()), player_state(&env, &second.pubkey())), budgets);
}

#[test]
fn an_unseeded_battle_cancels_after_the_wait_and_refunds_both_stakes() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let (first, second) = (Keypair::new(), Keypair::new());
    env.fund(&first);
    env.fund(&second);
    let army_a = env.army(&first, 0, 0, AshbornKind::Guard.id(), hold);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), hold);
    queue(&mut env, &first, army_a, hold);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    cover_stake(&mut env, &second, &ground);
    let (player_a, player_b) = (player_pda(&env, &first.pubkey()), player_pda(&env, &second.pubkey()));
    let before = (player_state(&env, &first.pubkey()), player_state(&env, &second.pubkey()));
    let held = (env.balance(&player_a), env.balance(&player_b));
    set_time(&mut env, 1_792_000_000);
    // The lock opens the battle; the VRF callback never comes.
    let battle = battle_pda(&env, 0, 0);
    let lock = lock_ix(&env, &second, ground, army_b, battle, &[hold], vec![meta(army_a, true, false), meta(player_a, true, false)]);
    send(&mut env.svm, &second, &[cu_limit(), lock]);
    assert_eq!(opened_at(&env, &battle), 1_792_000_000, "the battle records when it opened");
    assert_eq!(env.svm.get_account(&battle).unwrap().data[2108], 0, "awaiting");
    let cancel = cancel_ix(&env, &battle);
    let settle_call = settle_ix(&env, &battle);
    let caller = Keypair::new();
    env.fund(&caller);

    // Not before the wait is over, by even one second.
    send_expect_reason(&mut env.svm, &caller, std::slice::from_ref(&cancel), "TooEarly");
    set_time(&mut env, 1_792_000_000 + 599);
    send_expect_reason(&mut env.svm, &caller, std::slice::from_ref(&cancel), "TooEarly");
    set_time(&mut env, 1_792_000_000 + 600);
    // The Players must be the battle's.
    let mut swapped = cancel.clone();
    swapped.accounts.swap(3, 4);
    send_expect_reason(&mut env.svm, &caller, &[swapped], "BadPda");

    // Anyone cancels: both stakes go back to the budgets, the armies are Idle, the battle is closed
    // and its rent is back on the locker's Player.
    let logs = send(&mut env.svm, &caller, std::slice::from_ref(&cancel));
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_MATCH_CANCELLED {battle}"))));
    assert_eq!((player_state(&env, &first.pubkey()), player_state(&env, &second.pubkey())), before);
    assert_eq!((env.balance(&player_a), env.balance(&player_b)), held);
    assert_eq!(env.svm.get_account(&army_a).unwrap().data[1358], 0);
    assert_eq!(env.svm.get_account(&army_b).unwrap().data[1358], 0);
    assert!(env.svm.get_account(&battle).is_none_or(|account| account.data.is_empty() && account.lamports == 0));

    // A late VRF callback finds no battle and changes nothing; settling or cancelling again finds
    // nothing either.
    let scoped_key = scoped(&env);
    env.svm.set_account(scoped_key, Account { lamports: 1_000_000, data: vec![], owner: SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
    let late = mock_fulfill(&env, &battle, &caller.pubkey(), &sha256(battle.as_ref()));
    send_expect_err(&mut env.svm, &caller, &[cu_limit(), late]);
    assert!(env.svm.get_account(&battle).is_none_or(|account| account.data.is_empty()));
    send_expect_reason(&mut env.svm, &caller, &[cu_limit(), settle_call], "AlreadyResolved");
    send_expect_reason(&mut env.svm, &caller, &[cancel], "AlreadyResolved");
    assert_eq!((player_state(&env, &first.pubkey()), player_state(&env, &second.pubkey())), before);

    // Both armies can fight again.
    queue(&mut env, &first, army_a, hold);
    let logs = lock_match(&mut env, &second, army_b, hold, army_a, &first);
    assert_eq!(resolved(&logs).0, 3);
}

#[test]
fn a_seeded_battle_cannot_be_cancelled() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let (first, second) = (Keypair::new(), Keypair::new());
    env.fund(&first);
    env.fund(&second);
    let army_a = env.army(&first, 0, 0, AshbornKind::Guard.id(), hold);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), hold);
    queue(&mut env, &first, army_a, hold);
    let (battle, _) = lock_and_seed(&mut env, 0, &second, army_b, hold, army_a, &first, None);
    let at = opened_at(&env, &battle);
    set_time(&mut env, at + 10 * 600);
    // Its outcome is fixed by the seed: the loser could replay it and cancel. Settle it instead.
    let cancel = cancel_ix(&env, &battle);
    send_expect_reason(&mut env.svm, &first, &[cancel], "AlreadySeeded");
    let logs = settle(&mut env, &battle);
    assert_eq!(resolved(&logs), (3, 0));
}

#[test]
fn a_player_does_not_match_their_own_army_or_another_battleground() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let player = Keypair::new();
    env.fund(&player);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let first = env.army(&player, 0, 0, AshbornKind::Guard.id(), hold);
    let second = env.army(&player, 0, 1, AshbornKind::Guard.id(), hold);
    queue(&mut env, &player, first, hold);
    // The player's own queued army and Player are offered, and still the second army queues.
    let own = player_pda(&env, &player.pubkey());
    let lock = lock_ix(&env, &player, ground, second, battle_pda(&env, 0, 0), &[hold], vec![meta(first, true, false), meta(own, true, false)]);
    let logs = send(&mut env.svm, &player, &[cu_limit(), lock]);
    assert!(logs.iter().any(|line| line.contains("HZ_QUEUED")));
    assert_eq!(env.svm.get_account(&first).unwrap().data[1358], 1);
    assert_eq!(env.svm.get_account(&second).unwrap().data[1358], 1);
    assert_eq!(queued_armies(&env, &ground), vec![first, second]);

    // Another player on another battleground is offered both armies and their owner's Player, which
    // covers this battleground's stake too, and still queues: the armies are not in this queue.
    let other = Keypair::new();
    env.fund(&other);
    let (garrison, _) = pda(&[b"battleground", &[1]], &env.program);
    top_up(&mut env, &player, 50_000_000);
    let ixs = [player_ix(&env, &player, "fund_budget", &50_000_000u64.to_le_bytes())];
    send(&mut env.svm, &player, &ixs);
    let elsewhere = env.army(&other, 1, 0, AshbornKind::Guard.id(), hold);
    cover_stake(&mut env, &other, &garrison);
    let rest = vec![meta(first, true, false), meta(second, true, false), meta(own, true, false)];
    let lock = lock_ix(&env, &other, garrison, elsewhere, battle_pda(&env, 1, 0), &[hold], rest);
    let logs = send(&mut env.svm, &other, &[cu_limit(), lock]);
    assert!(logs.iter().any(|line| line.contains("HZ_QUEUED")));
    assert_eq!(env.svm.get_account(&elsewhere).unwrap().data[1358], 1);
    assert!(env.svm.get_account(&battle_pda(&env, 1, 0)).is_none(), "no battle opened");
}

#[test]
fn an_army_whose_owner_cannot_cover_a_stake_is_evicted() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let owner = Keypair::new();
    env.fund(&owner);
    let stranded = env.army(&owner, 0, 0, AshbornKind::Guard.id(), hold);
    let met = env.army(&owner, 0, 1, AshbornKind::Guard.id(), hold);
    queue(&mut env, &owner, stranded, hold);
    queue(&mut env, &owner, met, hold);
    let owner_player = player_pda(&env, &owner.pubkey());

    // A locker meets the second army: the owner's one stake is now locked and the budget is empty.
    let first = Keypair::new();
    env.fund(&first);
    let army = env.army(&first, 0, 0, AshbornKind::Guard.id(), hold);
    cover_stake(&mut env, &first, &ground);
    let lock = lock_ix(&env, &first, ground, army, battle_pda(&env, 0, 0), &[hold], vec![meta(met, true, false), meta(owner_player, true, false)]);
    send(&mut env.svm, &first, &[cu_limit(), lock]);
    assert_eq!(player_state(&env, &owner.pubkey()), (0, 0, STAKE, false, 1));
    assert_eq!(queued_armies(&env, &ground), vec![stranded]);

    // Without the owner's Player there is no evidence: the army is skipped, not evicted.
    let second = Keypair::new();
    env.fund(&second);
    let second_army = env.army(&second, 0, 0, AshbornKind::Guard.id(), hold);
    cover_stake(&mut env, &second, &ground);
    let lock = lock_ix(&env, &second, ground, second_army, Address::new_unique(), &[hold], vec![meta(stranded, true, false)]);
    let logs = send(&mut env.svm, &second, &[cu_limit(), lock]);
    assert!(!logs.iter().any(|line| line.contains("HZ_EVICT")));
    assert_eq!(queued_armies(&env, &ground), vec![stranded, second_army]);

    // A program-owned Player copy away from the owner's PDA is not evidence either.
    let mut forged = env.svm.get_account(&owner_player).unwrap();
    forged.data[40..48].copy_from_slice(&0u64.to_le_bytes());
    let fake = Address::new_unique();
    env.svm.set_account(fake, forged).unwrap();
    let third = Keypair::new();
    env.fund(&third);
    let third_army = env.army(&third, 0, 0, AshbornKind::Guard.id(), hold);
    cover_stake(&mut env, &third, &ground);
    let lock = lock_ix(&env, &third, ground, third_army, Address::new_unique(), &[hold], vec![meta(stranded, true, false), meta(fake, true, false)]);
    let logs = send(&mut env.svm, &third, &[cu_limit(), lock]);
    assert!(!logs.iter().any(|line| line.contains("HZ_EVICT")));
    assert_eq!(queued_armies(&env, &ground).len(), 3);

    // With the owner's real Player supplied, the next lock evicts the army and sets it Idle.
    let fourth = Keypair::new();
    env.fund(&fourth);
    let fourth_army = env.army(&fourth, 0, 0, AshbornKind::Guard.id(), hold);
    cover_stake(&mut env, &fourth, &ground);
    let lock = lock_ix(&env, &fourth, ground, fourth_army, Address::new_unique(), &[hold], vec![meta(stranded, true, false), meta(owner_player, true, false)]);
    let logs = send(&mut env.svm, &fourth, &[cu_limit(), lock]);
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_EVICT {stranded}"))));
    assert!(logs.iter().any(|line| line.contains("HZ_QUEUED")));
    let queued = queued_armies(&env, &ground);
    assert_eq!(queued.len(), 3);
    assert!(!queued.contains(&stranded) && queued.contains(&fourth_army));
    assert_eq!(env.svm.get_account(&stranded).unwrap().data[1358], 0, "the evicted army is Idle");
    // The owner closes it like any idle army.
    env.close_army(&owner, stranded);
}

#[test]
fn each_outcome_moves_exact_lamports_and_counters() {
    let strong: [Placement; 2] = [(AshbornKind::Warden, 3, 0), (AshbornKind::Guard, 4, 0)];
    let weak: [Placement; 1] = [(AshbornKind::Guard, 0, 0)];
    let march = behavior_march();
    let still = BehaviorBody::parse(&still_body()).unwrap();
    // (side A, its behavior, side B, its behavior, outcome). Side B is the locker, whose Player also
    // sponsors the battle, so on a B win the rent refund and the payout land on the same Player.
    type Case<'a> = (&'a [Placement], BehaviorBody, &'a [Placement], BehaviorBody, u8);
    let cases: [Case; 3] = [(&strong, march, &weak, still, 1), (&weak, still, &strong, march, 2), (&weak, still, &weak, still, 3)];
    for (units_a, body_a, units_b, body_b, outcome) in cases {
        let mut env = setup();
        let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
        let behavior_a = env.behavior(&body_a.canonical_bytes());
        let behavior_b = if body_b == body_a { behavior_a } else { env.behavior(&body_b.canonical_bytes()) };
        let snapshot = |units: &[Placement], body: BehaviorBody| -> Vec<SnapshotUnit> {
            units.iter().map(|&(kind, col, row)| SnapshotUnit::catalog(Race::Ashborn.id(), kind.id(), body, col, row).unwrap()).collect()
        };
        let seed = sha256(battle_pda(&env, 0, 0).as_ref());
        let (winner, _) = simulate(&snapshot(units_a, body_a), &snapshot(units_b, body_b), seed, Geometry { cols: 8, rows: 6 });
        let simulated = match winner {
            Some(Side::A) => 1,
            Some(Side::B) => 2,
            None => 3,
        };
        assert_eq!(simulated, outcome, "the fixture needs outcome {outcome}");

        let first = Keypair::new();
        let second = Keypair::new();
        env.fund(&first);
        env.fund(&second);
        let army_a = env.squad(&first, 0, 0, units_a, behavior_a);
        let army_b = env.squad(&second, 0, 0, units_b, behavior_b);
        queue(&mut env, &first, army_a, behavior_a);
        cover_stake(&mut env, &second, &ground);
        let (player_a, player_b) = (player_pda(&env, &first.pubkey()), player_pda(&env, &second.pubkey()));
        let (held_a, held_b, config_held) = (env.balance(&player_a), env.balance(&player_b), env.balance(&env.config));
        let logs = lock_match_seeded(&mut env, 0, &second, army_b, behavior_b, army_a, &first, None);
        assert_eq!(resolved(&logs), (outcome, if outcome == 3 { 0 } else { FEE }));
        let (lamports_a, lamports_b, state_a, state_b, fee) = match outcome {
            1 => (held_a + TO_WINNER, held_b - STAKE, (CREDIT, 0, 0, false, 0), (0, 0, 0, false, 0), FEE),
            2 => (held_a - STAKE, held_b + TO_WINNER, (0, 0, 0, false, 0), (CREDIT, 0, 0, false, 0), FEE),
            _ => (held_a, held_b, (STAKE, 0, 0, false, 0), (STAKE, 0, 0, false, 0), 0),
        };
        assert_eq!(env.balance(&player_a), lamports_a, "outcome {outcome}: Player A lamports");
        assert_eq!(env.balance(&player_b), lamports_b, "outcome {outcome}: Player B lamports");
        assert_eq!(player_state(&env, &first.pubkey()), state_a, "outcome {outcome}: Player A counters");
        assert_eq!(player_state(&env, &second.pubkey()), state_b, "outcome {outcome}: Player B counters");
        assert_eq!(env.balance(&env.config), config_held + fee, "outcome {outcome}: Config lamports");
        assert_eq!(config_fees(&env), fee, "outcome {outcome}: Config fees");
        assert!(env.svm.get_account(&battle_pda(&env, 0, 0)).is_none_or(|account| account.lamports == 0));
    }
}

#[test]
fn one_player_backs_many_armies_until_it_runs_dry() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let owner = Keypair::new();
    env.fund(&owner);
    // Three queued armies, one Player whose budget covers two stakes.
    ensure_player(&mut env, &owner);
    let ixs = [player_ix(&env, &owner, "fund_budget", &(2 * STAKE).to_le_bytes())];
    send(&mut env.svm, &owner, &ixs);
    let armies: Vec<Address> = (0..3).map(|index| env.army(&owner, 0, index, AshbornKind::Guard.id(), hold)).collect();
    for &army in &armies {
        queue(&mut env, &owner, army, hold);
    }
    assert_eq!(ground_queue_len(&env, &ground), 3);
    let player = player_pda(&env, &owner.pubkey());
    assert_eq!(player_state(&env, &owner.pubkey()), (2 * STAKE, 0, 0, false, 0));

    // Two lockers each meet one of the owner's armies; both stakes lock on the one Player.
    let mut met = Vec::new();
    for index in 0..2u8 {
        let locker = Keypair::new();
        env.fund(&locker);
        let army = env.army(&locker, 0, 0, AshbornKind::Guard.id(), hold);
        let queued = queued_armies(&env, &ground);
        let battle = battle_pda(&env, 0, ground_seq(&env, &ground));
        cover_stake(&mut env, &locker, &ground);
        let mut rest: Vec<AccountMeta> = queued.iter().map(|&key| meta(key, true, false)).collect();
        rest.push(meta(player, true, false));
        let lock = lock_ix(&env, &locker, ground, army, battle, &[hold], rest);
        let logs = send(&mut env.svm, &locker, &[cu_limit(), lock]);
        assert!(logs.iter().any(|line| line.contains("HZ_MATCH_OPEN")), "locker {index} matched");
        let data = env.svm.get_account(&battle).unwrap().data;
        let opponent = Address::try_from(&data[40..72]).unwrap();
        assert!(armies.contains(&opponent) && !met.contains(&opponent));
        met.push(opponent);
        let locked = index as u64 + 1;
        assert_eq!(player_state(&env, &owner.pubkey()), ((2 - locked) * STAKE, 0, locked * STAKE, false, locked as u16));
    }

    // The budget is spent: the next locker, given the owner's Player, evicts the third army instead
    // of meeting it, and queues. The owner cannot lock another army either.
    let left = queued_armies(&env, &ground);
    assert_eq!(left.len(), 1);
    let locker = Keypair::new();
    env.fund(&locker);
    let army = env.army(&locker, 0, 0, AshbornKind::Guard.id(), hold);
    cover_stake(&mut env, &locker, &ground);
    let rest = vec![meta(left[0], true, false), meta(player, true, false)];
    let lock = lock_ix(&env, &locker, ground, army, Address::new_unique(), &[hold], rest);
    let logs = send(&mut env.svm, &locker, &[cu_limit(), lock]);
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_EVICT {}", left[0]))));
    assert!(logs.iter().any(|line| line.contains("HZ_QUEUED")));
    assert_eq!(queued_armies(&env, &ground), vec![army]);
    assert_eq!(env.svm.get_account(&left[0]).unwrap().data[1358], 0, "the evicted army is Idle");
    let spare = env.army(&owner, 0, 3, AshbornKind::Guard.id(), hold);
    let lock = lock_ix(&env, &owner, ground, spare, Address::new_unique(), &[hold], vec![]);
    send_expect_reason(&mut env.svm, &owner, &[cu_limit(), lock], "BudgetTooLow");
}

#[test]
fn segregated_wins_stay_out_of_the_budget_and_draws_refund_it() {
    let mut env = setup();
    let advance = env.behavior(&behavior_march().canonical_bytes());
    let hold = env.behavior(&still_body());
    let first = Keypair::new();
    let second = Keypair::new();
    let stranger = Keypair::new();
    env.fund(&first);
    env.fund(&second);
    env.fund(&stranger);
    let strong: [Placement; 2] = [(AshbornKind::Warden, 3, 0), (AshbornKind::Guard, 4, 0)];
    let army_a = env.squad(&first, 0, 0, &strong, advance);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), hold);
    // Only the owner's own Player: the stranger's signature derives another address.
    let mut seized = player_ix(&env, &first, "set_segregation", &[1]);
    seized.accounts[0] = meta(stranger.pubkey(), true, true);
    send_expect_reason(&mut env.svm, &stranger, &[seized], "ConstraintSeeds");
    let call = [player_ix(&env, &first, "set_segregation", &[1])];
    let logs = send(&mut env.svm, &first, &call);
    assert!(logs.iter().any(|line| line.contains("HZ_PLAYER")));
    assert!(player_state(&env, &first.pubkey()).3);

    // The segregated player wins: the payout goes to winnings, which no match stakes.
    queue(&mut env, &first, army_a, advance);
    let snapshot = |units: &[Placement], body: BehaviorBody| -> Vec<SnapshotUnit> {
        units.iter().map(|&(kind, col, row)| SnapshotUnit::catalog(Race::Ashborn.id(), kind.id(), body, col, row).unwrap()).collect()
    };
    let weak = [(AshbornKind::Guard, 0, 0)];
    let seed = sha256(battle_pda(&env, 0, 0).as_ref());
    let (winner, _) = simulate(&snapshot(&strong, behavior_march()), &snapshot(&weak, BehaviorBody::parse(&still_body()).unwrap()), seed, Geometry { cols: 8, rows: 6 });
    assert_eq!(winner, Some(Side::A), "the fixture needs side A to win");
    let logs = lock_match(&mut env, &second, army_b, hold, army_a, &first);
    assert_eq!(resolved(&logs), (1, FEE));
    assert_eq!(player_state(&env, &first.pubkey()), (0, CREDIT, 0, true, 0));
    assert_eq!(player_state(&env, &second.pubkey()), (0, 0, 0, false, 0));
    // The winnings cannot be staked: locking again needs a fresh budget.
    let ground = pda(&[b"battleground", &[0]], &env.program).0;
    let lock = lock_ix(&env, &first, ground, army_a, Address::new_unique(), &[advance], vec![]);
    send_expect_reason(&mut env.svm, &first, &[cu_limit(), lock], "BudgetTooLow");

    // A draw returns each stake to its budget, segregated or not.
    let calm_a = env.army(&first, 0, 1, AshbornKind::Guard.id(), hold);
    let calm_b = env.army(&second, 0, 1, AshbornKind::Guard.id(), hold);
    queue(&mut env, &first, calm_a, hold);
    let logs = lock_match(&mut env, &second, calm_b, hold, calm_a, &first);
    assert_eq!(resolved(&logs), (3, 0));
    assert_eq!(player_state(&env, &first.pubkey()), (STAKE, CREDIT, 0, true, 0));

    // Switching segregation off moves nothing that is already held.
    let call = [player_ix(&env, &first, "set_segregation", &[0])];
    send(&mut env.svm, &first, &call);
    assert_eq!(player_state(&env, &first.pubkey()), (STAKE, CREDIT, 0, false, 0));
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
        assert!((1..=3).contains(&resolved(&logs).0));
        assert!(env.svm.get_account(&battle_pda(&env, ground_id, 0)).is_none_or(|account| account.lamports == 0), "settling closed the battle");
    }
}

/// Compute benchmark: `settle_match` on a fixed, seeded set of battles. Each battleground gets
/// `BENCH_BATTLES` pairs of random budget-legal armies, each army on one random standard behavior,
/// with a random VRF seed. Run with
/// `cargo test -p horizon-litesvm-tests cu_benchmark -- --ignored --nocapture`
/// after building the program with `--features inline-mock-vrf,inline-mock-magic`. Results go to stdout and to
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
            let stored = match winner {
                Some(Side::A) => 1,
                Some(Side::B) => 2,
                None => 3,
            };
            assert_eq!(resolved(&logs).0, stored, "on-chain outcome matches the host simulation");
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
    let mut body = Vec::new();
    body.extend_from_slice(seed);
    body.extend_from_slice(env.program.as_ref());
    body.extend_from_slice(&8u32.to_le_bytes());
    body.extend_from_slice(&sighash("seed_match"));
    let metas = [(*battle, true)];
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
        meta(SYSTEM, false, false),
        meta(address!("SysvarS1otHashes111111111111111111111111111"), false, false),
        meta(env.program, false, false),
        meta(scoped(env), false, false),
    ];
    accounts.extend(metas.iter().map(|&(key, writable)| meta(key, writable, false)));
    ix(env.vrf, accounts, data)
}

/// `settle_match` for a seeded battle, with the armies and Players read from the battle account.
fn settle_ix(env: &Env, battle: &Address) -> Instruction {
    let data = env.svm.get_account(battle).expect("the battle is open").data;
    let key = |at: usize| Address::try_from(&data[at..at + 32]).unwrap();
    let accounts = vec![
        meta(*battle, true, false),
        meta(key(40), true, false),
        meta(key(72), true, false),
        meta(player_pda(env, &key(104)), true, false),
        meta(player_pda(env, &key(136)), true, false),
        meta(env.config, true, false),
        meta(VAULT, true, false),
        meta(MAGIC, false, false),
    ];
    ix(env.program, accounts, disc("settle_match", &[]))
}

/// `cancel_match` for an open battle: `settle_match`'s accounts without Config.
fn cancel_ix(env: &Env, battle: &Address) -> Instruction {
    let mut call = settle_ix(env, battle);
    call.accounts.remove(5);
    call.data = disc("cancel_match", &[]);
    call
}

/// Sets the clock's `unix_timestamp`.
fn set_time(env: &mut Env, unix_timestamp: i64) {
    let mut clock: Clock = env.svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    env.svm.set_sysvar(&clock);
}

/// The battle's `opened_at`.
fn opened_at(env: &Env, battle: &Address) -> i64 {
    i64::from_le_bytes(env.svm.get_account(battle).unwrap().data[2146..2154].try_into().unwrap())
}

/// Settles the battle from a fresh wallet, with a compute limit first, as any client may. Returns
/// the logs.
fn settle(env: &mut Env, battle: &Address) -> Vec<String> {
    let caller = Keypair::new();
    env.fund(&caller);
    let call = settle_ix(env, battle);
    send(&mut env.svm, &caller, &[cu_limit(), call])
}

/// The outcome byte and the fee from the settlement's `HZ_MATCH_RESOLVED` line.
fn resolved(logs: &[String]) -> (u8, u64) {
    let line = logs.iter().find_map(|line| line.strip_prefix("Program log: HZ_MATCH_RESOLVED ")).expect("the battle resolved");
    let fields: Vec<&str> = line.split(' ').collect();
    (fields[1].parse().unwrap(), fields[2].parse().unwrap())
}

fn scoped(env: &Env) -> Address {
    pda(&[b"identity", env.program.as_ref()], &env.vrf).0
}

fn battle_pda(env: &Env, ground_id: u8, seq: u64) -> Address {
    let (ground, _) = pda(&[b"battleground", &[ground_id]], &env.program);
    pda(&[b"match", ground.as_ref(), &seq.to_le_bytes()], &env.program).0
}

/// Queues `army`, first funding its owner's budget with one stake when it holds less.
fn queue(env: &mut Env, player: &Keypair, army: Address, behavior: Address) {
    let stored: [u8; 32] = env.svm.get_account(&army).unwrap().data[40..72].try_into().unwrap();
    let ground = Address::from(stored);
    cover_stake(env, player, &ground);
    let battle = Address::new_unique();
    let mut lock = lock_ix(env, player, ground, army, battle, &[behavior], vec![]);
    // A lock that only queues passes the battle read-only, as the rollup requires.
    lock.accounts.iter_mut().filter(|meta| meta.pubkey == battle).for_each(|meta| meta.is_writable = false);
    send(&mut env.svm, player, &[cu_limit(), lock]);
}

/// `lock_army`: the fixed accounts, then the army's behaviors, then `rest`.
fn lock_ix(env: &Env, player: &Keypair, ground: Address, army: Address, battle: Address, behaviors: &[Address], rest: Vec<AccountMeta>) -> Instruction {
    let mut accounts = vec![
        meta(player.pubkey(), true, true),
        meta(player_pda(env, &player.pubkey()), true, false),
        meta(env.config, false, false),
        meta(ground, true, false),
        meta(army, true, false),
        meta(battle, true, false),
        meta(VAULT, true, false),
        meta(MAGIC, false, false),
        meta(env.queue, true, false),
        meta(pda(&[b"identity"], &env.program).0, false, false),
        meta(env.vrf, false, false),
        meta(address!("SysvarS1otHashes111111111111111111111111111"), false, false),
        meta(SYSTEM, false, false),
    ];
    accounts.extend(behaviors.iter().map(|&key| meta(key, false, false)));
    accounts.extend(rest);
    ix(env.program, accounts, disc("lock_army", &[]))
}

fn unlock_ix(env: &Env, player: &Keypair, ground: Address, army: Address) -> Instruction {
    ix(env.program, vec![meta(player.pubkey(), true, true), meta(ground, true, false), meta(army, true, false)], disc("unlock_army", &[]))
}

/// Funds the owner's budget up to one stake of `ground`, registering the owner first and topping
/// the Player up when its free lamports fall short. It leaves room for a battle's rent.
fn cover_stake(env: &mut Env, owner: &Keypair, ground: &Address) {
    let stake = u64::from_le_bytes(env.svm.get_account(ground).unwrap().data[43..51].try_into().unwrap());
    ensure_player(env, owner);
    let budget = player_state(env, &owner.pubkey()).0;
    if budget >= stake {
        return;
    }
    let need = stake - budget;
    let free = player_free(env, &owner.pubkey());
    if free < need + BATTLE_ROOM {
        top_up(env, owner, need + BATTLE_ROOM - free);
    }
    let ixs = [player_ix(env, owner, "fund_budget", &need.to_le_bytes())];
    send(&mut env.svm, owner, &ixs);
}

fn ground_queue_len(env: &Env, ground: &Address) -> u8 {
    env.svm.get_account(ground).unwrap().data[54]
}

fn lock_match(env: &mut Env, player: &Keypair, army: Address, behavior: Address, opponent: Address, opponent_owner: &Keypair) -> Vec<String> {
    lock_match_on(env, 0, player, army, behavior, opponent, opponent_owner)
}

/// Locks into a queued opponent and fulfills the VRF in the same transaction, then settles. Returns
/// the settlement's logs.
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
    settle(env, &battle)
}

/// Locks into a queued opponent and fulfills the VRF in the same transaction, leaving the battle
/// seeded. Returns the battle and the logs.
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
            env.svm.set_account(key, Account { lamports: 1_000_000, data: vec![], owner: SYSTEM, executable: false, rent_epoch: 0 }).unwrap();
        }
    }
    let seed = seed.unwrap_or_else(|| sha256(battle.as_ref()));
    let fulfill = mock_fulfill(env, &battle, &player.pubkey(), &seed);
    let opponent_player = player_pda(env, &opponent_owner.pubkey());
    let lock = lock_ix(env, player, ground, army, battle, &[behavior], vec![meta(opponent, true, false), meta(opponent_player, true, false)]);
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
    ensure_player(&mut env, &player);
    let (ground, _) = pda(&[b"battleground", &[0]], &env.program);
    let fixed = army_accounts(&env, &player, ground, Address::default());
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
        let mut accounts = fixed.clone();
        accounts[3] = meta(army, true, false);
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

/// As [`send`], building the instructions from the environment first.
fn send_with(env: &mut Env, payer: &Keypair, build: impl Fn(&Env) -> Vec<Instruction>) -> Vec<String> {
    let ixs = build(env);
    send(&mut env.svm, payer, &ixs)
}

const OUTBOX_LEN: usize = 49;
const CONFIG_LEN: usize = 83;
/// LiteSVM's fee for a transaction with one signature.
const TX_FEE: u64 = 5_000;
/// The rollup's magic context, written by every commit. The mock build does not check it.
const MAGIC_CONTEXT: Address = address!("MagicContext1111111111111111111111111111111");

fn treasury_outbox(env: &Env) -> Address {
    pda(&[b"outbox", env.config.as_ref()], &env.program).0
}

/// (owner, amount) of an Outbox, at the offsets in the accounts chapter.
fn outbox_state(env: &Env, outbox: &Address) -> (Address, u64) {
    let data = env.svm.get_account(outbox).unwrap().data;
    assert_eq!(data.len(), OUTBOX_LEN);
    (Address::try_from(&data[8..40]).unwrap(), u64::from_le_bytes(data[40..48].try_into().unwrap()))
}

/// `fund_outbox(amount)`: the owner, their Player and their Outbox.
fn fund_outbox_ix(env: &Env, owner: &Keypair, amount: u64) -> Instruction {
    let accounts = vec![meta(owner.pubkey(), false, true), meta(player_pda(env, &owner.pubkey()), true, false), meta(outbox_pda(env, &owner.pubkey()), true, false)];
    ix(env.program, accounts, disc("fund_outbox", &amount.to_le_bytes()))
}

/// `withdraw`: the signer, their Player (committed), the Outbox, then the magic context and program.
fn withdraw_ix(env: &Env, signer: &Keypair, outbox: Address) -> Instruction {
    let player = player_pda(env, &signer.pubkey());
    let accounts = vec![meta(signer.pubkey(), true, true), meta(player, true, false), meta(outbox, true, false), meta(MAGIC_CONTEXT, true, false), meta(MAGIC, false, false)];
    ix(env.program, accounts, disc("withdraw", &[]))
}

/// `release_outbox`: the Outbox and the wallet it pays.
fn release_ix(env: &Env, outbox: Address, owner: Address) -> Instruction {
    ix(env.program, vec![meta(outbox, true, false), meta(owner, true, false)], disc("release_outbox", &[]))
}

/// `init_treasury_outbox`, `fund_treasury_outbox` and `claim_fees` take the signer, Config and the
/// treasury Outbox; the first adds the system program, the last the magic accounts. The last two
/// take Config writable: one moves its fees, the other commits it.
fn treasury_ix(env: &Env, signer: &Keypair, name: &str) -> Instruction {
    let writable = name != "init_treasury_outbox";
    let mut accounts = vec![meta(signer.pubkey(), true, true), meta(env.config, writable, false), meta(treasury_outbox(env), true, false)];
    match name {
        "init_treasury_outbox" => accounts.push(meta(SYSTEM, false, false)),
        "claim_fees" => accounts.extend([meta(MAGIC_CONTEXT, true, false), meta(MAGIC, false, false)]),
        _ => {}
    }
    ix(env.program, accounts, disc(name, &[]))
}

/// One battle on battleground 0 that the first wallet's squad wins against the second's lone
/// guard, with the winner's payouts segregated when `segregate`. Returns (winner, loser).
fn won_battle(env: &mut Env, segregate: bool) -> (Keypair, Keypair) {
    let advance = env.behavior(&behavior_march().canonical_bytes());
    let hold = env.behavior(&still_body());
    let (winner, loser) = (Keypair::new(), Keypair::new());
    env.fund(&winner);
    env.fund(&loser);
    let strong: [Placement; 2] = [(AshbornKind::Warden, 3, 0), (AshbornKind::Guard, 4, 0)];
    let army_a = env.squad(&winner, 0, 0, &strong, advance);
    let army_b = env.army(&loser, 0, 0, AshbornKind::Guard.id(), hold);
    if segregate {
        let call = [player_ix(env, &winner, "set_segregation", &[1])];
        send(&mut env.svm, &winner, &call);
    }
    queue(env, &winner, army_a, advance);
    let logs = lock_match(env, &loser, army_b, hold, army_a, &winner);
    assert_eq!(resolved(&logs), (1, FEE), "the fixture needs side A to win");
    (winner, loser)
}

#[test]
fn withdraw_takes_free_then_winnings_then_budget_and_release_pays_the_owner() {
    let mut env = setup();
    let (owner, _) = won_battle(&mut env, true);
    let stranger = Keypair::new();
    env.fund(&stranger);
    assert_eq!(player_state(&env, &owner.pubkey()), (0, CREDIT, 0, true, 0));
    let ixs = [player_ix(&env, &owner, "fund_budget", &40_000_000u64.to_le_bytes())];
    send(&mut env.svm, &owner, &ixs);
    let player = player_pda(&env, &owner.pubkey());
    let outbox = outbox_pda(&env, &owner.pubkey());
    let outbox_rent = env.svm.minimum_balance_for_rent_exemption(OUTBOX_LEN);
    assert_eq!(env.balance(&outbox), outbox_rent);
    assert_eq!(outbox_state(&env, &outbox), (owner.pubkey(), 0));

    // Nothing to send, and only the owner's own Player and Outbox.
    send_expect_reason_with(&mut env, &owner, |env| vec![fund_outbox_ix(env, &owner, 0)], "NothingToWithdraw");
    let mut seized = fund_outbox_ix(&env, &owner, 1);
    seized.accounts[0] = meta(stranger.pubkey(), false, true);
    send_expect_reason(&mut env.svm, &stranger, &[seized], "ConstraintSeeds");
    send_expect_reason_with(&mut env, &owner, |env| vec![withdraw_ix(env, &owner, outbox)], "NothingToWithdraw");
    send_expect_reason_with(&mut env, &stranger, |env| vec![withdraw_ix(env, &stranger, outbox)], "ConstraintSeeds");

    // All the free lamports, then 10_000_000 of the winnings; the budget is untouched.
    let free = player_free(&env, &owner.pubkey());
    let held = env.balance(&player);
    let first = free + 10_000_000;
    let ixs = [fund_outbox_ix(&env, &owner, first), withdraw_ix(&env, &owner, outbox)];
    let logs = send(&mut env.svm, &owner, &ixs);
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_OUTBOX_FUND {outbox} {} {first}", owner.pubkey()))));
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_WITHDRAW {outbox} {first}"))));
    assert!(logs.iter().any(|line| line.contains("HZ_PLAYER")));
    assert_eq!(player_state(&env, &owner.pubkey()), (40_000_000, CREDIT - 10_000_000, 0, true, 0));
    assert_eq!(player_free(&env, &owner.pubkey()), 0);
    assert_eq!(env.balance(&player), held - first);
    assert_eq!(env.balance(&outbox), outbox_rent + first);
    assert_eq!(outbox_state(&env, &outbox), (owner.pubkey(), first));

    // `withdraw` reads the Outbox by hand and refuses one this program does not own, and commits
    // only a Player this program owns.
    let funded = env.svm.get_account(&outbox).unwrap();
    env.svm.set_account(outbox, Account { owner: SYSTEM, ..funded.clone() }).unwrap();
    send_expect_reason_with(&mut env, &owner, |env| vec![withdraw_ix(env, &owner, outbox)], "BadPda");
    env.svm.set_account(outbox, funded).unwrap();
    let stored = env.svm.get_account(&player).unwrap();
    env.svm.set_account(player, Account { owner: SYSTEM, ..stored.clone() }).unwrap();
    send_expect_reason_with(&mut env, &owner, |env| vec![withdraw_ix(env, &owner, outbox)], "BadPda");
    env.svm.set_account(player, stored).unwrap();

    // One withdrawal at a time, until the Outbox is released.
    send_expect_reason_with(&mut env, &owner, |env| vec![fund_outbox_ix(env, &owner, 1)], "OutboxBusy");
    // The release pays the recorded owner, whoever sends it, and only them.
    send_expect_reason_with(&mut env, &stranger, |env| vec![release_ix(env, outbox, stranger.pubkey())], "ConstraintAddress");
    let wallet = env.balance(&owner.pubkey());
    let logs = send_with(&mut env, &stranger, |env| vec![release_ix(env, outbox, owner.pubkey())]);
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_RELEASE {outbox} {first}"))));
    assert_eq!(env.balance(&owner.pubkey()), wallet + first);
    assert_eq!(env.balance(&outbox), outbox_rent, "the release leaves the Outbox its rent");
    assert_eq!(outbox_state(&env, &outbox), (owner.pubkey(), 0));
    // A second release pays nothing and logs nothing.
    let logs = send_with(&mut env, &stranger, |env| vec![release_ix(env, outbox, owner.pubkey())]);
    assert!(!logs.iter().any(|line| line.contains("HZ_RELEASE")));
    assert_eq!(env.balance(&owner.pubkey()), wallet + first);

    // The rest of the winnings, then 15_000_000 of the budget; asking past it is short.
    let second = CREDIT - 10_000_000 + 15_000_000;
    let ixs = [fund_outbox_ix(&env, &owner, second), withdraw_ix(&env, &owner, outbox)];
    send(&mut env.svm, &owner, &ixs);
    assert_eq!(player_state(&env, &owner.pubkey()), (25_000_000, 0, 0, true, 0));
    assert_eq!(env.balance(&player), held - first - second);
    send_with(&mut env, &stranger, |env| vec![release_ix(env, outbox, owner.pubkey())]);
    assert_eq!(env.balance(&owner.pubkey()), wallet + first + second - TX_FEE, "less the fee for the second withdrawal");
    send_expect_reason_with(&mut env, &owner, |env| vec![fund_outbox_ix(env, &owner, 25_000_001)], "BalanceShort");
    send_with(&mut env, &owner, |env| vec![fund_outbox_ix(env, &owner, 25_000_000)]);
    assert_eq!(player_state(&env, &owner.pubkey()), (0, 0, 0, true, 0));
    assert_eq!(env.balance(&player), env.svm.minimum_balance_for_rent_exemption(PLAYER_LEN), "the Player keeps its rent");
}

#[test]
fn funding_an_outbox_keeps_the_players_rent_and_counters() {
    let mut env = setup();
    let owner = Keypair::new();
    env.fund(&owner);
    register(&mut env, &owner, 100_000_000);
    let ixs = [player_ix(&env, &owner, "fund_budget", &60_000_000u64.to_le_bytes())];
    send(&mut env.svm, &owner, &ixs);
    // A Player that holds one lamport less than its rent and budget claim: the counters allow any
    // part of the budget, but every move would leave the Player short of what it still claims.
    let player = player_pda(&env, &owner.pubkey());
    let rent = env.svm.minimum_balance_for_rent_exemption(PLAYER_LEN);
    let held = env.svm.get_account(&player).unwrap();
    env.svm.set_account(player, Account { lamports: rent + 60_000_000 - 1, ..held }).unwrap();
    for amount in [60_000_000u64, 1] {
        send_expect_reason_with(&mut env, &owner, |env| vec![fund_outbox_ix(env, &owner, amount)], "BalanceShort");
    }
    // Once the lamport is back, the whole budget can leave.
    top_up(&mut env, &owner, 1);
    send_with(&mut env, &owner, |env| vec![fund_outbox_ix(env, &owner, 60_000_000)]);
    assert_eq!(player_state(&env, &owner.pubkey()), (0, 0, 0, false, 0));
    assert_eq!(env.balance(&player), rent);
}

#[test]
fn withdraw_never_touches_locked_stakes() {
    let mut env = setup();
    let hold = env.behavior(&still_body());
    let (first, second) = (Keypair::new(), Keypair::new());
    env.fund(&first);
    env.fund(&second);
    let army_a = env.army(&first, 0, 0, AshbornKind::Guard.id(), hold);
    let army_b = env.army(&second, 0, 0, AshbornKind::Guard.id(), hold);
    queue(&mut env, &first, army_a, hold);
    let (battle, _) = lock_and_seed(&mut env, 0, &second, army_b, hold, army_a, &first, None);
    let ixs = [player_ix(&env, &first, "fund_budget", &30_000_000u64.to_le_bytes())];
    send(&mut env.svm, &first, &ixs);
    assert_eq!(player_state(&env, &first.pubkey()), (30_000_000, 0, STAKE, false, 1));

    // Free and budget may leave; the locked stake may not, by even one lamport.
    let player = player_pda(&env, &first.pubkey());
    let open = player_free(&env, &first.pubkey()) + 30_000_000;
    send_expect_reason_with(&mut env, &first, |env| vec![fund_outbox_ix(env, &first, open + 1)], "BalanceShort");
    send_with(&mut env, &first, |env| vec![fund_outbox_ix(env, &first, open)]);
    assert_eq!(player_state(&env, &first.pubkey()), (0, 0, STAKE, false, 1));
    assert_eq!(env.balance(&player), env.svm.minimum_balance_for_rent_exemption(PLAYER_LEN) + STAKE);
    assert_eq!(outbox_state(&env, &outbox_pda(&env, &first.pubkey())).1, open);

    // The stake is still there for the settlement: the guards draw and it returns to the budget.
    let logs = settle(&mut env, &battle);
    assert_eq!(resolved(&logs), (3, 0));
    assert_eq!(player_state(&env, &first.pubkey()), (STAKE, 0, 0, false, 0));
}

#[test]
fn only_the_admin_claims_fees_and_release_pays_the_admin() {
    let mut env = setup();
    won_battle(&mut env, false);
    assert_eq!(config_fees(&env), FEE);
    let admin = env.admin.insecure_clone();
    let stranger = Keypair::new();
    env.fund(&stranger);
    let outbox = treasury_outbox(&env);

    send_expect_reason_with(&mut env, &stranger, |env| vec![treasury_ix(env, &stranger, "init_treasury_outbox")], "NotAdmin");
    send_with(&mut env, &admin, |env| vec![treasury_ix(env, &admin, "init_treasury_outbox")]);
    let outbox_rent = env.svm.minimum_balance_for_rent_exemption(OUTBOX_LEN);
    assert_eq!(env.balance(&outbox), outbox_rent);
    assert_eq!(outbox_state(&env, &outbox), (admin.pubkey(), 0));

    send_expect_reason_with(&mut env, &stranger, |env| vec![treasury_ix(env, &stranger, "fund_treasury_outbox")], "NotAdmin");
    send_expect_reason_with(&mut env, &admin, |env| vec![treasury_ix(env, &admin, "claim_fees")], "NothingToWithdraw");
    // Config one lamport short of its rent and fees cannot pay the fees out.
    let config_rent = env.svm.minimum_balance_for_rent_exemption(CONFIG_LEN);
    let held = env.svm.get_account(&env.config).unwrap();
    env.svm.set_account(env.config, Account { lamports: config_rent + FEE - 1, ..held.clone() }).unwrap();
    send_expect_reason_with(&mut env, &admin, |env| vec![treasury_ix(env, &admin, "fund_treasury_outbox")], "BalanceShort");
    env.svm.set_account(env.config, held).unwrap();
    let config_held = env.balance(&env.config);
    let ixs = [treasury_ix(&env, &admin, "fund_treasury_outbox"), treasury_ix(&env, &admin, "claim_fees")];
    let logs = send(&mut env.svm, &admin, &ixs);
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_OUTBOX_FUND {outbox} {} {FEE}", admin.pubkey()))));
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_CLAIM {outbox} {FEE}"))));
    assert_eq!(config_fees(&env), 0);
    assert_eq!(env.balance(&env.config), config_held - FEE);
    assert_eq!(env.balance(&env.config), config_rent, "Config keeps its rent");
    assert_eq!(env.balance(&outbox), outbox_rent + FEE);
    assert_eq!(outbox_state(&env, &outbox), (admin.pubkey(), FEE));
    send_expect_reason_with(&mut env, &admin, |env| vec![treasury_ix(env, &admin, "fund_treasury_outbox")], "OutboxBusy");
    send_expect_reason_with(&mut env, &stranger, |env| vec![treasury_ix(env, &stranger, "claim_fees")], "NotAdmin");
    // claim_fees commits Config, so it must be this program's: the same bytes owned by the system
    // program are refused.
    let config_account = env.svm.get_account(&env.config).unwrap();
    env.svm.set_account(env.config, Account { owner: SYSTEM, ..config_account.clone() }).unwrap();
    send_expect_reason_with(&mut env, &admin, |env| vec![treasury_ix(env, &admin, "claim_fees")], "BadPda");
    env.svm.set_account(env.config, config_account).unwrap();

    let wallet = env.balance(&admin.pubkey());
    send_expect_reason_with(&mut env, &stranger, |env| vec![release_ix(env, outbox, stranger.pubkey())], "ConstraintAddress");
    let logs = send_with(&mut env, &stranger, |env| vec![release_ix(env, outbox, admin.pubkey())]);
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_RELEASE {outbox} {FEE}"))));
    assert_eq!(env.balance(&admin.pubkey()), wallet + FEE);
    assert_eq!(env.balance(&outbox), outbox_rent);
    assert_eq!(outbox_state(&env, &outbox), (admin.pubkey(), 0));
    // No fees left: nothing to claim.
    send_expect_reason_with(&mut env, &admin, |env| vec![treasury_ix(env, &admin, "fund_treasury_outbox")], "NothingToWithdraw");
}

#[test]
fn solana_admin_checks_read_config_by_hand() {
    let mut env = setup();
    let admin = env.admin.insecure_clone();
    let stranger = Keypair::new();
    env.fund(&stranger);
    let data = env.svm.get_account(&env.config).unwrap().data;
    assert_eq!(data.len(), CONFIG_LEN);
    assert_eq!(Address::try_from(&data[50..82]).unwrap(), VALIDATOR, "initialize pinned the rollup validator");

    // `create_battleground` and `init_treasury_outbox` read Config by hand. The treasury Outbox's
    // seeds follow the account passed as Config, so each call names the Outbox of that account.
    let mut args = vec![3u8];
    args.extend_from_slice(&BUDGET.to_le_bytes());
    args.extend_from_slice(&STAKE.to_le_bytes());
    args.extend_from_slice(&[8, 6]);
    let ground = pda(&[b"battleground", &[3]], &env.program).0;
    let create = |env: &Env, signer: &Keypair, config: Address| {
        let accounts = vec![meta(signer.pubkey(), true, true), meta(config, false, false), meta(ground, true, false), meta(SYSTEM, false, false)];
        ix(env.program, accounts, disc("create_battleground", &args))
    };
    let init = |env: &Env, signer: &Keypair, config: Address| {
        let outbox = pda(&[b"outbox", config.as_ref()], &env.program).0;
        let accounts = vec![meta(signer.pubkey(), true, true), meta(config, false, false), meta(outbox, true, false), meta(SYSTEM, false, false)];
        ix(env.program, accounts, disc("init_treasury_outbox", &[]))
    };

    // A program account of another type: the admin's Player.
    let player = player_pda(&env, &admin.pubkey());
    send_expect_reason_with(&mut env, &admin, |env| vec![init(env, &admin, player)], "AccountDiscriminatorMismatch");
    // Config's own bytes at another address, owned by this program.
    let config = env.svm.get_account(&env.config).unwrap();
    let copy = Address::new_unique();
    env.svm.set_account(copy, config.clone()).unwrap();
    send_expect_reason_with(&mut env, &admin, |env| vec![init(env, &admin, copy)], "BadPda");
    send_expect_reason_with(&mut env, &admin, |env| vec![create(env, &admin, copy)], "BadPda");
    // The real Config owned by a foreign program: only the owner check is wrong.
    env.svm.set_account(env.config, Account { owner: SYSTEM, ..config.clone() }).unwrap();
    send_expect_reason_with(&mut env, &admin, |env| vec![init(env, &admin, env.config)], "BadPda");
    send_expect_reason_with(&mut env, &admin, |env| vec![create(env, &admin, env.config)], "BadPda");

    // The real Config as a delegated Config's Solana copy, owned by the delegation program: the admin
    // still passes both, and a stranger is still refused.
    env.svm.set_account(env.config, Account { owner: DELEGATION, ..config.clone() }).unwrap();
    send_expect_reason_with(&mut env, &stranger, |env| vec![create(env, &stranger, env.config)], "NotAdmin");
    send_expect_reason_with(&mut env, &stranger, |env| vec![init(env, &stranger, env.config)], "NotAdmin");
    let logs = send_with(&mut env, &admin, |env| vec![create(env, &admin, env.config)]);
    assert!(logs.iter().any(|line| line.contains(&format!("HZ_BATTLEGROUND {ground} 3"))));
    send_with(&mut env, &admin, |env| vec![init(env, &admin, env.config)]);
    assert_eq!(outbox_state(&env, &treasury_outbox(&env)), (admin.pubkey(), 0));
    env.svm.set_account(env.config, config).unwrap();
}
