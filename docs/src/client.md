# Client and dev mode

The app is a Vite React page. `app/src/main.tsx` branches on `import.meta.env.VITE_DEV_MODE === "true"`. Vite reads that variable from the repo-root `.env` and does not override a value already set in the process. `pnpm dev:all` sets `VITE_DEV_MODE=true` on the game process. `pnpm dev` and `pnpm --filter app dev` follow `.env` unless the variable is already set. Both start Vite and the local ledger.

In that mode the root renders `DevApp` only. Wallet adapters, `ConnectionProvider`, and `WalletProvider` are loaded only on the Solana branch, so this page does not load Phantom or Solflare and it never constructs a `Connection`. A "Dev" tag in the header says no Solana node is connected. The header shows the local player's short label. There is no wallet prompt. `installDevSimulate` loads `simulate_json` from `app/src/combat-wasm` before the first render so the page can replay a stored battle. Account reads and writes go to the local ledger over `/api/local`.

Any other value, including unset, uses the Solana shell. It talks to two RPC endpoints, set in `app/src/network.ts`:

| variable | what | unset under `vite dev` | unset in a production build |
| --- | --- | --- | --- |
| `VITE_RPC_URL` | Solana | the local stack, `http://127.0.0.1:8899` | devnet |
| `VITE_ER_RPC_URL` | the MagicBlock ephemeral rollup; its WebSocket is the next port | the local rollup, `http://127.0.0.1:7799` | none: `createSolanaChain` throws until it is set, because it must be the rollup that serves the validator pinned in Config |
| `VITE_ORACLE_QUEUE` | the VRF queue `lock_army` asks; an ephemeral queue, whose oracle calls back into the rollup | the local test queue `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` | MagicBlock's `DEFAULT_EPHEMERAL_QUEUE`, `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |

The local stack does not serve these yet: `pnpm localnet` starts the rollup but does not delegate Config or the battlegrounds, create the eSPL rent PDA, or run a `vrf-oracle` for the ephemeral test queue, and `pnpm dev:chain` still sets `VITE_ORACLE_QUEUE` to the base test queue. Until the local-stack task changes that, the rollup flows below do not complete locally. `pnpm dev:chain` runs the game this way against `pnpm localnet`; see [Networks and deployment](deployment.md). Wallets are Phantom and Solflare. Chain reads and writes go through `createSolanaChain`. The ledger process still listens, and the Solana page does not call it.

## ChainAdapter

`app/src/devChain.ts` defines the surface both backends implement:

| method | role |
| --- | --- |
| `owner` | current player |
| `behaviors` | every behavior the backend knows |
| `battlegrounds` | battlegrounds with queue, grid, and `matchSeq` |
| `armies(owner)` | that owner's armies |
| `createBehavior(elements)` | create the PDA from a sequence of elements |
| `createArmy(battlegroundId, units, race)` | create an army of that race; each unit has `kind`, `behavior`, `col`, `row` |
| `lock(army)` | queue, or open a match |
| `unlock(army)` | leave the queue |
| `closeArmy(army)` | delete an Idle army |
| `player()` | the wallet's Player, `{ free, budget, winnings, locked, segregate, outboxPending, outboxInFlight }` with lamports as decimal strings, or `null` before it registers |
| `register(depositLamports)` | create the Player and Outbox with that deposit free, and delegate both to the rollup; a retry only delegates and never deposits again |
| `topUp(lamports)` | move lamports from the wallet into the Player's free balance |
| `fundBudget(lamports)` | move free lamports into the stake budget |
| `withdraw(lamports)` | pay lamports back to the wallet: free first, then winnings, then budget; if an earlier withdrawal was still waiting, pay that instead and throw `RecoveredError` |
| `releasePending(which)` | pay out what an earlier withdrawal (`"player"`, the default) or fee claim (`"treasury"`) left in its Outbox; `"paid"`, `"none"`, or `"inFlight"` while one is on its way |
| `setSegregation(segregate)` | set winnings aside, or stake them again; one switch for every battleground |
| `settle(match)` | settle a Seeded battle; anyone may |
| `admin()` | Config's `{ admin, feeBps, fees }`, or `null` before `initialize` |
| `claimFees()` | admin only: pay the claimable fees to the admin wallet; recovers an earlier claim like `withdraw` |
| `setFee(bps)` | admin only: change the fee rate for battles opened afterwards |
| `matches(owner)` | that owner's latest battles, newest first |
| `match(pubkey)` | one battle record |

