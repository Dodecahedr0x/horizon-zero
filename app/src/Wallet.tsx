import { useId, useState, type ReactNode } from "react";
import type { PlayerBalance, ProtocolConfig } from "./devChain";
import { parseSol, sol, type Tone } from "./money";

export { explain, parseSol, sol, type Tone } from "./money";

/**
 * One SOL amount field and its button. `max` refuses an amount above it. The field clears once the
 * action is not an error: a pending top-up must not stay filled in and invite a second one.
 */
function AmountAction({ label, action, max, busy, disabledReason, placeholder, onSubmit, children }: {
  label: string;
  action: string;
  max?: bigint;
  busy: boolean;
  disabledReason?: string;
  placeholder?: string;
  onSubmit: (lamports: bigint) => Promise<Tone>;
  children?: ReactNode;
}) {
  const [amount, setAmount] = useState("");
  const id = useId();
  const lamports = parseSol(amount);
  const over = lamports !== null && max !== undefined && lamports > max;
  const hint = !amount.trim() ? "" : lamports === null ? "Enter a positive amount in SOL, at most 9 decimals." : over ? `At most ${sol(max!)} SOL.` : "";
  const described = [hint && `${id}-hint`, children && `${id}-note`].filter(Boolean).join(" ") || undefined;
  return (
    <div className="wallet-action">
      <div className="pot__controls">
        <label className="pot__amount">
          <span className="select__label">{label}</span>
          <input inputMode="decimal" placeholder={placeholder ?? "0.05"} value={amount} disabled={!!disabledReason} aria-invalid={!!hint} aria-describedby={described} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <button type="button" className="hz-button" disabled={busy || !!disabledReason || !lamports || over} title={disabledReason} aria-describedby={described} onClick={() => lamports && onSubmit(lamports).then((tone) => tone !== "error" && setAmount(""))}>{action}</button>
      </div>
      {hint && <p id={`${id}-hint`} className="wallet-action__hint">{hint}</p>}
      {children && <div id={`${id}-note`} className="wallet-action__notes">{children}</div>}
    </div>
  );
}

/** The first-run step: there is no Player yet, so nothing can be staked or created. */
export function CreatePlayer({ busy, fees, onRegister }: { busy: boolean; fees: boolean; onRegister: (lamports: bigint) => Promise<Tone> }) {
  return (
    <div className="pot">
      <p className="panel__note">Your player holds the SOL you fight with. Deposit some to create it; you then move part of it into your stake budget. Behaviors, armies and locks need a player.</p>
      <AmountAction label="Deposit in SOL" action="Create player" busy={busy} placeholder="0.1" onSubmit={onRegister}>
        {fees && <p className="panel__note">Creating the player moves it to the rollup; this can take up to a minute.</p>}
      </AmountAction>
    </div>
  );
}

