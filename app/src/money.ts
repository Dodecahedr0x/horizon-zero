// Lamport amounts and how a failed call reads on the page. Kept free of JSX and imports so a plain
// node test can load it (app/src/money.test.mjs).

const U64_MAX = 18_446_744_073_709_551_615n;

export function sol(lamports: string | bigint) {
  return Number(lamports) / 1e9;
}

/**
 * "0.25" SOL as lamports, or null when it is not a positive amount with at most 9 decimals that fits
 * in a u64. Digits and one dot only: no sign, comma or exponent.
 */
export function parseSol(text: string) {
  const match = text.trim().match(/^(\d*)(?:\.(\d{0,9}))?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const lamports = BigInt(match[1] || "0") * 1_000_000_000n + BigInt((match[2] || "").padEnd(9, "0"));
  return lamports > 0n && lamports <= U64_MAX ? lamports : null;
}

export type Tone = "success" | "error" | "pending" | "info";
export type Outcome = { tone: Exclude<Tone, "success">; text: string };

/**
 * How a failed call reads on the page. The Solana adapter's `PendingError` (sent, may still land) and
 * `RecoveredError` (an earlier payout was paid instead) are not failures; they are matched by `name`
 * so dev mode never loads that module. A `ProgramError` already carries the program's message.
 */
export function explain(err: unknown): Outcome {
  if (err instanceof Error && err.name === "PendingError") {
    return { tone: "pending", text: `Still on its way: ${err.message} Check your balance before trying again.` };
  }
  if (err instanceof Error && err.name === "RecoveredError") {
    const amount = (err as Error & { amount?: bigint }).amount;
    return { tone: "info", text: `An earlier payout${amount !== undefined ? ` of ${sol(amount)} SOL` : ""} was waiting and has been paid to your wallet. Nothing more was sent; try again if you meant to.` };
  }
  return { tone: "error", text: err instanceof Error && err.message ? err.message : "failed" };
}
