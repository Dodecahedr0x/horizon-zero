import fs from "node:fs";
import path from "node:path";

export function assertProvider(value) {
  if (value !== "codex" && value !== "agent") throw new Error(`unknown image provider ${value}`);
  return value;
}

export function withoutApiKey(env) {
  const next = { ...env };
  delete next.OPENAI_API_KEY;
  return next;
}

export function codexImageArgs({ bin = "codex", promptFile, out, cwd, tempDir }) {
  const prompt = [
    "Use the built-in image_gen tool exactly once.",
    `Read the entire image prompt from the file ${promptFile} and pass that text as the image prompt.`,
    "Ask for a square PNG with a transparent background.",
    `Copy the generated PNG to ${out}, replacing any file already there.`,
    "Do not use a Python script or an API key.",
    "Do not edit, create, or delete any other file.",
  ].join(" ");
  return {
    command: bin,
    args: [
      "exec",
      "--json",
      "--color",
      "never",
      "--ephemeral",
      "--skip-git-repo-check",
      "--approve-for-me",
      "--cd",
      cwd,
      "--add-dir",
      tempDir,
      prompt,
    ],
  };
}

export function agentImageArgs({ bin = "agent", out, promptText }) {
  const prompt = `Write a PNG image at ${out}. Use this prompt and do not write any other file:\n\n${promptText}`;
  return { command: bin, args: ["-p", prompt, "--output-format", "text"] };
}

export function textRewriteInstruction({ parents, current, direction }) {
  const guide = typeof direction === "string" ? direction.trim() : "";
  const lines = [
    "Rewrite only this folder's prompt markdown.",
    "Print only this level's prompt and nothing else.",
    "No code fence, no commentary, and no file edits.",
    "Parent prompts are read-only context. Do not rewrite them.",
  ];
  if (guide) {
    lines.push("The new prompt must follow this direction. Treat it as a hard constraint.", guide);
  }
  lines.push(
    "",
    "Parent prompts:",
    parents.trim() ? parents.trim() : "(none)",
    "",
    "Current prompt for this level:",
    current.trim() ? current.trim() : "(empty)",
  );
  return lines.join("\n");
}

export function codexTextArgs({ bin = "codex", instruction, cwd, lastMessage }) {
  const args = [
    "exec",
    "--color",
    "never",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    cwd,
  ];
  if (lastMessage) args.push("--output-last-message", lastMessage);
  args.push(instruction);
  return { command: bin, args };
}

export function agentTextArgs({ bin = "agent", instruction }) {
  return { command: bin, args: ["-p", "--output-format", "text", "--mode", "ask", instruction] };
}

export function promptFromCliOutput(stdout) {
  const text = String(stdout ?? "");
  const fromJson = lastAgentMessage(text);
  const raw = fromJson == null ? text : fromJson;
  const body = unwrapFence(raw).trim();
  if (!body) throw new Error("text provider returned an empty prompt");
  return `${body}\n`;
}

function lastAgentMessage(text) {
  let sawJson = false;
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    sawJson = true;
    const message = messageText(event);
    if (message != null && message.trim()) found = message;
  }
  if (!sawJson) return null;
  return found ?? "";
}

function messageText(event) {
  const item = event && (event.item || event.payload || event);
  if (!item || typeof item !== "object") return null;
  const isAgent = item.type === "agent_message" || item.role === "assistant";
  if (!isAgent) return null;
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("");
  }
  return null;
}

function unwrapFence(text) {
  const trimmed = String(text).trim();
  const match = trimmed.match(/^```(?:markdown|md)?[^\n]*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : String(text);
}

export function savedPngFromOutput(stdout) {
  const found = [];
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      collectSavedPaths(JSON.parse(trimmed), found);
    } catch {
      // Codex can print non-JSON log lines beside --json events.
    }
  }
  return found.at(-1) || null;
}

function collectSavedPaths(value, found) {
  if (!value || typeof value !== "object") return;
  for (const key of ["saved_path", "savedPath"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.toLowerCase().endsWith(".png")) found.push(candidate);
  }
  for (const child of Object.values(value)) collectSavedPaths(child, found);
}

export function newestPng(dir, sinceMs) {
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
    if (!best || stat.mtimeMs > best.mtime) best = { full, mtime: stat.mtimeMs };
  }
  return best ? best.full : null;
}
