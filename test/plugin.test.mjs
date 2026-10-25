// The demo plugin run with Kino's Node kit (plugins/sdk): the same `kino` API the app gives, the same sandbox, against
// the real server.mjs on a local port. kino.fetch under "fetchHosts": "any" only reaches https on port 443, so the plugin
// is pointed at https://sync.demo.example and the kit's network (fetchImpl) carries that to 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncServer } from "../server.mjs";
import { createKino } from "../sdk/kino-shim.mjs";
import { loadPlugin } from "../sdk/sandbox.mjs";
import { validate } from "../sdk/validate.mjs";
import { checkSyncAnswer } from "../sdk/contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, "..", "plugin");
const MANIFEST_TEXT_RAW = readFileSync(join(PLUGIN_DIR, "kino-plugin.json"), "utf8");
const MANIFEST = JSON.parse(MANIFEST_TEXT_RAW);
const TOKEN = "k".repeat(43);
const PUBLIC = "https://sync.demo.example";
const quiet = { log() {}, info() {}, warn() {}, error() {} };

async function rig({ token = TOKEN, serverUrl = PUBLIC, lang = "es-CO", syncCall = false } = {}) {
  const server = createSyncServer({ dataDir: mkdtempSync(join(tmpdir(), "sync-server-plugin-")), token: TOKEN });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  const fetchImpl = (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers });
    return fetch(String(url).replace(PUBLIC, local), init);
  };
  const config = {};
  if (serverUrl !== null) config.serverUrl = serverUrl;
  if (token !== null) config.token = token;
  const { kino } = createKino(MANIFEST, { config, fetchImpl, lang, syncCall });
  const { plugin } = await loadPlugin(join(PLUGIN_DIR, "plugin.js"), kino, { console: quiet });
  const ctx = { maxBlobBytes: MANIFEST.sync.maxBlobBytes };
  return { plugin, server, seen, ctx, close: () => new Promise((r) => server.close(r)) };
}

// The plugin answers from its own realm (the sandbox); Kino reads them as JSON, so compare them that way.
const plain = (v) => JSON.parse(JSON.stringify(v));
const b64 = (s) => Buffer.from(s).toString("base64");
const codeOf = async (p) => { try { await p; return "no error"; } catch (e) { return e.code; } };

test("the kit accepts the plugin as Kino would", async () => {
  const v = await validate(PLUGIN_DIR);
  assert.equal(v.ok, true, v.problems.join("\n"));
  assert.deepEqual(MANIFEST.capabilities, ["syncProvider"]);
  assert.equal(MANIFEST.fetchHosts, "any");
  // Sync Servidor: its own name and icon, a short help and one link to its guide.
  assert.equal(MANIFEST.id, "sync-server");
  assert.equal(MANIFEST.name, "Sync Servidor");
  assert.equal(MANIFEST.icon, "icon.png");
  const icon = readFileSync(join(PLUGIN_DIR, "icon.png"));
  assert.equal(icon.subarray(1, 4).toString("latin1"), "PNG");
  assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20), "a square icon");
  assert.ok(icon.length <= 128 * 1024, "at most 128 KB");
  const help = MANIFEST.settings.filter((x) => x.type === "help");
  assert.equal(help.length, 1);
  for (const body of [help[0].body, help[0].bodyEn]) {
    assert.ok(body && body.length <= 400, "a few lines: what is needed, not how to build the server");
    assert.match(body, /https/);
    assert.match(body, /token/i);
  }
  const links = MANIFEST.settings.filter((x) => x.type === "link");
  assert.deepEqual(links.map((x) => x.url), ["https://github.com/kinotvapp/kino-plugin-sync-server"]);
  assert.ok(links[0].label && links[0].labelEn);
  // The guide's address is written once in the manifest, so changing the repository is one edit.
  assert.equal(MANIFEST_TEXT_RAW.split("https://github.com/kinotvapp/kino-plugin-sync-server").length - 1, 1);
  assert.equal(MANIFEST.sync.keySecret, "token");
  // Task 16: the setup (help, guide link, section, address and token) is drawn on the phone only; the TV receives the values
  // with "Recibir desde otro aparato" and keeps the status line and "Probar conexión".
  for (const x of MANIFEST.settings) assert.deepEqual(x.devices, ["status", "check"].includes(x.key) ? undefined : ["phone"], x.key);
  assert.deepEqual(MANIFEST.sync.provision, ["serverUrl", "token"]);
  const token = MANIFEST.settings.find((s) => s.key === "token");
  assert.equal(token.type, "password");
  assert.equal(token.default, undefined);
  assert.equal(MANIFEST.settings.find((s) => s.key === "serverUrl").default, undefined);
});

