// Sync Servidor (sync-server): Kino's cross-device sync through a server the person runs (../server.mjs).
//
// Kino encrypts the snapshot and hands this plugin only an opaque blob (base64). The plugin stores it on the server
// with PUT /blob and fetches it back with GET /blob. The version the server returns makes a write conditional:
// If-Match carries the version Kino last pulled, and a 409 means someone else wrote first -> "conflict", and Kino
// pulls, merges and pushes again.
//
// The sync key is derived by Kino from the "token" setting (manifest: sync.keySecret), so this plugin and the server
// owner CAN read the synced data: that is why the install screen says so in red.

const es = () => !String(kino.lang || "es").toLowerCase().startsWith("en");
const t = (esText, enText) => (es() ? esText : enText);

/** A typed error for Kino that also keeps the person's sentence where this plugin can read it back (`say`). */
function fail(code, detail, say) {
  const e = say ? kino.error(code, detail, { userMessage: say }) : kino.error(code, detail);
  try { e.say = say || null; } catch (_) { /* a frozen error just has no sentence */ }
  return e;
}

/** The server's base address, checked: https only, no path, query or user name. Null when it is not set. */
export function serverBase(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return null;
  let u;
  try { u = new URL(text); } catch (e) { throw fail("auth_required", "serverUrl is not a URL", t("La dirección del servidor no es válida. Debe empezar con https://", "The server address is not valid. It must start with https://")); }
  if (u.protocol !== "https:") throw fail("auth_required", "serverUrl is not https", t("La dirección del servidor debe empezar con https:// (Kino no deja usar http ni tu red local).", "The server address must start with https:// (Kino allows neither http nor your local network)."));
  if (u.username || u.password || u.search || u.hash || (u.port && u.port !== "443")) throw fail("auth_required", "serverUrl has extra parts", t("Escribe solo https:// y el nombre del servidor, sin puerto ni nada más.", "Type only https:// and the server's name, with no port or anything else."));
  const host = u.hostname.toLowerCase();
  // Kino's own host rules (contract.json hostRules.privateSuffixes) plus the private, loopback, link-local and
  // carrier-grade NAT (100.64.0.0/10) IPv4 ranges: kino.fetch never reaches those, so say it under the field.
  const name = host.replace(/\.$/, "");
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(name);
  const a = v4 ? +v4[1] : -1, b = v4 ? +v4[2] : -1;
  const local = !name.includes(".") || name === "localhost" || host.startsWith("[") ||
    [".local", ".lan", ".internal", ".localhost", ".home.arpa"].some((s) => name.endsWith(s)) ||
    (v4 !== null && (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)));
  if (local) throw fail("auth_required", "serverUrl is not public", t("Esa dirección es de tu red local: Kino solo deja usar una dirección pública https, la de tu túnel.", "That address is on your local network: Kino only allows a public https address, your tunnel's."));
  return "https://" + host + u.pathname.replace(/\/+$/, "");
}

function settings() {
  const base = serverBase(kino.config.get("serverUrl"));
  const token = String(kino.config.get("token") || "").trim();
  if (!base) throw fail("auth_required", "serverUrl missing", t("Falta la dirección del servidor.", "The server address is missing."));
  if (!token) throw fail("auth_required", "token missing", t("Falta el token.", "The token is missing."));
  return { base, token };
}

