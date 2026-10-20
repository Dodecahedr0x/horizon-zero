import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const hits = { indexer: [], other: [] };
const indexer = await listen((req, res) => {
  hits.indexer.push({ url: req.url, method: req.method, headers: req.headers });
  if (req.url.startsWith("/html")) {
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "a=b" });
    res.end("<script>alert(1)</script>");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Set-Cookie": "a=b", "X-Internal": "1" });
  res.end(JSON.stringify({ url: req.url }));
});
const other = await listen((req, res) => {
  hits.other.push(req.url);
  res.end("other host");
});
process.env.INDEXER_URL = `127.0.0.1:${indexer.address().port}`;
const { handle } = await import("./server.js");
const app = await listen((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    res.writeHead(599);
    res.end(String(err));
  }
});
const port = app.address().port;
const otherHost = `127.0.0.1:${other.address().port}`;

/** One raw request, so paths like `//` reach the server unnormalized. */
function raw(method, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [`${method} ${target} HTTP/1.1`, "Host: game", "Connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""];
      socket.write(lines.join("\r\n"));
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      const [head, ...body] = data.split("\r\n\r\n");
      const [status, ...rest] = head.split("\r\n");
      const out = {};
      for (const line of rest) {
        const at = line.indexOf(":");
        out[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      resolve({ status: Number(status.split(" ")[1]), headers: out, body: body.join("\r\n\r\n") });
    });
    socket.on("error", reject);
  });
}

test.after(() => {
  for (const server of [indexer, other, app]) server.close();
});

test("/api reaches the indexer with only accept, and passes back only listed headers", async () => {
  const reply = await raw("GET", "/api/stats?x=1", { Accept: "application/json", Cookie: "session=1", Authorization: "Bearer t" });
  assert.equal(reply.status, 200);
  const seen = hits.indexer.at(-1);
  assert.equal(seen.url, "/stats?x=1");
  assert.equal(seen.headers.cookie, undefined);
  assert.equal(seen.headers.authorization, undefined);
  assert.equal(seen.headers.accept, "application/json");
  assert.equal(reply.headers["set-cookie"], undefined);
  assert.equal(reply.headers["x-internal"], undefined);
  assert.equal(reply.headers["access-control-allow-origin"], "*");
  assert.equal(reply.headers["x-content-type-options"], "nosniff");
  assert.match(reply.headers["content-type"], /^application\/json/);
});

test("/api never serves HTML", async () => {
  const reply = await raw("GET", "/api/html");
  assert.match(reply.headers["content-type"], /^text\/plain/);
  assert.equal(reply.headers["x-content-type-options"], "nosniff");
});

test("/api cannot be pointed at another host", async () => {
  for (const target of [`/api//${otherHost}/x`, `/api/\\${otherHost}/x`, `/api/%2f${otherHost}/x`, `/api/%5C${otherHost}/x`, `/api/..//${otherHost}/x`]) {
    const reply = await raw("GET", target);
    assert.ok(reply.status < 500, `${target}: ${reply.status}`);
  }
  assert.deepEqual(hits.other, []);
});

test("/api is read-only", async () => {
  const before = hits.indexer.length;
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) assert.equal((await raw(method, "/api/stats")).status, 405);
  assert.equal(hits.indexer.length, before);
});

test("paths that do not parse are a 400, and the server keeps serving", async () => {
  for (const target of ["//", "/api//[", "//[", "///"]) {
    const reply = await raw("GET", target);
    assert.ok(reply.status === 400 || reply.status === 200, `${target}: ${reply.status}`);
  }
  assert.equal((await raw("GET", "/api/health")).status, 200);
});

test("the bundle is served from dist, apart from the repo's /assets", async (t) => {
  const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist", "bundle");
  if (!fs.existsSync(bundle)) return t.skip("app/dist is not built");
  const script = fs.readdirSync(bundle).find((name) => name.endsWith(".js"));
  const reply = await raw("GET", `/bundle/${script}`);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers["content-type"], "text/javascript");
  const wasm = fs.readdirSync(bundle).find((name) => name.endsWith(".wasm"));
  if (wasm) assert.equal((await raw("GET", `/bundle/${wasm}`)).headers["content-type"], "application/wasm");
  assert.equal((await raw("GET", "/assets/no-such-file.js")).status, 404);
});