/** The Player's balances and every way SOL moves in and out of it. */
export function WalletPanel({ player, stake, groundName, busy, fees, onTopUp, onFund, onWithdraw, onRelease, onSegregate }: {
  player: PlayerBalance;
  stake: number;
  groundName: string;
  busy: boolean;
  /** Solana mode: the rollup charges for top-ups and withdrawals. */
  fees: boolean;
  onTopUp: (lamports: bigint) => Promise<Tone>;
  onFund: (lamports: bigint) => Promise<Tone>;
  onWithdraw: (lamports: bigint) => Promise<Tone>;
  onRelease: () => void;
  onSegregate: (segregate: boolean) => void;
}) {
  const free = BigInt(player.free);
  const budget = BigInt(player.budget);
  const winnings = BigInt(player.winnings);
  const pending = BigInt(player.outboxPending);
  const inFlight = player.outboxInFlight || pending > 0n;
  const stakes = stake > 0 ? budget / BigInt(stake) : 0n;
  return (
    <div className="pot">
      <div className="pot__figures">
        <p><span className="select__label">Free</span><strong>{sol(free)} SOL</strong><small>Ready to fund or withdraw</small></p>
        <p><span className="select__label">Budget</span><strong>{sol(budget)} SOL</strong><small>{stakes === 0n ? `Under one ${groundName} stake: no army can lock` : `Covers ${stakes} ${groundName} ${stakes === 1n ? "stake" : "stakes"}`}</small></p>
        <p><span className="select__label">Winnings</span><strong>{sol(winnings)} SOL</strong><small>{player.segregate ? "Set aside, never staked again" : "Set aside; new winnings go to the budget"}</small></p>
        <p><span className="select__label">Locked</span><strong>{sol(player.locked)} SOL</strong><small>Staked in open battles</small></p>
      </div>
      <div className="wallet-actions">
        <AmountAction label="Top up in SOL" action="Top up" busy={busy} onSubmit={onTopUp}>
          {fees && <p className="panel__note">MagicBlock charges 0.0003 SOL per top-up.</p>}
        </AmountAction>
        <AmountAction label="Fund budget in SOL" action="Fund budget" max={free} busy={busy} placeholder={String(sol(String(stake)))} onSubmit={onFund}>
          <p className="panel__note">Your budget must cover one stake to lock an army.</p>
        </AmountAction>
        <AmountAction label="Withdraw in SOL" action="Withdraw" max={free + winnings + budget} busy={busy} disabledReason={inFlight ? "A withdrawal is in flight; release it first" : undefined} onSubmit={onWithdraw}>
          {inFlight ? (
            <div className="wallet-pending" role="status">
              <span>Withdrawal in flight{pending > 0n ? ` · ${sol(pending)} SOL` : ""}</span>
              <button type="button" className="hz-button mini" disabled={busy} onClick={onRelease}>Release pending withdrawal</button>
            </div>
          ) : (
            <p className="panel__note">Takes free SOL first, then winnings, then budget.{fees ? " Each withdrawal costs about 0.0003 SOL in rollup fees." : ""}</p>
          )}
        </AmountAction>
      </div>
      <label className="toggle">
        <input type="checkbox" role="switch" checked={player.segregate} disabled={busy} onChange={(event) => onSegregate(event.target.checked)} />
        <span className="toggle__track" aria-hidden="true" />
        <span>Set winnings aside instead of staking them again</span>
      </label>
    </div>
  );
}

/** Only for the Config admin: the fee rate and the fees it has collected. */
export function AdminPanel({ config, busy, treasury, onSetFee, onClaim, onRelease }: {
  config: ProtocolConfig;
  busy: boolean;
  /** Solana mode: a claim goes through the treasury Outbox and can be left pending. */
  treasury: boolean;
  onSetFee: (bps: number) => Promise<Tone>;
  onClaim: () => void;
  onRelease: () => void;
}) {
  const [text, setText] = useState("");
  const id = useId();
  const bps = /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null;
  const valid = bps !== null && bps <= 1000;
  const fees = BigInt(config.fees);
  return (
    <div className="pot">
      <div className="pot__figures">
        <p><span className="select__label">Fee rate</span><strong>{config.feeBps} bps</strong><small>{config.feeBps / 100}% of both stakes, taken from a win</small></p>
        <p><span className="select__label">Claimable fees</span><strong>{sol(fees)} SOL</strong><small>Paid to the admin wallet</small></p>
      </div>
      <div className="wallet-action">
        <div className="pot__controls">
          <label className="pot__amount">
            <span className="select__label">New fee in bps (0 to 1000)</span>
            <input inputMode="numeric" placeholder={String(config.feeBps)} value={text} aria-invalid={!!text.trim() && !valid} aria-describedby={`${id}-fee-hint ${id}-fee-note`} onChange={(event) => setText(event.target.value)} />
          </label>
          <button type="button" className="hz-button" disabled={busy || !valid} onClick={() => valid && onSetFee(bps!).then((tone) => tone !== "error" && setText(""))}>Set fee</button>
        </div>
        {!!text.trim() && !valid && <p id={`${id}-fee-hint`} className="wallet-action__hint">Enter a whole number from 0 to 1000.</p>}
        <p id={`${id}-fee-note`} className="panel__note">A new rate applies to battles opened afterwards.</p>
      </div>
      <div className="pot__controls">
        <button type="button" className="hz-button hz-button--primary" disabled={busy || fees === 0n} title={fees === 0n ? "No fees to claim yet" : undefined} aria-describedby={fees === 0n ? `${id}-claim-note` : undefined} onClick={onClaim}>Claim fees</button>
        {fees === 0n && <p id={`${id}-claim-note`} className="panel__note">No fees to claim yet.</p>}
        {treasury && <button type="button" className="hz-button mini quiet" disabled={busy} onClick={onRelease}>Release pending claim</button>}
      </div>
    </div>
  );
}
