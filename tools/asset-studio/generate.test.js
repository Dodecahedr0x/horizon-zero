import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writePrompt } from "./prompts.js";
import { agentImageArgs, agentTextArgs, assertProvider, codexImageArgs, codexTextArgs, newestPng, promptFromCliOutput, savedPngFromOutput, textRewriteInstruction, withoutApiKey } from "./generate.js";

test("codex argv uses the exec command and omits the python image script", () => {
  const spec = codexImageArgs({
    promptFile: "/tmp/hz-asset/prompt.md",
    out: "/tmp/leaf/guard.png",
    cwd: "/repo",
    tempDir: "/tmp/hz-asset",
  });
  assert.equal(spec.command, "codex");
  assert.deepEqual(spec.args.slice(0, 11), [
    "exec",
    "--json",
    "--color",
    "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "--approve-for-me",
    "--cd",
    "/repo",
    "--add-dir",
    "/tmp/hz-asset",
  ]);
  assert.equal(spec.args.includes("--sandbox"), false);
  assert.equal(spec.args.includes("--approve-for-me") && spec.args.includes("--sandbox"), false);
  const joined = spec.args.join("\n");
  assert.equal(joined.includes("image_gen.py"), false);
  assert.equal(joined.includes("OPENAI_API_KEY"), false);
  assert.equal(joined.includes("api.openai.com"), false);
  assert.equal(joined.includes("/tmp/hz-asset/prompt.md"), true);
  assert.equal(joined.includes("/tmp/leaf/guard.png"), true);
  assert.equal(spec.args.some((arg) => arg.includes("python")), false);
});

test("a requested provider is used as given", () => {
  assert.equal(assertProvider("agent"), "agent");
  assert.equal(assertProvider("codex"), "codex");
  assert.throws(() => assertProvider("python"), /unknown image provider/);
});

test("spawn env drops OPENAI_API_KEY", () => {
  const env = withoutApiKey({ OPENAI_API_KEY: "sk-test", PATH: "/usr/bin" });
  assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false);
  assert.equal(env.PATH, "/usr/bin");
});

test("agent argv stays on the agent cli", () => {
  const spec = agentImageArgs({ out: "/tmp/leaf/guard.png", promptText: "guard" });
  assert.equal(spec.command, "agent");
  assert.deepEqual(spec.args.slice(0, 1), ["-p"]);
  assert.equal(spec.args.includes("--output-format"), true);
  assert.equal(spec.args.join("\n").includes("image_gen.py"), false);
});

test("saved png path is read from codex jsonl", () => {
  const stdout = [
    '{"type":"session"}',
    JSON.stringify({ type: "item.completed", item: { saved_path: "/tmp/generated/one.png" } }),
    "not json",
  ].join("\n");
  assert.equal(savedPngFromOutput(stdout), "/tmp/generated/one.png");
});

test("newest png ignores files from before the run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hz-png-"));
  const oldFile = path.join(dir, "old.png");
  const recent = path.join(dir, "recent.png");
  const started = Date.now() - 50;
  fs.writeFileSync(oldFile, "old");
  fs.utimesSync(oldFile, new Date(started - 10_000), new Date(started - 10_000));
  fs.writeFileSync(recent, "new");
  assert.equal(newestPng(dir, started), recent);
});

