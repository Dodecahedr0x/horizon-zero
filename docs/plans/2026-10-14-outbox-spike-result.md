# Ephemeral rollup outbox spike: result

Date: 2026-10-14. Branch `spike/outbox`, code in `spike/outbox/` (own Cargo workspace, not in the root workspace).

Verdict: **the plan stands.** All six questions answered on the local stack. The post-undelegate action runs with the Outbox already owned by the program, so `release_outbox` pays the owner in the same base transaction as the undelegation. One constraint the main program must respect: **move lamports into the Outbox in an instruction other than the one that schedules commit-and-undelegate** (see Surprises).

## Setup

- `spike/outbox/stack.sh`: `mb-stack` (npm `@magicblock-labs/ephemeral-validator@0.14.10`) with the spike loaded at genesis (`--bpf-program`), plus a second `vrf-oracle` pointed at the rollup (`--rpc-url http://127.0.0.1:7799 --websocket-url ws://127.0.0.1:7800`).
- `pnpm localnet` was not used: it loads horizon_zero and bootstraps the game, and its only oracle watches the base validator.
- `spike/outbox/run.mjs`: Node, `@solana/web3.js` 1.98 + `@magicblock-labs/ephemeral-rollups-sdk` 0.17.3. It uses a fresh wallet each run. `--mode=` picks the withdraw variant.
- Spike program id: `HTTzWDatMVaFCCK1cpt5BMh7qoaeHpmQxKGJXt6wJ3mz`, from a throwaway keypair in `target/deploy/` that is not committed.
- `solana program deploy` to the base validator fails with `Detected sbpf_version required by the executable which are not enabled` (cargo-build-sbf default v0, solana 4.2.1). Loading at genesis works, which is also what `scripts/local-stack.mjs` does.
- The rollup clones the program from base on first use. It appears owned by `LoaderV411111111111111111111111111111111111`.
- Local ER validator identity: `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev`. Accounts must be delegated with `validator = Some(that)`. The SDK default `DEFAULT_VALIDATOR_IDENTITY` (`MAS1Dt9…`) is a different key.

## Answers

### 1. Does a PDA sponsor (invoke_signed) create an ephemeral account? **Yes.**

`make_eph`, rollup tx, Holder PDA signing as sponsor and the `[b"eph", owner]` PDA signing as the ephemeral account:

```
Program Magic11111111111111111111111111111111111111 invoke [2]
Created ephemeral: 64 bytes, 3968 rent, owner: HTTzWDatMVaFCCK1cpt5BMh7qoaeHpmQxKGJXt6wJ3mz
Program log: SPIKE_EPH eph=AAsmrhF8… owner=HTTzWDat… len=64 holder_charge=3968
SPIKE er eph owner=HTTzWDat… lamports=0 len=64
```

The rent is `(64 + 60) * 32 = 3968` lamports, moved from the Holder to `MagicVau1t999999999999999999999999999999999`. The ephemeral account holds 0 lamports and is owned by the calling program. The Holder is a typed `Account<Holder>` in that instruction, and Anchor's exit is fine with that.

### 2. Does `lamportsDelegatedTransferIx` credit Holder in the ER, and at what charge? **Yes, exactly; the wallet pays 0.0003 SOL plus the tx fee.**

```
SPIKE top_up wallet_delta=50305000 amount=50000000 overhead=305000 tx_fee=5000 rent_pda_delta=-6764400
SPIKE top_up er_holder before=101394992 after=151394992 credited=50000000
SPIKE base holder after top-up owner=DELeGG… lamports=101398960   (unchanged on Solana)
```

- The wallet pays the amount, plus 300,000 lamports, plus the 5,000 tx fee.
- The eSPL program (`SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2`) creates and delegates a temporary lamports PDA `[b"lamports", payer, destination, salt]`. It funds the PDA's rent and delegation accounts from its `[b"rent"]` PDA.
- The rollup merges the PDA into the Holder within about a second. It then undelegates and closes the PDA, and the rent PDA gets its 6,764,400 back.
- On Solana the Holder's balance does not change. The credit exists only in the rollup until the Holder is committed.
- **Local-stack prerequisite:** the eSPL `[b"rent"]` PDA (`4RvdEGaUyChj3AketeBZoY1EotNtPveMFUXL8DVetrAp`) is not created by mb-stack. Without it the top-up fails with `Transfer: insufficient lamports 300000, need 890880`. `run.mjs` creates it once with the SDK's `initRentPdaIx` (eSPL ix 23) and funds it with 1 SOL. `pnpm localnet` bootstrap will need the same step.