/** One request to the server; the HTTP status is turned into an error the person understands. */
async function call(method, extraHeaders, body) {
  const { base, token } = settings();
  let r;
  try {
    r = await kino.fetch(base + "/blob", {
      method,
      headers: { Authorization: "Bearer " + token, ...extraHeaders },
      body,
      redirect: "manual",
      cookies: false,
      timeoutMs: 30000,
    });
  } catch (e) {
    if (e && e.code === "host_not_allowed") throw fail("auth_required", "host refused: " + (e.host || ""), t("Kino no deja conectarse a esa dirección: usa la https pública de tu túnel.", "Kino will not connect to that address: use your tunnel's public https one."));
    if (e && e.code === "too_large") throw fail("unavailable", "blob too large for kino.fetch", t("La copia es demasiado grande para este plugin.", "The copy is too large for this plugin."));
    if (e && e.code === "rate_limited") throw kino.error("rate_limited", "kino.fetch budget");
    throw fail("unavailable", "server unreachable: " + (e && e.code), t("No se pudo llegar al servidor. ¿Está encendido server.mjs y abierto el túnel?", "Could not reach the server. Is server.mjs running and the tunnel open?"));
  }
  if (r.status === 401) throw fail("auth_required", "401", t("El servidor no acepta el token. Copia otra vez el de data/token.", "The server does not accept the token. Copy the one in data/token again."));
  if (r.status === 413) throw fail("unavailable", "413", t("La copia es demasiado grande para el servidor.", "The copy is too large for the server."));
  if (r.status === 429) throw kino.error("rate_limited", "429");
  if (r.status >= 300 && r.status < 400) throw fail("unavailable", "redirect " + r.status, t("Esa dirección redirige a otra parte: revisa la dirección del túnel.", "That address redirects elsewhere: check the tunnel address."));
  if (r.status === 404 || r.status === 530 || r.status === 502 || r.status === 503) throw fail("unavailable", "status " + r.status, t("El túnel no responde: puede que su dirección haya cambiado o que server.mjs esté apagado.", "The tunnel does not answer: its address may have changed or server.mjs is off."));
  return r;
}

const versionOf = (r) => {
  const v = String(r.headers["x-version"] || "").trim();
  if (!v) throw fail("unavailable", "answer without X-Version", t("Esa dirección no es la de server.mjs.", "That address is not server.mjs."));
  return v;
};

/** The stored blob and its version, or null when the server holds nothing yet. */
export async function syncPull() {
  const r = await call("GET", {});
  if (r.status === 204) return null;
  if (r.status !== 200) throw kino.error("unavailable", "pull status " + r.status);
  const version = versionOf(r);
  return { blob: r.base64(), version };
}

/** Stores the blob if the server still holds [expectedVersion] (null = empty); a 409 is Kino's "conflict". */
export async function syncPush({ blob, expectedVersion, maxBlobBytes }) {
  if (typeof blob !== "string" || !blob) throw kino.error("invalid_request", "no blob");
  // Base64 is 4 characters per 3 bytes; a blob over the cap is refused before it is sent.
  if (maxBlobBytes && Math.floor((blob.length * 3) / 4) > maxBlobBytes + 2) throw kino.error("invalid_request", "blob over maxBlobBytes");
  const r = await call("PUT", { "If-Match": expectedVersion == null || expectedVersion === "" ? "0" : String(expectedVersion), "Content-Type": "application/octet-stream" }, { base64: blob });
  if (r.status === 409) throw kino.error("conflict", "the stored copy changed (server " + String(r.headers["x-version"] || "?") + ")");
  if (r.status !== 200) throw kino.error("unavailable", "push status " + r.status);
  return { version: versionOf(r) };
}

/** Ready when the server answers with this token. HEAD: the status line never downloads the stored blob. */
export async function syncStatus() {
  try {
    const r = await call("HEAD", {});
    if (r.status === 204) return { ready: true, message: t("Conectado. El servidor aún no guarda nada.", "Connected. The server stores nothing yet.") };
    if (r.status === 200) return { ready: true, message: t("Conectado.", "Connected.") };
    return { ready: false, message: t("El servidor respondió " + r.status + ".", "The server answered " + r.status + ".") };
  } catch (e) {
    return { ready: false, message: (e && e.say) || t("No se pudo consultar el servidor.", "Could not ask the server.") };
  }
}

// --- The settings form (Conectar) ---

async function describe() {
  const s = await syncStatus();
  return s.message;
}

export async function settingsStatus() {
  if (!String(kino.config.get("serverUrl") || "").trim()) return { status: t("Escribe la dirección de tu servidor.", "Type your server's address.") };
  if (!String(kino.config.get("token") || "").trim()) return { status: t("Pega el token.", "Paste the token.") };
  return { status: await describe() };
}

export async function action(key) {
  if (key === "check") return { message: await describe() };
  return { message: t("Nada que hacer.", "Nothing to do.") };
}

export async function validateSettings(values) {
  const out = {};
  const url = String(values.serverUrl || "").trim();
  if (url) {
    try { serverBase(url); } catch (e) { out.serverUrl = e.say || t("Dirección no válida.", "Not a valid address."); }
  }
  const token = String(values.token || "").trim();
  if (token && token.length < 32) out.token = t("Ese token es muy corto: copia el de data/token completo.", "That token is too short: copy the whole one in data/token.");
  return Object.keys(out).length ? out : null;
}
