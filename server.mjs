#!/usr/bin/env node
// A sync mailbox for Kino in one file: Node 18+, no dependencies.
//
// It keeps ONE blob (the encrypted snapshot Kino hands to the Sync Servidor plugin (sync-server)) and its version:
//   GET  /blob          200 + the bytes + X-Version, or 204 when nothing is stored yet
//   PUT  /blob          If-Match: <version> (0 when the client thinks it is empty) -> 200 + the new X-Version,
//                       409 + the current X-Version when someone else wrote first
//   GET  /healthz       200 "ok" (no token needed, says nothing else)
//   GET  /plugin/<file> the plugin's files, read-only, so Kino can install it from https://<tunnel>/plugin/kino-plugin.json
// Every /blob request needs "Authorization: Bearer <token>".
//
// Settings (environment):
//   PORT        default 8787
//   HOST        default 127.0.0.1 (the tunnel connects locally; nothing else on your network can reach it)
//   DATA_DIR    default ./data next to this file
//   DEMO_TOKEN  the access token (at least 32 characters). Without it the token is read from DATA_DIR/token,
//               or generated on the first start, printed once and saved there.
//
// It never logs a token or a body: only the method, the path, the status and a byte count.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MAX_BLOB_BYTES = 8 * 1024 * 1024;
export const MIN_TOKEN_CHARS = 32;
/** What a refused request's body (no token, rate-limited, no If-Match) may still send before the connection is cut. */
export const MAX_DRAIN_BYTES = 1024 * 1024;
const PLUGIN_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLUGIN_TYPES = { ".json": "application/json; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".md": "text/markdown; charset=utf-8" };

/** Compares two secrets in time that depends on neither their content nor their length: both are hashed first. */
export function sameSecret(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Writes [bytes] to [file] so a reader sees the old file or the new one, never half of it. */
function writeAtomic(file, bytes) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  try { const d = openSync(dirname(file), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* not every platform can fsync a directory */ }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const newVersion = (n) => `${n}.${randomBytes(4).toString("hex")}`;

/** Whether process [pid] is still running (EPERM: it exists, owned by someone else). */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * The stored blob and its version, on disk in [dataDir]. Run ONE server per DATA_DIR: two would each keep their own idea of
 * the current version. [log] gets a line when something on disk had to be repaired (never a token or a body).
 */
export function openStore(dataDir, log = () => {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const blobFile = join(dataDir, "blob.bin");
  const metaFile = join(dataDir, "meta.json");
  // Leftovers of a write a crash interrupted (name.<pid>.<random>.tmp): deleted when that writer is gone, never the
  // stored data. A running writer's temp file is left alone.
  for (const name of readdirSync(dataDir)) {
    const m = /\.(\d+)\.[0-9a-f]+\.tmp$/.exec(name);
    if (!name.endsWith(".tmp") || (m && alive(Number(m[1])))) continue;
    try { unlinkSync(join(dataDir, name)); } catch { /* ignore */ }
  }
  let meta = { counter: 0, version: null, sha256: null, bytes: 0 };
  if (existsSync(metaFile)) {
    try {
      meta = { ...meta, ...JSON.parse(readFileSync(metaFile, "utf8")) };
    } catch {
      // Unreadable: as if it were missing. A blob beside it gets a fresh version below.
      log(`${metaFile} could not be read; the blob is kept under a new version`);
      meta.sha256 = "unreadable";
    }
  }
  let blob = existsSync(blobFile) ? readFileSync(blobFile) : null;
  // A crash between the two renames leaves a complete new blob beside the old meta: keep the blob, give it a version
  // nobody has seen, so every client pulls it before writing again.
  if (blob && meta.sha256 !== sha256(blob)) {
    meta = { counter: meta.counter + 1, version: newVersion(meta.counter + 1), sha256: sha256(blob), bytes: blob.length };
    writeAtomic(metaFile, JSON.stringify(meta));
  }
  if (!blob) meta.version = null;
  return {
    get: () => (blob ? { bytes: blob, version: meta.version } : null),
    version: () => meta.version,
    /** Stores [bytes] when [expected] is the current version ("0" or "" for empty); else answers the current version. */
    put(expected, bytes) {
      const current = meta.version ?? "0";
      if (expected !== current) return { ok: false, version: current };
      const counter = meta.counter + 1;
      const next = { counter, version: newVersion(counter), sha256: sha256(bytes), bytes: bytes.length };
      writeAtomic(blobFile, bytes);
      writeAtomic(metaFile, JSON.stringify(next));
      blob = Buffer.from(bytes);
      meta = next;
      return { ok: true, version: next.version };
    },
  };
}

/** The token: [given] (DEMO_TOKEN), else DATA_DIR/token, else a new one saved there. [fresh] says whether it was just made. */
export function loadToken(dataDir, given) {
  if (given !== undefined && given !== "") {
    if (given.length < MIN_TOKEN_CHARS) throw new Error(`DEMO_TOKEN must be at least ${MIN_TOKEN_CHARS} characters (a long random token, not a password)`);
    return { token: given, fresh: false, file: null };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token.length < MIN_TOKEN_CHARS) throw new Error(`${file} holds a token shorter than ${MIN_TOKEN_CHARS} characters: delete it to make a new one`);
    return { token, fresh: false, file };
  }
  const token = randomBytes(32).toString("base64url");
  writeAtomic(file, token + "\n");
  return { token, fresh: true, file };
}

/** A per-address budget: [perMinute] requests a minute, refilled continuously. */
function rateLimiter(perMinute, now) {
  const buckets = new Map();
  return (key) => {
    const t = now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: perMinute, at: t }; buckets.set(key, b); }
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60000) * perMinute);
    b.at = t;
    if (buckets.size > 10000) for (const [k, v] of buckets) if (v.tokens >= perMinute) buckets.delete(k);
    if (b.tokens < 1) return Math.ceil(((1 - b.tokens) / perMinute) * 60);
    b.tokens -= 1;
    return 0;
  };
}

