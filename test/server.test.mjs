// node --test docs/plugins/examples/sync-server/test
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncServer, loadToken, MAX_BLOB_BYTES, openStore, sameSecret } from "../server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server.mjs");
const TOKEN = "t".repeat(40);

async function start(opts = {}) {
  const dataDir = opts.dataDir || mkdtempSync(join(tmpdir(), "sync-server-"));
  const lines = [];
  const server = createSyncServer({ dataDir, token: TOKEN, log: (l) => lines.push(l), ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (path, { token = TOKEN, method = "GET", headers = {}, body } = {}) =>
    fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body });
  return { server, base, dataDir, lines, req, close: () => new Promise((r) => server.close(r)) };
}

const put = (s, ifMatch, body, extra = {}) => s.req("/blob", { method: "PUT", headers: ifMatch === undefined ? {} : { "If-Match": ifMatch }, body, ...extra });

test("an empty store answers 204 with version 0", async () => {
  const s = await start();
  try {
    const r = await s.req("/blob");
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("x-version"), "0");
  } finally { await s.close(); }
});

test("a token is required, and a wrong one is refused like a missing one", async () => {
  const s = await start();
  try {
    assert.equal((await s.req("/blob", { token: null })).status, 401);
    assert.equal((await s.req("/blob", { token: "x" })).status, 401);
    assert.equal((await s.req("/blob", { token: TOKEN + "x" })).status, 401);
    assert.equal((await put(s, "0", "abc", { token: "nope".repeat(10) })).status, 401);
    assert.equal((await s.req("/blob")).status, 204, "the refused PUT stored nothing");
    assert.equal((await s.req("/healthz", { token: null })).status, 200);
  } finally { await s.close(); }
});

test("PUT with the right version stores the bytes and returns a new version; GET gives them back byte for byte", async () => {
  const s = await start();
  try {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
    const r = await put(s, "0", bytes);
    assert.equal(r.status, 200);
    const v1 = r.headers.get("x-version");
    assert.ok(v1 && v1 !== "0");
    const g = await s.req("/blob");
    assert.equal(g.status, 200);
    assert.equal(g.headers.get("x-version"), v1);
    assert.equal(g.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(Buffer.from(await g.arrayBuffer()), bytes);
    const r2 = await put(s, `"${v1}"`, "second");
    assert.equal(r2.status, 200, "a quoted ETag-style If-Match is accepted");
    assert.notEqual(r2.headers.get("x-version"), v1);
  } finally { await s.close(); }
});

test("a stale version gets 409 with the current version and changes nothing", async () => {
  const s = await start();
  try {
    const v1 = (await put(s, "0", "one")).headers.get("x-version");
    const stale = await put(s, "0", "two");
    assert.equal(stale.status, 409);
    assert.equal(stale.headers.get("x-version"), v1);
    const other = await put(s, "9.deadbeef", "three");
    assert.equal(other.status, 409);
    assert.equal(await (await s.req("/blob")).text(), "one");
  } finally { await s.close(); }
});

test("PUT without If-Match is refused (428), an empty body too (400)", async () => {
  const s = await start();
  try {
    assert.equal((await put(s, undefined, "x")).status, 428);
    assert.equal((await put(s, "0", "")).status, 400);
    assert.equal((await s.req("/blob")).status, 204);
  } finally { await s.close(); }
});

test("a blob over 8 MiB gets 413 and is not stored; exactly 8 MiB is fine", async () => {
  const s = await start();
  try {
    const big = await put(s, "0", Buffer.alloc(MAX_BLOB_BYTES + 1, 7));
    assert.equal(big.status, 413);
    assert.equal((await s.req("/blob")).status, 204);
    const ok = await put(s, "0", Buffer.alloc(MAX_BLOB_BYTES, 7));
    assert.equal(ok.status, 200);
  } finally { await s.close(); }
});

test("concurrent PUTs on the same version: exactly one wins, the others get 409 with the winner's version", async () => {
  const s = await start();
  try {
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => put(s, "0", `writer-${i}`)));
    const won = answers.filter((r) => r.status === 200);
    const lost = answers.filter((r) => r.status === 409);
    assert.equal(won.length, 1);
    assert.equal(lost.length, 19);
    const winner = won[0].headers.get("x-version");
    for (const r of lost) assert.equal(r.headers.get("x-version"), winner);
    const i = answers.indexOf(won[0]);
    assert.equal(await (await s.req("/blob")).text(), `writer-${i}`);
  } finally { await s.close(); }
});