test("first round: empty pull, push from nothing, pull gives the same bytes and version", async () => {
  const r = await rig();
  try {
    assert.equal(await r.plugin.syncPull(r.ctx), null);
    const blob = Buffer.from([0, 255, 1, 254, 128]).toString("base64");
    const { version } = await r.plugin.syncPush({ ...r.ctx, blob, expectedVersion: null });
    assert.ok(version && version !== "0");
    const got = await r.plugin.syncPull(r.ctx);
    assert.deepEqual(plain(got), { blob, version });
    const put = r.seen.find((s) => s.method === "PUT");
    assert.equal(put.headers["If-Match"], "0");
    assert.equal(put.headers.Authorization, "Bearer " + TOKEN);
    const next = await r.plugin.syncPush({ ...r.ctx, blob: b64("second"), expectedVersion: version });
    assert.notEqual(next.version, version);
  } finally { await r.close(); }
});

test("a stale version is Kino's conflict, and the stored copy stays", async () => {
  const r = await rig();
  try {
    const { version } = await r.plugin.syncPush({ ...r.ctx, blob: b64("device A"), expectedVersion: null });
    assert.equal(await codeOf(r.plugin.syncPush({ ...r.ctx, blob: b64("device B"), expectedVersion: null })), "conflict");
    assert.equal(await codeOf(r.plugin.syncPush({ ...r.ctx, blob: b64("device B"), expectedVersion: "1.00000000" })), "conflict");
    assert.deepEqual(plain(await r.plugin.syncPull(r.ctx)), { blob: b64("device A"), version });
  } finally { await r.close(); }
});

test("a wrong token is auth_required with a sentence, and the status line says not ready", async () => {
  const r = await rig({ token: "w".repeat(43) });
  try {
    let err;
    try { await r.plugin.syncPull(r.ctx); } catch (e) { err = e; }
    assert.equal(err.code, "auth_required");
    assert.match(err.say, /token/);
    const s = await r.plugin.syncStatus(null);
    assert.equal(s.ready, false);
    assert.match(s.message, /token/);
  } finally { await r.close(); }
});

test("missing settings and an http address fail before anything is sent", async () => {
  for (const [opts, re] of [[{ token: null }, /Falta el token/], [{ serverUrl: null }, /Falta la dirección/], [{ serverUrl: "http://sync.demo.example" }, /https/], [{ serverUrl: "https://sync.demo.example:8443" }, /puerto/]]) {
    const r = await rig(opts);
    try {
      const s = await r.plugin.syncStatus(null);
      assert.equal(s.ready, false);
      assert.match(s.message, re);
      assert.equal(await codeOf(r.plugin.syncPull(r.ctx)), "auth_required");
      assert.equal(r.seen.length, 0, "nothing reached the network");
    } finally { await r.close(); }
  }
});

test("status, the connection test and English texts", async () => {
  const r = await rig({ lang: "en-US" });
  try {
    assert.deepEqual(plain(await r.plugin.syncStatus(null)), { ready: true, message: "Connected. The server stores nothing yet." });
    await r.plugin.syncPush({ ...r.ctx, blob: b64("x"), expectedVersion: null });
    assert.deepEqual(plain(await r.plugin.settingsStatus()), { status: "Connected." });
    assert.deepEqual(plain(await r.plugin.action("check")), { message: "Connected." });
  } finally { await r.close(); }
});