### 3. Does the post-undelegate action run with the Outbox program-owned (release succeeds)? **Yes.**

The validator sends one base transaction, signed by `mAGic…`, that (judging by the instruction sequence) commits, finalizes, undelegates (calling the program's `process_undelegation`), and then runs the action through the delegation program's `call_handler`:

```
Program DELeGG… invoke [1]                         (commit, inferred)
Program DELeGG… invoke [1]                         (finalize, inferred)
Program DELeGG… invoke [1]
  Program log: Instruction: ProcessUndelegation
Program DELeGG… invoke [1]                         (call_handler)
  Program log: Instruction: ReleaseOutbox
  Program log: SPIKE_RELEASE owner=7kqfnsGQ… amount=20000000 extra_accounts=3
  Program log: SPIKE_RELEASE_EXTRA 0 HTTzWDat… signer=false writable=false   (destination program)
  Program log: SPIKE_RELEASE_EXTRA 1 7kqfnsGQ… signer=false writable=true    (escrow authority = payer)
  Program log: SPIKE_RELEASE_EXTRA 2 Fu8eQQxU… signer=true  writable=true    (escrow PDA)
SPIKE base outbox after … owner=HTTzWDat… lamports=1231920 {"amount":"0"}
SPIKE owner base balance before=4840781200 after=4863620160   (+20,000,000 released, +2,838,960 delegation rent refund)
```

- `release_outbox` takes `Account<Outbox>`, so it would fail deserialization if the Outbox were still owned by the delegation program. It succeeded.
- The release had already landed when the client started polling, about one second after the rollup transaction.
- This worked with the wallet paying the intent and with the Holder paying it (see Payer and escrow).
- In the base transaction, the validator identity paid the Outbox's committed lamport increase plus fees (`mAGic… -20,385,000`). The record and metadata rent went to the owner (+2,838,960), the validator fees vault (+270,000) and the protocol fees vault (+30,000).

### 4. Does a manual `release_outbox` on base succeed after undelegation? **Yes.**

After the action had run, a third-party signer (not the owner) called `release_outbox` on the same Outbox. It succeeded and paid the recorded amount, which was 0 by then:

```
Program log: Instruction: ReleaseOutbox
Program log: SPIKE_RELEASE owner=7kqfnsGQ… amount=0 extra_accounts=0
Program HTTzWDat… success
```

The instruction is permissionless and needs no escrow accounts. The client fallback works, but the action never failed in any run, so the fallback was not needed.

### 5. Does an ephemeral-queue VRF callback land in the ER? **Yes, with an oracle that watches the rollup.**

`ping_vrf` runs in the rollup with the wallet as payer and the `#[vrf]` `invoke_signed_vrf` pattern copied from horizon_zero. About one second later the oracle's callback runs in the rollup:

```
SPIKE_VRF_REQUEST queue=Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT
er tx: Program Vrf1RNUj… invoke [1]
         Program log: Instruction: SeedHolder
         Program log: SPIKE_VRF_CALLBACK holder=Fi5mdrVH… seed0=152
vrf-oracle-er.log: Processing queue: Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT
```

- The ephemeral test queue is preloaded on base and delegated, so it is writable in the rollup.
- The oracle that `local-stack.mjs` starts watches base (8899) and serves `GKE6…`. A second `vrf-oracle --rpc-url http://127.0.0.1:7799 --websocket-url ws://127.0.0.1:7800` is required. It reuses the same built-in key (`paywJiVATrVDLYLmowJqzG6MsaCt77L8WyTnBb2754t`).
- The callback validates the scoped identity injected by `#[vrf_callback]` and writes a delegated `Account<Holder>`.

### 6. Local URLs and queue

| What | Value |
| --- | --- |
| Base (Solana) RPC | `http://127.0.0.1:8899`, ws `ws://127.0.0.1:8900` |
| Rollup RPC (used for every rollup tx) | `http://127.0.0.1:7799`, ws `ws://127.0.0.1:7800` |
| Public router (not used by the spike) | `http://127.0.0.1:6699`, ws `ws://127.0.0.1:6700` |
| Rollup validator identity | `mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev` |
| VRF queue | `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` (`ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_TEST_QUEUE`) |

Rollup transactions signed by a plain, undelegated wallet were accepted with `fee=0` on the local stack. Whether devnet or mainnet rollups charge or reject undelegated fee payers was not tested.

## Shapes that worked (copy into the main program)

Register on Solana (`#[delegate]`, `del` fields must be `UncheckedAccount`). Create each PDA with a system `create_account` signed by its seeds. Write the data by hand (`T { .. }.try_serialize(&mut &mut data[..])`), then delegate:

```rust
ctx.accounts.delegate_holder(&ctx.accounts.owner, &[b"holder", owner.as_ref()],
    DelegateConfig { validator: Some(er_identity), ..Default::default() })?;
```

Account order generated by `#[delegate]`: each `del` field is preceded by `buffer_<f>` (`[b"buffer", f]` under the program), `delegation_record_<f>` (`[b"delegation", f]` under DLP) and `delegation_metadata_<f>` (`[b"delegation-metadata", f]` under DLP). The macro appends `owner_program`, `delegation_program` and `system_program` at the end. In TS: `delegateBufferPdaFromDelegatedAccountAndOwnerProgram`, `delegationRecordPdaFromDelegatedAccount`, `delegationMetadataPdaFromDelegatedAccount`.

Ephemeral account (rollup), accounts `owner (s,w)`, `holder (w)`, `eph (w)`, `MagicVau1t999… (w)`, `Magic111… (r)`:

```rust
EphemeralAccount::new(&holder_info, &eph_info, &vault_info)
    .with_signer_seeds(&[&[b"holder", owner.as_ref(), &[bump]], &[b"eph", owner.as_ref(), &[eph_bump]]])
    .create(64)?;
```

Withdraw (rollup). This is two instructions in one transaction, so the lamport move happens in an instruction that does not schedule anything:

1. `fund_outbox`: `holder.sub_lamports(x)`, `outbox.add_lamports(x)`, and `outbox.amount = x` written by hand. Outbox is an `UncheckedAccount`.
2. `withdraw`. Accounts: `owner (s,w)`, `holder (w)`, `outbox (w, UncheckedAccount)`, `MagicContext1111111111111111111111111111111 (w)`, `Magic11111111111111111111111111111111111111 (r)`, and with the Holder as payer also the magic fee vault `(w)`:

```rust
use ephemeral_rollups_sdk::ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};

let action = CallHandler {
    destination_program: crate::ID,
    accounts: vec![
        ShortAccountMeta { pubkey: outbox.key(), is_writable: true },
        ShortAccountMeta { pubkey: owner.key(), is_writable: true },
    ],
    args: ActionArgs::new(instruction::ReleaseOutbox::DISCRIMINATOR.to_vec()), // escrow_index 255
    escrow_authority: payer_info.clone(),
    compute_units: 20_000,
};
// wallet pays:
MagicIntentBundleBuilder::new(owner_info, magic_context, magic_program)
    .commit_and_undelegate(&[outbox_info])
    .add_post_undelegate_actions([action])
    .build_and_invoke()?;
// or Holder PDA pays:
MagicIntentBundleBuilder::new(holder_info, magic_context, magic_program)
    .magic_fee_vault(magic_fee_vault_info)
    .commit_and_undelegate(&[outbox_info])
    .add_post_undelegate_actions([action])
    .build_and_invoke_signed(&[&[b"holder", owner.as_ref(), &[bump]]])?;
```

- `FoldableIntentBuilder` must be imported outside the `#[ephemeral]` module. The macro imports it only inside the module.
- `release_outbox` on Solana takes `outbox: Account<Outbox>` (mut, seeds, `outbox.owner == owner`) and `owner: UncheckedAccount` (mut). `call_handler` appends three accounts: the destination program, the escrow authority, and the escrow PDA, which is a signer. Anchor ignores them as remaining accounts.
- Re-delegating the Outbox on Solana (`delegate_outbox`, wallet pays) works. The rollup sees it within seconds, and a second withdrawal released 0.01 SOL the same way. One withdrawal session costs the wallet 3,138,960 lamports of record and metadata rent at delegation. 2,838,960 comes back at undelegation, so the net is 300,000 lamports plus tx fees. That is about 0.0003 SOL, not the 0.003 SOL the design estimated.

## Payer and escrow requirements

- **Wallet as intent payer:** works. The wallet signs the rollup tx and is not delegated. Nothing was charged in the rollup (`wallet d=0`).
- **Holder PDA as intent payer:** works with `.magic_fee_vault(…)` set to `[b"magic-fee-vault", validator]` under the delegation program (TS `magicFeeVaultPdaFromValidator(identity)`, local `8wdZfgo66d6hMMRrcYBDW2K9WtDe2mEG47ynhnYxrAFp`). The Holder was charged 1,000 lamports, credited to that vault.
  - With the validator fees vault `[b"v-fees-vault", validator]` instead, the call fails: `ScheduleCommit ERR: invalid magic fee vault account`.
  - With the Holder as payer, the Holder is also the escrow authority and is passed writable to the base action. It is still delegated on Solana and is not modified there.
- **Escrow:** none needed. `ActionArgs::new` uses `escrow_index = 255`. In delegation program 1.1.3, `call_handler` requires only that `[b"balance", escrow_authority, 255]` match the derivation and be owned by the system program. A non-existent account passes: `Fu8eQQxU…` signed the action and was still `AccountNotFound` on Solana afterwards. No `top_up_ephemeral_balance` call was needed locally. Whether production validators charge the escrow for action compute was not tested.

## Surprises

1. **A lamport move and the commit-and-undelegate CPI in the same instruction fails.** `withdraw` (mode `single`) fails with `UnbalancedInstruction` ("sum of account balances before and after instruction do not match"). It moved Holder→Outbox and then invoked `ScheduleIntentBundle` for the Outbox in the same instruction. These variants work:
   - Lamport move in one rollup transaction, scheduling in the next (`split`).
   - Lamport move in instruction 1, scheduling in instruction 2 of the same transaction (`sametx`, the shape to copy).
   - Data-only writes to the Outbox before the CPI in the same instruction (`note`).

   Likely cause, not verified: the magic program reassigns the Outbox while it still sees the lamports from before the instruction, so the credit is lost. The main program's `withdraw` should be two instructions: debit and record, then schedule. Alternatively the client sends both in one transaction.
2. **Anchor exit ordering: a typed `Account<Outbox>` written in exit fails.** With `withdraw_typed` (mode `typed`), the in-handler `outbox.amount` assignment is serialized by Anchor after the CPI. The transaction fails with `ExternalAccountDataModified` ("instruction modified data of an account it does not own"), because scheduling undelegation reassigns the Outbox in the rollup immediately. Hand-written data before the CPI is included in the commit: mode `note` released exactly the amount recorded in the scheduling instruction. Keep the Outbox an `UncheckedAccount` in the scheduling instruction and write it by hand before the CPI.
3. **The validator fronts committed lamport increases.** On Solana, the Outbox's +0.02 SOL came from the validator identity's balance in the commit transaction. The Holder's −0.02 SOL (and the top-up's +0.05 SOL) stay rollup-only until the Holder is committed. Production accounting depends on the Player being committed periodically or at close. This was not exercised here.
4. The local stack needs two extra bootstrap steps: initialise and fund the eSPL rent PDA, and run a VRF oracle against the rollup.
5. `solana program deploy` of a default (`v0`) build is rejected by the local base validator. Genesis loading (`--bpf-program`) works and the rollup clones the program from it.

## Decision gate

- (1) passes, so no stop.
- (3) passes, so the post-undelegate action does the release and no client-side release is required. `release_outbox` stays permissionless, so the client can still call it as a fallback (4).
- The plan stands with these amendments:
  - Split the lamport move from the scheduling instruction.
  - Keep the Outbox untyped and write it by hand before the CPI.
  - Delegate with the rollup's identity.
  - Add the eSPL rent PDA and a rollup VRF oracle to `pnpm localnet`.

## Reproduce

```sh
cd spike/outbox
solana-keygen new --no-bip39-passphrase -o target/deploy/spike-keypair.json   # then update declare_id!
cargo-build-sbf --manifest-path programs/spike/Cargo.toml
npm install
./stack.sh &                               # waits for "stack ready"
node run.mjs                               # sametx; also --mode=single|split|note|typed, --holder-pays
```