test("the blob and its version survive a restart", async () => {
  const s = await start();
  const v = (await put(s, "0", "kept")).headers.get("x-version");
  await s.close();
  const again = await start({ dataDir: s.dataDir });
  try {
    const g = await again.req("/blob");
    assert.equal(g.headers.get("x-version"), v);
    assert.equal(await g.text(), "kept");
    assert.equal((await put(again, v, "next")).status, 200);
  } finally { await again.close(); }
});

test("writes are atomic: a crash's leftovers never become the data, and a blob newer than its meta gets a fresh version", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-server-"));
  const store = openStore(dir);
  const v1 = store.put("0", Buffer.from("one")).version;
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temp file left after a write");
  // A crash in the middle of writing: a half temp file stays behind.
  writeFileSync(join(dir, "blob.bin.123.ab.tmp"), "half");
  let reopened = openStore(dir);
  assert.equal(reopened.get().version, v1);
  assert.equal(reopened.get().bytes.toString(), "one");
  // A crash between the two renames: the new blob is in place, the meta is the old one.
  writeFileSync(join(dir, "blob.bin"), "two");
  reopened = openStore(dir);
  assert.equal(reopened.get().bytes.toString(), "two");
  assert.notEqual(reopened.get().version, v1, "nobody may write over it with the old version");
  assert.equal(reopened.put(v1, Buffer.from("x")).ok, false);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  assert.equal(meta.version, reopened.get().version);
});

test("the token: DEMO_TOKEN wins, else data/token, else a new one saved there; short ones are refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-server-"));
  assert.throws(() => loadToken(dir, "short"), /at least 32/);
  assert.equal(loadToken(dir, TOKEN).token, TOKEN);
  assert.equal(existsSync(join(dir, "token")), false);
  const made = loadToken(dir, undefined);
  assert.equal(made.fresh, true);
  assert.ok(made.token.length >= 43);
  const read = loadToken(dir, "");
  assert.equal(read.fresh, false);
  assert.equal(read.token, made.token);
});

test("token comparison does not stop early on a different length", () => {
  assert.equal(sameSecret(TOKEN, TOKEN), true);
  // timingSafeEqual throws on different lengths: comparing hashes is what lets these answer false instead.
  assert.equal(sameSecret("", TOKEN), false);
  assert.equal(sameSecret(TOKEN + "x", TOKEN), false);
  assert.equal(sameSecret(TOKEN.slice(0, -1) + "u", TOKEN), false);
});

test("per-address rate limit answers 429 with Retry-After; wrong tokens have a smaller budget", async () => {
  let t = 0;
  const s = await start({ requestsPerMinute: 5, failedAuthPerMinute: 2, now: () => t });
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await s.req("/healthz")).status);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
    const limited = await s.req("/healthz");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    // Another visitor behind the tunnel (CF-Connecting-IP from loopback) has its own budget.
    assert.equal((await s.req("/healthz", { headers: { "CF-Connecting-IP": "203.0.113.9" } })).status, 200);
    t += 60000;
    const wrong = [];
    for (let i = 0; i < 3; i++) wrong.push((await s.req("/blob", { token: "w".repeat(40) })).status);
    assert.deepEqual(wrong, [401, 401, 429]);
  } finally { await s.close(); }
});

test("plugin files are served read-only, only the ones in plugin/", async () => {
  const s = await start();
  try {
    const m = await s.req("/plugin/kino-plugin.json", { token: null });
    assert.equal(m.status, 200);
    assert.match(m.headers.get("content-type"), /application\/json/);
    assert.equal((await m.json()).id, "sync-server");
    const icon = await s.req("/plugin/icon.png", { token: null });
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    const js = await s.req("/plugin/plugin.js", { token: null });
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    assert.equal((await s.req("/plugin/../server.mjs", { token: null })).status, 404);
    assert.equal((await s.req("/plugin/%2e%2e%2fserver.mjs", { token: null })).status, 404);
    assert.equal((await s.req("/plugin/nothing.js", { token: null })).status, 404);
    assert.equal((await s.req("/plugin/plugin.js", { token: null, method: "PUT", body: "x" })).status, 405);
  } finally { await s.close(); }
});

