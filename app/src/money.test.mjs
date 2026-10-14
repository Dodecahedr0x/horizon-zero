// Checks the SOL amount parser and the error reading the wallet panel uses.
import assert from "node:assert/strict";
import test from "node:test";
import { explain, parseSol } from "./money.ts";

test("parseSol turns SOL text into lamports and refuses anything else", () => {
  const accepted = [
    ["0.1", 100_000_000n],
    ["1.000000001", 1_000_000_001n],
    [".5", 500_000_000n],
    ["5.", 5_000_000_000n],
    ["00.1", 100_000_000n],
    [" 2 ", 2_000_000_000n],
    ["18446744073.709551615", 18_446_744_073_709_551_615n],
  ];
  for (const [text, lamports] of accepted) assert.equal(parseSol(text), lamports, text);
  for (const text of ["1,5", "-1", "", ".", "0", "0.0", "0.0000000001", "1e3", "abc", "18446744073.709551616"]) {
    assert.equal(parseSol(text), null, JSON.stringify(text));
  }
});

test("explain reads pending and recovered results as notices, anything else as an error", () => {
  const pending = Object.assign(new Error("The top-up has not been credited yet."), { name: "PendingError" });
  assert.equal(explain(pending).tone, "pending");
  const recovered = Object.assign(new Error("x"), { name: "RecoveredError", amount: 250_000_000n });
  assert.equal(explain(recovered).tone, "info");
  assert.match(explain(recovered).text, /0\.25 SOL/);
  const program = Object.assign(new Error("Player budget does not cover the battleground stake"), { name: "ProgramError", errorName: "BudgetTooLow" });
  assert.deepEqual(explain(program), { tone: "error", text: "Player budget does not cover the battleground stake" });
  assert.deepEqual(explain("boom"), { tone: "error", text: "failed" });
});