test("the status line asks with HEAD: it never downloads the stored blob", async () => {
  const r = await rig();
  try {
    await r.plugin.syncPush({ ...r.ctx, blob: b64("x".repeat(1000)), expectedVersion: null });
    r.seen.length = 0;
    assert.equal((await r.plugin.syncStatus(null)).ready, true);
    await r.plugin.settingsStatus();
    assert.deepEqual(r.seen.map((x) => x.method), ["HEAD", "HEAD"]);
  } finally { await r.close(); }
});

test("the server switched off: unavailable, with what to check", async () => {
  const r = await rig();
  await r.close();
  let err;
  try { await r.plugin.syncPull(r.ctx); } catch (e) { err = e; }
  assert.equal(err.code, "unavailable");
  assert.match(err.say, /server\.mjs/);
});

test("validateSettings refuses http, a port and a short token, accepts a good pair", async () => {
  const r = await rig();
  try {
    assert.equal(await r.plugin.validateSettings({ serverUrl: "https://abc-def.trycloudflare.com", token: TOKEN }), null);
    // 100.63.x and 100.128.x are public: only 100.64.0.0/10 is carrier-grade NAT.
    assert.equal(await r.plugin.validateSettings({ serverUrl: "https://100.128.0.1", token: TOKEN }), null);
    const bad = await r.plugin.validateSettings({ serverUrl: "http://192.168.1.10:8787", token: "short" });
    assert.match(bad.serverUrl, /https/);
    assert.match(bad.token, /corto/);
    // kino.fetch never reaches the home network or a name without a dot: said under the field instead of failing later.
    for (const url of ["https://192.168.1.10", "https://10.0.0.5", "https://127.0.0.1", "https://localhost", "https://localhost.", "https://nas", "https://mi-pc.local",
      "https://nas.internal", "https://router.home.arpa", "https://box.localhost", "https://100.64.1.2", "https://100.127.255.254", "https://172.16.0.1"]) {
      const r2 = await r.plugin.validateSettings({ serverUrl: url, token: TOKEN });
      assert.match(r2?.serverUrl || "", /red local|pública/, url);
    }
  } finally { await r.close(); }
});

test("a blob at the manifest's maxBlobBytes goes through kino.fetch inside syncPush/syncPull, and not in any other call", async () => {
  assert.equal(MANIFEST.sync.maxBlobBytes, 4 * 1024 * 1024);
  const r = await rig({ syncCall: true });
  try {
    const blob = Buffer.alloc(MANIFEST.sync.maxBlobBytes, 3).toString("base64");
    const { version } = await r.plugin.syncPush({ ...r.ctx, blob, expectedVersion: null });
    // What Kino keeps of the answer, with the sync call's own answer cap (over the usual 2,000,000 characters here).
    const kept = checkSyncAnswer("syncPull", plain(await r.plugin.syncPull(r.ctx)), MANIFEST);
    assert.equal(kept.blob.length, blob.length);
    assert.equal(kept.version, version);
    assert.equal(await codeOf(r.plugin.syncPush({ ...r.ctx, blob: Buffer.alloc(MANIFEST.sync.maxBlobBytes + 3000, 3).toString("base64"), expectedVersion: version })), "invalid_request");
  } finally { await r.close(); }
  // Outside a sync call (here: the same kino.fetch from a kino that is not running syncPush), Kino's 1 MB request cap holds.
  const other = await rig();
  try {
    assert.equal(await codeOf(other.plugin.syncPush({ ...other.ctx, blob: Buffer.alloc(1024 * 1024, 3).toString("base64"), expectedVersion: null })), "unavailable");
    // Refused by kino.fetch's 1 MB cap before anything went out (the plugin words it as "unavailable").
    assert.equal(other.seen.length, 0);
  } finally { await other.close(); }
});