/**
 * The HTTP server, not yet listening. [log] gets one line per request (never a token or a body).
 * [requestsPerMinute] is each address's budget; [failedAuthPerMinute] the budget of wrong tokens.
 */
export function createSyncServer({ dataDir, token, pluginDir = join(HERE, "plugin"), requestsPerMinute = 120, failedAuthPerMinute = 10, log = () => {}, now = Date.now } = {}) {
  if (!token || token.length < MIN_TOKEN_CHARS) throw new Error("a token of at least 32 characters is required");
  const store = openStore(dataDir, log);
  const limit = rateLimiter(requestsPerMinute, now);
  const authLimit = rateLimiter(failedAuthPerMinute, now);
  const pluginFiles = new Set(existsSync(pluginDir) ? readdirSync(pluginDir).filter((n) => PLUGIN_FILE.test(n) && statSync(join(pluginDir, n)).isFile()) : []);
  let queue = Promise.resolve();
  // A refused request's body is read and dropped up to MAX_DRAIN_BYTES (so the client gets the answer), then cut.
  const drain = (req) => {
    let seen = 0;
    req.on("data", (c) => { seen += c.length; if (seen > MAX_DRAIN_BYTES) req.destroy(); });
    req.on("error", () => {});
    req.resume();
  };
  const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

  const server = createHttpServer((req, res) => {
    const started = now();
    const send = (status, body = "", headers = {}) => {
      const bytes = typeof body === "string" ? Buffer.from(body) : body;
      res.writeHead(status, { "Cache-Control": "no-store", "Content-Length": bytes.length, ...(bytes.length && !headers["Content-Type"] ? { "Content-Type": "text/plain; charset=utf-8" } : {}), ...headers });
      res.end(req.method === "HEAD" ? undefined : bytes);
      log(`${req.method} ${path} ${status} ${bytes.length}B ${now() - started}ms`);
    };
    let path = "/";
    try { path = new URL(req.url, "http://x").pathname; } catch { return send(400, "bad request\n"); }
    // Behind cloudflared every request comes from 127.0.0.1; the visitor's address is in CF-Connecting-IP. Trusted
    // only from loopback, so nobody else can choose their own bucket.
    const peer = req.socket.remoteAddress || "?";
    const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    const who = loopback && typeof req.headers["cf-connecting-ip"] === "string" ? req.headers["cf-connecting-ip"] : peer;
    const wait = limit(who);
    if (wait) { drain(req); return send(429, "too many requests\n", { "Retry-After": String(wait) }); }

    if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) return send(200, "ok\n");

    if (path.startsWith("/plugin/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, "read only\n", { Allow: "GET, HEAD" });
      const name = path.slice("/plugin/".length);
      if (!pluginFiles.has(name)) return send(404, "not found\n");
      const ext = name.slice(name.lastIndexOf("."));
      return send(200, readFileSync(join(pluginDir, name)), { "Content-Type": PLUGIN_TYPES[ext] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    }

    if (path !== "/blob") return send(404, "not found\n");
    const auth = String(req.headers.authorization || "");
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!sameSecret(presented, token)) {
      drain(req);
      const authWait = authLimit(who);
      if (authWait) return send(429, "too many wrong tokens\n", { "Retry-After": String(authWait) });
      return send(401, "wrong or missing token\n", { "WWW-Authenticate": 'Bearer realm="kino-sync"' });
    }

    if (req.method === "GET" || req.method === "HEAD") {
      const got = store.get();
      if (!got) return send(204, "", { "X-Version": "0" });
      return send(200, got.bytes, { "Content-Type": "application/octet-stream", "X-Version": got.version });
    }

    if (req.method !== "PUT") return send(405, "use GET or PUT\n", { Allow: "GET, HEAD, PUT" });
    const ifMatch = req.headers["if-match"];
    if (typeof ifMatch !== "string" || ifMatch.trim() === "") { drain(req); return send(428, "If-Match is required: the version you last read, or 0 when empty\n"); }
    const expected = ifMatch.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
    // A body over the cap is read and dropped (so the client gets its 413 instead of a reset connection), up to twice
    // the cap; past that the connection is cut.
    const chunks = [];
    let size = 0;
    let over = Number(req.headers["content-length"]) > MAX_BLOB_BYTES;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * MAX_BLOB_BYTES) { req.destroy(); return; }
      if (over) return;
      if (size > MAX_BLOB_BYTES) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("error", () => {});
    req.on("end", () => {
      if (over) return send(413, `the blob is over ${MAX_BLOB_BYTES} bytes\n`);
      if (size === 0) return send(400, "empty body\n");
      const body = Buffer.concat(chunks, size);
      serial(() => store.put(expected, body)).then(
        (r) => (r.ok ? send(200, "", { "X-Version": r.version }) : send(409, "the stored copy changed: read it again\n", { "X-Version": r.version })),
        (e) => { log(`write failed: ${e.code || e.name}`); send(500, "could not store the blob\n"); },
      );
    });
  });
  server.store = store;
  return server;
}

async function main() {
  const dataDir = resolve(process.env.DATA_DIR || join(HERE, "data"));
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  let t;
  try { t = loadToken(dataDir, process.env.DEMO_TOKEN); } catch (e) { console.error(e.message); process.exit(1); }
  const server = createSyncServer({ dataDir, token: t.token, log: (line) => console.log(`${new Date().toISOString()} ${line}`) });
  server.listen(port, host, () => {
    console.log(`Kino sync demo listening on http://${host}:${port}  (data in ${dataDir})`);
    if (t.fresh) {
      console.log("\nYour new access token (shown only this once; it is also saved in " + t.file + "):\n\n  " + t.token + "\n");
      console.log("Paste it into the plugin's Token field. Anyone who has it can read your synced data.\n");
    } else if (t.file) console.log(`Token: the one saved in ${t.file}`);
    else console.log("Token: the one in DEMO_TOKEN");
    console.log(`Next: cloudflared tunnel --url http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`);
  });
  const stop = () => { console.log("stopping"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