test("rewrite instruction omits an empty direction and constrains a non-empty one", () => {
  const plain = textRewriteInstruction({ parents: "world", current: "guard" });
  const blank = textRewriteInstruction({ parents: "world", current: "guard", direction: "   " });
  assert.equal(blank, plain);
  assert.equal(plain.includes("hard constraint"), false);
  assert.equal(plain.includes("emphasize weathered bronze"), false);
  assert.match(plain, /Print only this level's prompt and nothing else/);
  const direction = "emphasize weathered bronze";
  const guided = textRewriteInstruction({ parents: "world\n\nunits", current: "guard", direction: `  ${direction}  ` });
  assert.equal(guided.includes(direction), true);
  assert.match(guided, /hard constraint/);
  assert.match(guided, /Print only this level's prompt and nothing else/);
  assert.match(guided, /Rewrite only this folder's prompt markdown/);
  assert.match(guided, /Parent prompts are read-only context/);
  assert.match(guided, /Current prompt for this level:\nguard/);
  assert.doesNotMatch(guided, /Current prompt for this level:\nemphasize weathered bronze/);
});

test("codex text argv omits the image tool and does not combine sandbox with approve-for-me", () => {
  const instruction = textRewriteInstruction({ parents: "world", current: "guard" });
  const spec = codexTextArgs({ instruction, cwd: "/repo", lastMessage: "/tmp/last.md" });
  assert.equal(spec.command, "codex");
  assert.deepEqual(spec.args.slice(0, 11), [
    "exec",
    "--color",
    "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    "/repo",
    "--output-last-message",
    "/tmp/last.md",
  ]);
  assert.equal(spec.args.includes("--output-last-message"), true);
  assert.equal(spec.args.includes("--approve-for-me"), false);
  assert.equal(spec.args.includes("--sandbox") && spec.args.includes("--approve-for-me"), false);
  const joined = [spec.command, ...spec.args].join("\n");
  assert.equal(joined.includes("image_gen"), false);
  assert.equal(joined.includes("image_gen.py"), false);
  assert.equal(joined.includes("OPENAI_API_KEY"), false);
  assert.equal(joined.includes("api.openai.com"), false);
});

test("agent text argv prints in ask mode", () => {
  const spec = agentTextArgs({ instruction: "rewrite this level" });
  assert.equal(spec.command, "agent");
  assert.deepEqual(spec.args.slice(0, 5), ["-p", "--output-format", "text", "--mode", "ask"]);
  assert.equal(spec.args.at(-1), "rewrite this level");
  assert.equal(spec.args.join("\n").includes("image_gen.py"), false);
});

test("cli stdout is saved as that level's prompt only", () => {
  const stdout = [
    JSON.stringify({ type: "session", thread_id: "abc" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "```markdown\nrevised guard\n```" },
    }),
  ].join("\n");
  const body = promptFromCliOutput(stdout);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hz-text-"));
  const guard = path.join(root, "units", "guard");
  const archer = path.join(root, "units", "archer");
  fs.mkdirSync(guard, { recursive: true });
  fs.mkdirSync(archer, { recursive: true });
  fs.writeFileSync(path.join(root, "prompt.md"), "world\n");
  fs.writeFileSync(path.join(root, "units", "prompt.md"), "units\n");
  fs.writeFileSync(path.join(archer, "prompt.md"), "archer\n");
  fs.writeFileSync(path.join(guard, "prompt.md"), "old\n");
  const world = fs.readFileSync(path.join(root, "prompt.md"));
  const units = fs.readFileSync(path.join(root, "units", "prompt.md"));
  const sibling = fs.readFileSync(path.join(archer, "prompt.md"));
  writePrompt(root, "units/guard", body);
  assert.equal(fs.readFileSync(path.join(guard, "prompt.md"), "utf8"), "revised guard\n");
  assert.deepEqual(fs.readFileSync(path.join(root, "prompt.md")), world);
  assert.deepEqual(fs.readFileSync(path.join(root, "units", "prompt.md")), units);
  assert.deepEqual(fs.readFileSync(path.join(archer, "prompt.md")), sibling);
  assert.equal(promptFromCliOutput("plain level\n"), "plain level\n");
  assert.throws(() => promptFromCliOutput('{"type":"session"}\n'), /empty prompt/);
});

test("codex exec help contains the flags the studio passes", (t) => {
  const image = spawnSync("codex", ["help", "image"], { encoding: "utf8" });
  if (image.error?.code === "ENOENT") {
    t.skip("codex is not installed");
    return;
  }
  assert.match(`${image.stderr}\n${image.stdout}`, /unrecognized subcommand/i);
  const exec = spawnSync("codex", ["exec", "--help"], { encoding: "utf8" });
  assert.equal(exec.status, 0);
  const help = `${exec.stdout}\n${exec.stderr}`;
  for (const flag of ["--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "--approve-for-me", "--cd", "--add-dir", "--color", "--output-last-message"]) {
    assert.equal(help.includes(flag), true, flag);
  }
  assert.match(help, /workspace-write/);
  assert.match(help, /read-only/);
  assert.match(help, /--approve-for-me[\s\S]{0,240}workspace-write/);
});