test("the log never holds the token or a body", async () => {
  const s = await start();
  try {
    await put(s, "0", "SECRET-BODY-CONTENT");
    await s.req("/blob");
    await s.req("/blob", { token: "WRONG-TOKEN-".repeat(4) });
    const all = s.lines.join("\n");
    assert.ok(s.lines.length >= 3);
    assert.ok(!all.includes(TOKEN));
    assert.ok(!all.includes("WRONG-TOKEN"));
    assert.ok(!all.includes("SECRET-BODY"));
  } finally { await s.close(); }
});

test("run as a program: a first start prints a new token once and saves it; the next start does not print it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sync-server-"));
  const runOnce = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: "0", DATA_DIR: dataDir, DEMO_TOKEN: "" } });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
      if (out.includes("Next:")) p.kill("SIGTERM");
    });
    p.on("exit", () => resolve(out));
    p.on("error", reject);
  });
  try {
    const first = await runOnce();
    const token = readFileSync(join(dataDir, "token"), "utf8").trim();
    assert.ok(first.includes(token), "the first start shows the new token");
    const second = await runOnce();
    assert.ok(!second.includes(token), "later starts never print it");
    assert.match(second, /saved in/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// An unauthenticated or rate-limited body is not read forever: past about 1 MiB the connection is cut.
function slowBody(port, headers, sendBytes) {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    let closed = false;
    let answer = "";
    sock.on("data", (d) => { answer += d; });
    sock.on("close", () => { closed = true; resolve({ closed, answer }); });
    sock.on("error", () => {});
    sock.write(`PUT /blob HTTP/1.1\r\nHost: x\r\n${headers}Content-Length: ${3 * 1024 * 1024}\r\n\r\n`);
    const chunk = Buffer.alloc(64 * 1024, 1);
    let sent = 0;
    const pump = () => { while (sent < sendBytes && sock.write(chunk)) sent += chunk.length; if (sent < sendBytes) sock.once("drain", () => { sent += chunk.length; pump(); }); };
    pump();
    setTimeout(() => { if (!closed) { sock.destroy(); resolve({ closed: false, answer }); } }, 3000);
  });
}

test("a body sent without the token is cut past about 1 MiB instead of drained forever", async () => {
  const s = await start();
  try {
    const r = await slowBody(s.server.address().port, "Authorization: Bearer nope-nope-nope-nope-nope-nope-nope\r\nIf-Match: 0\r\n", 2 * 1024 * 1024);
    assert.equal(r.closed, true, "the server closed the connection");
    assert.match(r.answer, /^HTTP\/1\.1 401/);
  } finally { await s.close(); }
});

test("a corrupt meta.json does not stop the server: the blob is kept under a fresh version", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-server-"));
  openStore(dir).put("0", Buffer.from("kept"));
  writeFileSync(join(dir, "meta.json"), "{ not json");
  const lines = [];
  const store = openStore(dir, (l) => lines.push(l));
  assert.equal(store.get().bytes.toString(), "kept");
  assert.ok(store.get().version && store.get().version !== "0");
  assert.match(lines.join("\n"), /meta\.json/);
});

test("leftover temp files of a dead writer are deleted; a live writer's are left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "sync-server-"));
  writeFileSync(join(dir, "blob.bin.999999.ab.tmp"), "half");
  writeFileSync(join(dir, `meta.json.${process.pid}.cd.tmp`), "live");
  openStore(dir);
  const names = readdirSync(dir);
  assert.ok(!names.includes("blob.bin.999999.ab.tmp"), names.join(","));
  assert.ok(!names.some((n) => n.endsWith(".orphan")), names.join(","));
  assert.ok(names.includes(`meta.json.${process.pid}.cd.tmp`), names.join(","));
});

test("plugin files are served with nosniff", async () => {
  const s = await start();
  try {
    const r = await s.req("/plugin/plugin.js", { token: null });
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  } finally { await s.close(); }
});