`lock` returns the opened match, or `null` when the army only queued. On Solana the match it returns is already settled when the VRF seed arrived in time (see [Solana chain](#solana-chain)).

`createLocalChain` implements the same surface against the local ledger (see [Player and fees in dev mode](#player-and-fees-in-dev-mode)). There is no Outbox there: `withdraw` and `claimFees` pay at once, `releasePending` always returns `"none"`, and `settle` does nothing, because the ledger settles a battle inside `lock`.

## Walkthrough

The first time the page is connected on a browser (a wallet connects on the Solana shell, or at once in dev mode), `App` opens a walkthrough from `app/src/Walkthrough.tsx`. It has six steps: a welcome, then the behaviors screen with the "Forge a new behavior" button, the muster, the Simulate button, the battle screen's armies, and the battle log. Each step switches to its screen, scrolls its element into view, and rings it in ember while the rest of the page is dimmed. The card sits on the half of the screen away from that element. Next, Back, and the arrow keys move between steps. Skip, Escape, or "Start playing" on the last step close it and store `hz-walkthrough-done` in `localStorage`, so it does not open again on that browser. The flag is per browser, not per wallet. When storage is unavailable the walkthrough opens on every visit. The Guide button in the header reopens it at any time. In dev mode the lock step says that dev mode has a single player, so a locked army waits in the queue, and points at Simulate; on the Solana shell it says the battle opens when a foe locks on the same battleground.

## Screens

Screens are battle, army, and behaviors, in that order, and the page opens on battle.

```mermaid
flowchart LR
  Battle["Battle: arena, battle log, full armies"] -->|Create an army| Army["Army: muster, armies of the league"]
  Army -->|Simulate| Arena["Arena on the battle screen, not stored"]
  Army -->|Save army| Battle
  Battle -->|Lock finds a foe, or Watch| Arena
  Behaviors["Behaviors: list, forge"]
```

### Battle

When a fight is open, the arena sits at the top of the battle screen: the board, playback, the result, both hosts' health, and the chronicle (see [Replay and board](#replay-and-board)). Leave the field closes it. A fight opens from Lock when a match comes back, from Watch in the battle log, or from Simulate on the army screen.

The battle log lists `matches(owner)` in a list of fixed height that scrolls. Each row shows the outcome from the player's side (Victory, Defeat, Draw, or "Awaiting the seed" while the battle is not resolved), the battleground named from its grid, the 2D art of both hosts, and Watch, which replays that match. Watch is disabled while the seed is pending.

Under the log, a battleground picker (Outpost, Garrison, Citadel, each with stake, budget, and grid, and the number of ready armies) selects the league. The battleground picked here is the one the army screen shows. Both pickers, this one and the muster's, also show how many armies are locked in each battleground and waiting for a foe, from every player, for example "2 armies locked": the length of the battleground's queue from `ChainAdapter.battlegrounds()` (the indexer on chain, the local ledger in dev mode). A battleground with waiting armies shows the count in ember with a filled diamond; zero shows in grey. The counts load with the rest of the page and refresh every 15 seconds while the tab is visible. Your own queued armies count too, though locking never matches you with them. Only full armies of that battleground are listed: an army is full when its catalog cost has reached the budget, or no unit of its race still fits in what is left, or it has 10 units (`isFull` in `app/src/armyRules.ts`). The program only checks the budget ceiling, so armies saved before this rule may not be full; the battle screen hides them and says how many wait on the army screen. Each card shows the race, the index, the status, the unit art, and the cost against the budget. Lock (with the stake) is offered on an Idle army and Unlock on a Queued one. Lock is disabled while the battle budget is under one stake. Delete asks to confirm, then sends `closeArmy`; it is disabled unless the army is Idle. Create an army opens the army screen.

After Save, a notice confirms the host is mustered. Lock on an Idle army opens the arena when a match comes back. When it only queues, a notice says the host waits at the gate of that battleground. The arena uses that battleground's `cols` and `rows`, draws blocked tiles from `blocked_json` on the match seed, and places each unit on its deployed tile. One mesh is created per unit. A missing approved GLB stays a colored box. The chronicle and the meshes show moves, attacks, casts, defense, and deaths.

### Army

The army screen opens on the muster, for the battleground selected on either screen. A meter shows catalog cost against the budget, one segment per budget point. Race and Behavior are custom dropdowns (`Select` in `app/src/ui.tsx`, a listbox with arrow keys, Home, End, Enter, and Escape), not native selects. Each behavior option shows its name and its icon strip in a compact size, the same strip as the behavior cards. The Race dropdown lists every catalog race: Ashborn (race 0), Rootborn (race 1), and Deeplings (race 2). The soldier tray holds one button per catalog unit with its approved 2D art (`/assets/units/<race>/<kind>/<kind>.approved.png`, a colour swatch when the file is missing), its cost, hp, atk, range, and speed; a button whose cost would exceed the budget is disabled.

The owner's starting zone is `cols` by 2. Row 0 is the back row and is drawn on top. A click on an empty tile places the selected soldier with the selected behavior. A click on a placed soldier selects it: the soldier tray and the behavior dropdown then show that soldier, picking another soldier type or behavior changes it (a type that would exceed the budget is refused), a click on an empty tile moves it, and a panel offers Remove and Done. A click on the selected soldier deselects it. A placed soldier can also be dragged with a mouse, pen, or finger: past 6 pixels of travel the press becomes a drag, a copy of the soldier follows the pointer, its own tile dims, and the tile under the pointer lights up. Dropping on an empty tile moves the soldier there; dropping on another soldier swaps their tiles; dropping outside the zone leaves the draft unchanged. A drop never also selects or places. Placed tiles set `touch-action: none` so a touch drag does not scroll the page. The drag uses pointer events with pointer capture, not HTML drag and drop, which touch screens lack. The draft holds at most 10 units. One draft is kept per battleground and race, for the session: switching race keeps the army being built and shows the other race's draft, empty at first.

Save army is enabled only when the draft is full. Under the zone, a line says how much budget is left and what the cheapest soldier costs. Simulate against a random army plays the draft, on side A, against an army that `randomArmy` builds for the same battleground: a random race, random units until nothing more fits or 6 stand, each on a random standard behavior and a random distinct tile, and a random seed. It runs through `simulateTrial` and opens in the arena marked as a simulation; nothing is staked or stored. Back to the muster returns to the army screen.

Below the muster, every army of the selected battleground is listed, full or not, with Copy to the muster, which loads its units into the draft (saving makes a new army), and Delete.

### Behaviors

The behavior screen opens on the list of every known behavior. Each card shows the name, one icon strip per element, and, below it, the plain sentence for each element. A strip holds one group for the move, or a lone Stay icon, then one group per action. A group is the move or action icon followed by its target: Lowest or Highest, then Distance, HP, or ATK, then Enemy or Ally. The move or action icon and the side icon are red for an enemy target and green for an ally target. A row of skill filters above the list holds Stay, Approach, Flee, Flank left, Flank right, Attack, and Cast. Selected filters combine with AND: a behavior is shown only when its elements use every selected skill. A button at the top of the list opens the new-behavior page; All behaviors returns to the list, and a successful Create returns to it with a notice. The new-behavior page (`app/src/BehaviorEditor.tsx`) edits a sequence of up to 4 elements, starting from a standard picked from a row of presets. Every choice is a radio group drawn as icon buttons, not a dropdown. Move is Stay, Approach, Flee, Flank left, or Flank right; Stay means no movement. A move then picks its target with three short groups, Lowest or Highest, then Distance, HP, or ATK, then Enemy or Ally, and a switch for "Stop once an action lands". Each element holds up to 3 actions, each Attack or Cast with the same three target groups. Under a Cast, a note says that each soldier's cast knows whom it lands on (a foe, an ally, or itself), that the target groups only pick among those, and that a cast never wastes itself on a unit it would not change. A new movement or action starts on Lowest, Distance, Enemy. Each element shows a plain sentence for what it does, for example "Approach the nearest enemy, halting once an action lands, then attack the nearest enemy." Create sends the encoded body. A failed Create, such as a body that already exists, stays on the page with the error. Every behavior label in the game, on chain and in dev mode, comes from `nameBehavior` in `content/interpret.mjs` and is at most `MAX_BEHAVIOR_NAME_LEN` (32) characters. A body that matches a standard gets the standard's name. Any other body gets a short summary, one phrase per element joined with " · ": the move, then its actions' verbs. A target is named only when it is not the nearest enemy, and only once when the move and the actions share it. The stop switch is left out of the name, and an empty element reads "Wait". For example, "Approach, attack · Wait" or "Flank right, attack weakest foe". A longer summary, or a stored name over the limit, is cut at a word and ends in "…". The card title's tooltip and the plain sentences under it give the full reading.

Simulate, above Create, opens a trial sheet. It runs the draft through `simulate_json` (`simulateTrial` in `app/src/replay.ts`) on an 8×6 board: one unit, picked from every race's units (Ashborn's five, Rootborn's three, then the Deeplings' four; the Ashborn Skirmisher first), at zone-local `(3, 0)` on side A follows the draft (the sheet states that unit's cast in one line, for example "Skirmisher cast. Doubles its movement for 1 round."), and an Ashborn Warden training dummy, whatever the soldier's race, at `(4, 0)` on side B has the body for one element with no movement and no actions. The engine still has a unit defend when it has an action point left, so the dummy may defend, but it never moves or acts. The first field is a seed whose blocked tiles avoid columns 3 and 4, found by trying up to 24 random seeds; New field draws any random seed, so obstacles can appear. The sheet shows the same board, playback, speed, and sound as the battle screen, both health bars, a chronicle that names the foe "the training dummy", and, when the trace ends, a line with the damage dealt and the rounds taken, or a hint that no blow landed. Escape, Close, or a tap on the backdrop closes it.

## Local ledger

`app/local-ledger.mjs` is the dev-mode backend, started next to Vite by `scripts/dev-app.mjs`. It uses `node:sqlite`. `scripts/load-root-env.mjs` loads the repo-root `.env` and keeps any variable already set in the process. The SQLite file is `LOCAL_LEDGER_PATH`, or `data/local-ledger.db` under the repo root when that variable is unset. Relative paths resolve from the repo root. The file is gitignored. It is a different database from the Carbon indexer's `DATABASE_PATH`, and the process refuses to open that path or `/var/data/horizon.db`.

The process listens on `127.0.0.1` and `LOCAL_LEDGER_PORT`, or port `4713`. Vite stays on `4710` and proxies `/api/local` to the ledger. That port stays off the indexer (`4714`) and the asset studio (`4712`). The browser talks only to the Vite origin. Refreshing the page, restarting Vite, and restarting the ledger all keep the same file.

The first open stores one local user and one practice opponent. Each has its own id. The user id is not a wallet pubkey. The page shows that user's short label, `local` plus four hex characters. Practice armies are rows in the same file, owned by the practice id, so they are not listed as the user's armies.

On that first open the ledger reads `content/catalog.json`. A missing file stops startup. It inserts the three catalog battlegrounds when their ids are missing, and the standard behaviors from that file when their hashes are missing. There is no second copy of those behaviors in the client. A later open replaces a stored row whose name is one of those standards when its hash differs, and deletes a row named Volley. A unit whose behavior id is gone is pointed at March when that id was Volley or a walk body, and at the replacement of the same name when the old body was a standard such as Charge. An Idle army that is no longer full under the current catalog (over budget, a kind that is gone, or budget left that a soldier would fit) is deleted on open, since it can never be locked; armies saved before armies had to be full are dropped this way. Every other army's stored unit stats (cost, hp, atk, range, speed, actions, cast) are rewritten from the catalog on open. A stored match body that is one of the old standard byte strings is rewritten the same way. Behaviors are keyed by the same hash the behavior PDA uses. Names are only for the UI. A new behavior is stored under its `nameBehavior` name, and each open renames any stored non-standard row whose body still encodes to that name, which shortens rows stored under the old full description. New armies are Idle Ashborn and use the next index. Unit stats in dev mode come from the same file. The program still checks stats with `stats_for`, which stays a `match`.

The standards in the file all target enemies. They are:

| name | body |
| --- | --- |
| March | approach lowest distance, attack lowest distance, stop if an action fires |
| Charge | the same approach and attack, continue after an action |
| Kite | March's element, then flee lowest distance with no action |
| Flank left | flank left lowest distance, attack highest ATK, continue |
| Flank right | flank right lowest distance, attack highest ATK, continue |
| March cast | March, casting first and attacking when the cast would change nothing |
| Charge cast | Charge, casting first, then attacking |
| Kite cast | Kite, casting first, then attacking, on the first element; the second element still flees |
| Flank left cast | Flank left, casting first, then attacking |
| Flank right cast | Flank right, casting first, then attacking |

Every standard attacks or casts. A cast variant's element lists the cast and then an attack with the same target rule; with one action point the cast fires when it would change something (see [Casts](battle.md#casts)) and the attack fires otherwise, so a Skirmisher whose sprint is still running, or a Warden with nobody hurt, still strikes.

Every movement spends the whole movement pool. There is no walk mode. March, Kite, and their cast variants use `stop` `1`. Charge, both flanks, and their cast variants use `stop` `0`.

`createBehavior` rejects a duplicate hash, including a second create of one of those standards. `createArmy` rejects an empty roster, more than 10 units, a position outside the owner's zone, a repeated tile, an unknown behavior, and a cost above the battleground budget. Dev mode does not open a Solana socket.

`lock` fails with `BudgetTooLow` while the local user has no Player or its budget is under one stake. It then walks the queue as `lock_army` does (see [Matchmaking](matchmaking.md#stakes)): another owner's queued army is a candidate while that owner's budget covers a stake, and is evicted, Idle and out of the queue, once it does not. The ledger knows every Player, so every such army is evicted, not only those a locker passes. `lock` with no candidate sets Queued and moves nothing. Otherwise it picks `crypto.getRandomValues` modulo the candidate count, draws a fresh 32-byte seed, and resolves through `simulate_json` in `app/src/combat-node`. The match row stores the seed, the outcome, the unit snapshots, and the trace. Both Players move one stake from `budget` to `locked`, and the battle settles in the same call with the rules of `settle_match` (see [Player and fees in dev mode](#player-and-fees-in-dev-mode)). Both armies return to Idle, the opponent leaves the queue, and the match is stored already Resolved. This path does not read a slot hash, does not call the VRF program, and charges no battle rent. The page replays that seed with `app/src/combat-wasm`.

`unlock` on a Queued army returns it to Idle. An Idle army is not queued, so unlock is rejected. An army still marked Fighting is rejected with "A matched army cannot unlock".

`DELETE /armies/:pubkey` is `close_army`: only the local user's own army, only while Idle. A missing army is a 404. The row is deleted; matches keep their snapshots.

`GET /matches?player=` returns the 20 latest matches where that id is player A or B, newest first. A match key is `match-<battleground id>-<seq>`, because `seq` counts per battleground.

`POST /practice` queues a Guard with March at zone-local `(0, 0)`, owned by the practice id, and tops the practice Player's budget up to one stake, adding the lamports to back it, so the local user has someone to match. The page no longer calls it; the ledger test does. The adapters have no practice method.

### Player and fees in dev mode

The ledger mirrors the program's [Player](accounts.md#player--68-bytes) and Config in two tables. `players` has one row per owner: `balance` (the Player's lamports, as a decimal string; dev mode charges no rent, so there is no rent floor), `budget`, `winnings`, `locked`, `segregate` and `fighting`. `free` is `balance - budget - winnings - locked`. `config` has one row: `admin`, `fee_bps` (500 on first open) and `fees`. The local user is the dev admin; it is the only identity that signs in dev mode, and the first open writes its id into `config.admin`. Older ledger files had a `pots` table, one pot per player and battleground; each open drops it, so pot balances from before are gone.

- `register` creates the row with the deposit free, and fails with `AlreadyExists` when the row exists. `topUp` adds to `balance`. Both, `fundBudget`, `withdraw` and `setSegregation` fail with `MissingAccount` before `register`.
- `fundBudget` moves free lamports into the budget, or fails with `BalanceShort`.
- `withdraw` takes free lamports first, then winnings, then budget, never `locked`, and pays at once: there is no Outbox, so `player()` always reports `outboxPending` `"0"` and `outboxInFlight` false. It fails with `NothingToWithdraw` for 0 and `BalanceShort` beyond what those three hold.
- Settlement uses `winPayout`, a port of `fees::win_payout`: on a win the loser's `balance` drops by the stake, the winner's grows by `stake - fee`, and the winner's budget, or winnings with segregation on, grows by `2 * stake - fee`, where `fee = 2 * stake * fee_bps / 10_000` rounded down; `config.fees` grows by `fee`. A draw returns each stake to its budget and takes no fee. Both Players then drop `locked` by the stake and `fighting` by one.
- `setFee` and `claimFees` fail with `NotAdmin` for anyone but `config.admin`. `setFee` fails with `FeeTooHigh` above 1000. `claimFees` sets `fees` to 0, or fails with `NothingToWithdraw` when it is already 0.

### Ledger routes

The ledger and the Vite proxy both use the `/api/local` prefix. A failed call returns JSON `{ error }` and status 400. A rule the program also enforces fails with the program's `HorizonError` message, and the body adds its name, `{ error, name }`; `createLocalChain` throws an `Error` that carries `errorName` and the Anchor `code`, like `ProgramError` on Solana.

| method | path | result |
| --- | --- | --- |
| `GET` | `/api/local/owner` | `{ owner, label }` for the stored local user |
| `GET` | `/api/local/behaviors` | every behavior |
| `POST` | `/api/local/behaviors` | body `{ elements }` |
| `GET` | `/api/local/battlegrounds` | catalog rows with queue and `matchSeq` |
| `GET` | `/api/local/armies?owner=` | that owner's armies |
| `POST` | `/api/local/armies` | body `{ battlegroundId, units }` |
| `POST` | `/api/local/armies/:pubkey/lock` | the opened match, or `null` when the army only queued |
| `POST` | `/api/local/armies/:pubkey/unlock` | empty object |
| `POST` | `/api/local/practice` | body `{ battlegroundId }` |
| `GET` | `/api/local/player` | the local user's `PlayerBalance`, or `null` before `register` |
| `POST` | `/api/local/player/register` | body `{ lamports }` (decimal string); the Player |
| `POST` | `/api/local/player/top-up` | body `{ lamports }`; the Player |
| `POST` | `/api/local/player/budget` | body `{ lamports }`, free into budget; the Player |
| `POST` | `/api/local/player/withdraw` | body `{ lamports }`; the Player |
| `POST` | `/api/local/player/segregation` | body `{ segregate }`; the Player |
| `GET` | `/api/local/config` | `{ admin, feeBps, fees }` |
| `POST` | `/api/local/config/fee` | body `{ bps }`, admin only; the config |
| `POST` | `/api/local/config/claim` | admin only; the config with `fees` 0 |
| `DELETE` | `/api/local/armies/:pubkey` | empty object |
| `GET` | `/api/local/matches?player=` | that player's latest 20 battles |
| `GET` | `/api/local/matches/:pubkey` | one battle, or `null` |

## Solana chain

`createSolanaChain` keeps two `Connection`s at `confirmed`: `base` for Solana and `er` for the rollup. It throws when `VITE_ER_RPC_URL` is unset in a production build; `app/src/solanaEntry.tsx` catches that and renders the message instead of a blank page.

Every write is a legacy transaction sent to one of the two connections. The client fetches the blockhash from that connection, has the wallet sign with `signTransaction`, and sends the raw transaction through that same connection. It does not use the wallet's own send, which would send a rollup transaction to Solana; a wallet without `signTransaction` can only send to Solana. If the send fails with "Blockhash not found", for instance because a rollup blockhash expired while the wallet waited for approval, the client fetches a new blockhash, signs and sends once more. It confirms on both connections by polling `getSignatureStatuses` with `searchTransactionHistory` every half second for up to 60 seconds, not by the block-height strategy, since rollup blockhashes are short-lived. Each poll first asks `isBlockhashValid` for the transaction's blockhash, then reads the status. Only when two polls in a row found the blockhash invalid and the status read made after that check still empty does the client throw a plain error saying the transaction expired and nothing changed; a transaction that landed is never declared dead. If `isBlockhashValid` fails or is not supported, the client keeps polling and ends with `PendingError` at the deadline. **Blocker for the local-stack task:** the re-send, the status polling and `isBlockhashValid` must be checked against a real rollup. If the rollup answers `isBlockhashValid` with false for fresh blockhashes, every unconfirmed send would be reported as expired.

Errors the UI can tell apart, exported from `app/src/solanaChain.ts`:

- `ProgramError`, with `code`, `errorName` and the program's message, when a transaction fails with one of this program's codes. `horizonErrorCode` in `app/src/codec.ts` reads the code from logs only: the innermost `Program <id> failed: custom program error` line must name this program. For a preflight failure the logs come with the RPC error; for a confirmed status error the client fetches them with `getTransaction` from the same connection. Without logs, or when the innermost failure is another program's (compute budget, system, VRF), the error is rethrown raw; the client never maps a code by the top-level instruction index alone. `PROGRAM_ERRORS` maps `6000 + i` to the `i`th `HorizonError` variant in `programs/horizon-zero/src/error.rs`, and a test checks the names, messages and count against that file.
- `RecoveredError`, with the `amount`, when `withdraw` or `claimFees` found an earlier amount still waiting in the Outbox and paid that instead of starting a new one.
- `PendingError`, with the signature when there is one, when the work was sent but has not finished: a transaction not confirmed in time, a top-up the rollup has not credited, a delegation the rollup has not picked up, a withdrawal still on its way. It may still land, so the UI should show it as pending and not resend blindly.

Any other error, such as a wallet rejection, is thrown unchanged.

Where each instruction goes:

| connection | instructions |
| --- | --- |
| Solana | `register_player`, `delegate_player`, `delegate_outbox`, `delegate_treasury_outbox`, `release_outbox`, the eSPL top-up |
| rollup | `create_behavior`, `create_army`, `lock_army`, `unlock_army`, `close_army`, `fund_budget`, `set_segregation`, `fund_outbox` + `withdraw`, `settle_match`, `set_fee`, `fund_treasury_outbox` + `claim_fees` |

`app/src/codec.ts` builds each instruction with the account order in [Accounts and instructions](accounts.md). The delegate instructions derive the delegation buffer, record and metadata with the `@magicblock-labs/ephemeral-rollups-sdk` helpers (0.17.3, the version the spike used). Instructions that create or close an ephemeral account pass the vault and the magic program; `withdraw` and `claim_fees` pass the magic context and the magic program. `app/src/codec.test.mjs` checks each builder's discriminator, data and account order, and the decoders' offsets and length checks.

Reads (every polling wait, for a confirmation, a delegation, a seed or a release, logs a failed read with `console.debug` and tries again until its deadline, so a read that keeps failing ends as a timeout):

- `behaviors` and `matches(owner)` come from the indexer, through `fetch("/api...")`, which the static server proxies to it (see [Indexer and Render](indexer.md)). `matches(owner)` keeps the first 20 rows where the owner is player A or B.
- `battlegrounds` lists the indexer's rows and replaces each queue and `matchSeq` with the battleground account read in the rollup.
- `armies(owner)` lists the indexer's rows, reads each army in the rollup, drops those it no longer finds there, and takes the owner, battleground and status from the rollup, so a closed or newly queued army shows at once.
- `match(pubkey)` reads the indexer and falls back to the battle account in the rollup.
- `player()` reads the Player in the rollup. `free` is its lamports minus the rent-exempt minimum for 68 bytes (read once from Solana, read again if that read failed) and `budget + winnings + locked`. `outboxPending` is the amount that has left the Player but has not reached the wallet: the Outbox's `amount` on Solana while it is undelegated there (waiting for `release_outbox`), or the rollup copy's `amount` while it is delegated (a `fund_outbox` whose `withdraw` did not land, or a withdrawal on its way). `outboxInFlight` is true while the Outbox is delegated on Solana and the delegation program's in the rollup: a withdrawal being committed and undelegated. `player()` only reads. A pending amount that is not in flight is paid by `releasePending()`, or by the next `withdraw`, which pays it instead of starting a new withdrawal.
- `admin()` reads Config in the rollup.

`createArmy` starts at the next index above any army the indexer lists for this wallet, then skips indexes whose army PDA already exists in the rollup, so an army the indexer has not listed yet is not collided with. It checks at most 64 indexes and then throws, saying the indexer is far behind.

### Registration and top-up

`register(deposit)` sends one Solana transaction: `register_player(deposit)`, `delegate_player` and `delegate_outbox`. A retry after a partial registration sends only the missing delegations and never deposits again; the player tops up an existing Player with `topUp`. It then polls the rollup for up to 60 seconds, counted after the transaction confirms, until it sees the Player owned by the program, and the Outbox too when it was delegated now or already is; an Outbox left undelegated with an unpaid amount stays on Solana until `releasePending` or `withdraw` pays it. It throws `PendingError` if the rollup does not show them in time.

`topUp(lamports)` first waits, for up to 60 seconds, until the rollup holds the delegated Player, and throws if it does not. It then sends the SDK's `lamportsDelegatedTransferIx(wallet, player, lamports, salt)` to Solana with a random 32-byte salt, then waits until the rollup shows the Player's lamports grown past what it read before, and throws `PendingError` if they have not grown in 60 seconds. The wallet pays the amount plus 300 000 lamports and the fee (see [Money in and out](matchmaking.md#money-in-and-out)).

### Lock and settle

`lock(army)` reads the battleground in the rollup for its queue and `match_seq`, and reads each queued army there. It offers, in queue order, every queued army whose status is Queued and whose owner is another wallet, each with its owner's Player once, so the program can match a funded owner and evict one whose budget no longer covers a stake. It stops adding candidates when the transaction would pass 32 accounts. It sends a compute budget of `1_400_000` and `lock_army` with the player's Player, Config, the battle `[b"match", battleground, match_seq]`, the vault and the magic program, the oracle queue, and the army's distinct behaviors. If the program answers `BadMatch`, another lock opened a match after the read; the client reads the battleground again and sends once more.

If the battle account then exists in the rollup, a match opened. The client polls it every half second until it is Seeded (status 2), for up to 60 seconds, then sends `settle_match` and reads the outcome from the transaction's `HZ_MATCH_RESOLVED` log. `lock` returns the battle decoded from the rollup with that outcome and status 1. The outcome is unknown when someone else settled first (the battle is gone, or `settle_match` fails with `AlreadyResolved`) or when the log line cannot be read; `lock` then returns the indexer's row for the battle, or, before the indexer has it, the last decoded state with status 1 and outcome 0 (pending). If the seed has not arrived in time, `lock` returns the battle still Awaiting, and `settle(match)` can settle it later. `settle` treats `AlreadyResolved` as settled and throws `NotSeeded`, and any other error, unchanged.

### Withdrawal and fee claim

```mermaid
flowchart TD
  Start["withdraw(amount)"] --> State{"Outbox state"}
  State -->|"delegated on Solana, the delegation program's in the rollup"| InFlight["PendingError: a withdrawal is on its way"]
  State -->|"delegated on Solana, no copy in the rollup"| Unseen["PendingError: the rollup has not picked it up"]
  State -->|"owned by horizon-zero on Solana, amount > 0"| Release["Solana tx: release_outbox alone"]
  State -->|"delegated, the rollup copy holds an amount"| Flush["rollup tx: withdraw alone; await its release"]
  Release --> Recovered["RecoveredError: the earlier amount was paid; nothing more withdrawn"]
  Flush --> Recovered
  State -->|"owned by horizon-zero on Solana, amount 0"| Check
  State -->|"delegated, empty in the rollup"| Check{"0 < amount <= free + winnings + budget"}
  Check -->|no| Refuse["throw, nothing sent"]
  Check -->|"yes, undelegated"| Delegate["Solana tx: delegate_outbox;<br/>wait up to 60 s for the rollup (PendingError otherwise)"]
  Delegate --> Send
  Check -->|"yes, ready"| Send["rollup tx: fund_outbox(amount), withdraw"]
  Send --> Back["poll Solana up to 30 s until the Outbox is the program's again (PendingError otherwise)"]
  Back --> Action["poll up to 5 s for the action to pay;<br/>release_outbox only if it has not"]
```

`withdraw(amount)` reads the Outbox first:

- Delegated on Solana and the delegation program's in the rollup: an earlier withdrawal is being committed and undelegated. It throws `PendingError` and sends nothing.
- Delegated on Solana with no copy in the rollup: the rollup has not picked up the Outbox yet. It throws `PendingError` with that message and sends nothing.
- Owned by the program on Solana with an `amount`: an earlier withdrawal came back but `release_outbox` has not paid it. It sends `release_outbox` alone on Solana and throws `RecoveredError`.
- Delegated with an amount in the rollup: an earlier `fund_outbox` whose `withdraw` never ran. It sends `withdraw` alone, waits for the release as below, and throws `RecoveredError`.
- Owned by the program on Solana and empty, or delegated and empty in the rollup: a new withdrawal may start.

So a retry after a withdrawal that landed, while that withdrawal is still in flight or unpaid, pays nothing twice. A retry after the first withdrawal has fully settled is a new withdrawal; the UI should gate on `outboxPending` and `outboxInFlight` from `player()`.

Only then does `withdraw` refuse an amount of 0 or more than `free + winnings + budget`. An undelegated Outbox is delegated with `delegate_outbox` on Solana, and the client waits up to 60 seconds, counted after that transaction confirms, until the rollup shows it delegated and empty. It then sends one rollup transaction with `fund_outbox(amount)` and `withdraw`. It polls Solana for up to 30 seconds until the Outbox is owned by the program again, then up to 5 seconds for the post-undelegate action to set `amount` to 0, and sends `release_outbox` itself only if it has not. An Outbox that has not come back in 30 seconds throws `PendingError`. Each withdrawal that needs `delegate_outbox` costs the wallet about 300 000 lamports of delegation rent that does not come back, plus fees.

`releasePending()` runs only the recovery: `release_outbox` alone for an undelegated Outbox holding an amount, or `withdraw` alone and the release wait for a delegated one holding an amount. It returns `"paid"` when it paid something, `"inFlight"` while a withdrawal is being committed and undelegated or the rollup has not picked up the Outbox, and `"none"` when there was nothing to pay. It throws when the Outbox does not exist, as `withdraw` does, and throws `PendingError` only when a wait times out. It needs no Player balance, so a wallet whose Player is empty can still recover. `releasePending("treasury")` does the same for the treasury Outbox with `claim_fees`.

`claimFees()` is the same flow for the treasury Outbox `[b"outbox", config]`: the same recovery with `claim_fees` and `RecoveredError`, then a refusal when Config's `fees` is 0, then `delegate_treasury_outbox` when needed, and `fund_treasury_outbox` + `claim_fees` in the rollup transaction. A missing treasury Outbox throws a message saying `init_treasury_outbox` has not run. `setFee(bps)` sends `set_fee` to the rollup.

## Replay and board

`replay` in `app/src/replay.ts` feeds `cols`, `rows`, the match snapshots (including the canonical `body`, zone-local `col` and `row`, and the stored stats and cast), and the hex seed to `simulate_json` and returns the trace lines. The board scene lives in `app/src/board-view.js`. `app/src/board.tsx` asks `blocked_json` for the rubble and mounts that module. The asset studio Battle tab mounts the same module, so the game and the studio share one scene, one unit-mesh loader, and one trace stepper. Side A is placed at `(col, row)` and side B at `(col, rows - 1 - row)`. Each unit model is scaled to 0.95 tile tall from its bounding box and lifted so its lowest point sits on the tile top, which suits both centred meshes and rigs whose origin is at the feet. Unit materials use a lighter three-band toon ramp than the tiles and a warm emissive base (`#3b2a1c`) so figures read against the dark stone, which a hit flash returns to; they get a 0.012-unit ink hull; a skinned mesh gets a skinned hull bound to the same skeleton, so the outline bends with it. Side A faces +Z and side B is turned around, so the two hosts face each other. A unit turns toward the tile it moves to and toward the target it strikes. Clips are found by name: `idle` or a name with stance, `run`, `attack`, `cast`, `defend` or one with block or parry, `hit` or hurt, and `death` or one with dead, dying, or die. A rigged unit plays its idle loop at natural speed whenever it rests, starting at a random point so units do not breathe in step. Clips cross-fade over 0.12 s.

A step lasts 320 ms for `M`, 700 ms for `A`, 760 ms for `C`, 420 ms for `F`, 760 ms for `D`, 360 ms for `X`, and 200 ms for other lines, times 1.45, 1, or 0.55 at speed 1, 2, or 3. `setStepMs` overrides that with one fixed duration. A run clip plays about two cycles per step. A one-shot clip plays at most 3× its natural speed; when it is longer than that allows, its middle stretch plays. While a step plays, a move plays Run (or, without that clip, a bob and a short stride), an attack plays Attack (or lunges toward the target and back), a cast plays Cast (or rises and stretches), each unit that takes damage then plays Hit (or flinches with a knock-back tilt), `F` plays Defend, and `D` plays Death (or sinks). The unit returns to idle when the step ends, a cast still moves a pushed unit to its new tile, defend still scales the defender, death still hides the mesh at the end of its step, and seeking snaps to those resting positions. `data-unit-clips` on the board element lists each fighter's current clip as `side:index:clip`. A cast line with `rounds` above 0 puts a thin aura ring outside the unit's side ring, gold for sprint, sky blue for reach, red for taunt; its `X` line, the unit's death, or a seek back removes it, and the remaining rings close up. `data-unit-statuses` lists the units with a status as `side:index:effect,effect`, with effect names (`sprint`, `reach`, `taunt`). A round line `R` and the end line do not move a mesh. `E draw limit` is a draw because the 12-round cap was reached. Play, pause, and speed on the battle screen call that stepper. Step back seeks by replaying the same lines from deployment.

Each unit loads `/assets/units/<race>/<kind>/<kind>.approved.glb`. `<race>` is the catalog slug (`ashborn` for race 0, `rootborn` for race 1, `deeplings` for race 2), and `<kind>` is the lowercased unit name. A 404 becomes a colored box. The floor loads `/assets/board/tile/tile.approved.glb` and blocked tiles load `/assets/board/rubble/rubble.approved.glb`. Each is baked to one grid square, 0.96 wide with its origin at the bottom centre. Every floor tile that is not blocked is one instance of a single `InstancedMesh`, so the whole floor is one draw call (plus one for its ink hull). The top face sits at y 0.04, where units stand. Each tile turns by a quarter turn picked from a hash of its column and row, so the cracks do not repeat. Each blocked tile gets a rubble piece standing on the same ground, also turned by that hash. Until those files load, and if either is missing, the board draws plain boxes in their place. `data-terrain` on the board element reads `tile:<state> rubble:<state>` with `loading`, `glb`, `box`, or `none`.

The board is drawn cel-shaded. Tiles and units use `MeshToonMaterial` with a three-step light ramp, and both get an inverted-hull ink outline (the fallback boxes get ink edge lines). The tile tint multiplies its stone texture: the player's zone rows are ember, the opponent's cold steel, and the rows between a light and dark checker. Each unit stands on a ring: ember for the player's side and cold steel for the opponent's, as on the landing page. The player's side is the one whose army they locked (`armyA` is side 0). The canvas height is 80% of its width, clamped to 280–520px.

When a step lands, the board shows feedback in an overlay above the canvas. Each `A` line, and each `C` line that dealt damage, pops the damage over the victim (gold when the victim is the opponent's, red when it is the player's) and the victim flashes white for 140 ms. A `C` line that dealt none pops its effect instead: `+N` in green for a heal, `Sprint` or `+N reach` in sky blue, `Taunted` in gold, `Pushed` for a push that moved, and `0` otherwise, as for an attack that did not get through. `X` pops `Sprint fades`, `Reach fades`, or `Taunt fades` over the unit. Every fighter has its own copy of its materials so the flash stays on that unit. `F` pops `Defend`. A hit of 3 or more and every `D` shake the camera briefly; the shake is skipped when the system asks for reduced motion. The popups and the shake run on the board's frame clock, so they pause with playback. `createBoardView` takes an optional `onImpact` callback that receives `{kind, damage, mine, line}` for `hit`, `cast`, `miss`, `defend`, and `death`. The game plays a synthesized sound for each (`app/src/sfx.ts`, Web Audio, no files) and a short cue for victory, defeat, or draw. A Sound on/off toggle on the battle screen is kept in `localStorage` under `hz-sound`. The asset studio passes no callback and plays no sound.

The battle screen has Play, Pause, and Resume, a 1×, 2×, 3× speed group, and Skip to the end, which seeks to the last line. The chronicle names each line in words from the player's side, for example `Your Vanguard strikes the foe's Skirmisher · 12 (2 HP left)`. A cast reads by its effect: `Your Guard shoves the foe's Vanguard · 9 (13 HP left) · pushed to 3,5`, `Your Skirmisher sprints · 2× movement this round`, `Your Archer lengthens its reach · +2 range for 3 rounds`, `Your Vanguard taunts the foe's Archer · it must close in for 2 rounds`, `Your Warden heals your Guard · +5 (14 HP)`. `X` reads `Your Archer: longer reach fades`. It marks `R` as `End of round N`, and keeps the line just played in view inside the list.

The board reports how many trace lines it has played. The battle screen uses that count to show one health bar per fighter: it starts from the snapshot `hp`, takes the target hp from `A` and `C` lines, and sets 0 on `D`. When every line has played, playback stops and a result panel reads Victory, Defeat, or Draw from the match `outcome` seen from the player's side, in ember, cold steel, or bone. It lists the player's units still standing with their hp and the stake; after a simulation it offers Back to the muster instead of the stake. Watch again in the controls seeks to 0 and plays.

## Look

The game wears the landing page's look: ash-black ground with an ember glow at the top, bone text, ember for action and for the player's side, cold steel for the foe, thin lines instead of outlines, Grenze Gotisch for headings and Alegreya Sans for text (Google Fonts in `app/index.html`). Primary buttons are slanted ember plates as on the landing page. `app/src/styles.css` holds every token and component, keeping the `hz-*` class names. The game no longer loads `app/src/theme.css`; the asset studio still does. On phones the screen tabs are a bar fixed to the bottom of the viewport. From 800px they sit in the header.

Unit `color` values come from each unit's `color` in `content/catalog.json` (`#rrggbb`) and are the design system's unit swatches; `app/src/codec.ts`, the board, and the studio all read them there, and the studio's Save keeps them. They tint the 3D fallback box, the 2D art's fallback swatch, filled zone tiles, and the survivor chips.
