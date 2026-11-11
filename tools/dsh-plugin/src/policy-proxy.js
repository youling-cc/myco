/**
 * Semantic P/A for the credential-free web listener (architecture §3,
 * agreed with the myco session 2026-11-08):
 *
 *   control plane — myco pushes `{ viewerDID → policy }` over a dedicated
 *   loopback control port; every message is HMAC-signed with a local shared
 *   key and replay-protected (nonce + timestamp window).
 *   data plane — one local port per authorized viewer (17878 = owner,
 *   17901+ per viewer); the policy attached to a port decides, per request:
 *     - method-level: RPC methods outside `allow` get a benign error envelope
 *     - session allowlist: RPCs touching a session outside `sessions` get the
 *       same envelope; `session/list` responses have foreign items filtered.
 *   No entry = full access (own-device trust model); the owner port never
 *   applies a policy.
 *
 * The benign envelope mirrors what the DSH gateway itself answers
 * (measured 2026-11-08): HTTP 200 with
 * `{"type":"server-response","rpcId":…,"result":{"ok":false,"error":{…}}}`.
 *
 * @module @myco/dsh-plugin/policy-proxy
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { effectiveCaps, effectiveVisibility, judgeMethod, sessionVisible } from "./judge-engine.js";

/** Control-plane key file (plugin writes it once; myco reads it). */
export const CONTROL_KEY_FILE = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return `${home}/.dsh/web-proxy-control.key`;
};

/** Signed messages older/further than this from now are rejected (ms). */
export const TIMESTAMP_WINDOW_MS = 60_000;

/** Maximum remembered nonces (bounded replay cache). */
export const NONCE_CACHE_MAX = 512;

/** Error code the proxy itself denies with. */
export const POLICY_DENIED_CODE = "myco/policy-denied";

/* ─────────────────────────── shared control key ─────────────────────────── */

/** Bare uuid or `session-<uuid>` compare on the bare form. */
export function normalizeSessionId(value) {
  return typeof value === "string" && value.startsWith("session-") ? value.slice("session-".length) : value;
}

/**
 * Load the control key, creating it on first use.
 * @param path - key file path.
 * @returns the key bytes.
 */
export async function ensureControlKey(path = CONTROL_KEY_FILE()) {
  try {
    const text = (await readFile(path, "utf8")).trim();
    const key = Buffer.from(text, "base64url");
    if (key.length >= 32) return key;
  } catch {
    // absent: create below
  }
  const key = randomBytes(32);
  await writeFile(path, `${key.toString("base64url")}\n`, { encoding: "utf8", mode: 0o600 });
  return key;
}

/**
 * Canonical signing input: the message body without `sig`, stable key order.
 * @param body - the parsed message object.
 * @returns the canonical string.
 */
export function canonicalBody(body) {
  const { sig, ...rest } = body ?? {};
  const sorted = sortDeep(rest);
  return JSON.stringify(sorted);
}

/** Recursively sort object keys for a stable serialization. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

/* ─────────────────────────── the policy store ───────────────────────────── */

/**
 * In-memory policy store with per-viewer entries and a nonce replay cache.
 * All lookups are synchronous: the data plane must never await to decide.
 */
export class PolicyStore {
  /**
   * @param {{now?: () => number, statePath?: string, log?: (m: string) => void}} [options]
   *   injectable clock + **策略持久化路径**（2026-11-11 用户裁决：授权表绝不能因重启丢失）。
   */
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.statePath = typeof options.statePath === "string" && options.statePath.length > 0
      ? options.statePath
      : undefined;
    /** @type {Map<string, {allow?: Set<string>, sessions?: Set<string>, port?: number, updatedAt: number}>} */
    this.viewers = new Map();
    this.seenNonces = new Map();
    this.loaded = false;
  }

  /**
   * Load the persisted policy table (write-through mirror of control-plane pushes).
   * Missing/corrupt file = empty table (a fresh install); never throws.
   * @returns the number of entries loaded.
   */
  async load() {
    if (this.statePath === undefined) { this.loaded = true; return 0; }
    let raw;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch {
      this.loaded = true;
      return 0;
    }
    try {
      const parsed = JSON.parse(raw);
      for (const [did, entry] of Object.entries(parsed.viewers ?? {})) {
        const engine = entry?.engine;
        const simple = entry?.simple;
        if (engine === undefined && simple === undefined) continue;
        this.viewers.set(did, {
          kind: engine === undefined ? "simple" : "engine",
          admin: engine?.admin === true,
          label: engine?.label,
          judgeCaps: engine?.judgeCaps,
          judgeVis: engine?.judgeVis,
          allow: Array.isArray(simple?.allow) ? new Set(simple.allow) : undefined,
          sessions: Array.isArray(simple?.sessions) ? new Set(simple.sessions) : undefined,
          updatedAt: typeof entry?.updatedAt === "number" ? entry.updatedAt : this.now(),
        });
      }
      this.log(`policy-store: loaded ${this.viewers.size} viewer(s) from ${this.statePath}`);
    } catch {
      this.log(`policy-store: ${this.statePath} unreadable — starting empty`);
    }
    this.loaded = true;
    return this.viewers.size;
  }

  /** Write-through persist (atomic: tmp + rename). Best-effort; failures only log. */
  async persist() {
    if (this.statePath === undefined) return;
    const viewers = {};
    for (const [did, entry] of this.viewers) {
      viewers[did] = {
        updatedAt: entry.updatedAt,
        engine: entry.kind === "engine"
          ? { admin: entry.admin, label: entry.label, judgeCaps: entry.judgeCaps, judgeVis: entry.judgeVis }
          : undefined,
        simple: entry.kind === "simple"
          ? { allow: entry.allow === undefined ? undefined : [...entry.allow],
              sessions: entry.sessions === undefined ? undefined : [...entry.sessions] }
          : undefined,
      };
    }
    const payload = JSON.stringify({ version: 1, savedAt: this.now(), viewers }, null, 2);
    const tmp = `${this.statePath}.tmp-${process.pid}`;
    try {
      await mkdir(dirname(this.statePath), { recursive: true });
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, this.statePath);
    } catch (error) {
      try { await unlink(tmp); } catch { /* ignore */ }
      this.log(`policy-store: persist failed (${String(error?.message ?? error)})`);
    }
  }

  /**
   * Verify one control-plane message and apply it.
   * @param {object} body - parsed JSON body.
   * @param {Buffer} key - control key bytes.
   * @returns `{ok: true, opened?: number, closed?: boolean, policy}` or `{ok: false, error}`.
   */
  apply(body, key) {
    const verdict = this.verify(body, key);
    if (!verdict.ok) return verdict;
    const viewerDid = String(body.viewerDid ?? "").trim();
    if (viewerDid.length === 0) return { ok: false, error: "viewerDid required" };

    if (body.closePort === true) {
      const existing = this.viewers.get(viewerDid);
      const port = existing?.port;
      this.viewers.delete(viewerDid);
      // 撤销必须写穿落盘，否则重启后撤销失效（2026-11-11 持久化测试抓到）。
      void this.persist();
      return { ok: true, closed: true, port };
    }

    const existing = this.viewers.get(viewerDid);
    let entry;
    if (body.authz !== null && typeof body.authz === "object") {
      // Engine format (final architecture 2③): raw authorization data; the
      // judge engine derives the effective caps/visibility here.
      const authz = body.authz;
      const label = typeof authz.viewerLabel === "string" && authz.viewerLabel.trim().length > 0
        ? authz.viewerLabel.trim()
        : (typeof body.viewerLabel === "string" && body.viewerLabel.trim().length > 0 ? body.viewerLabel.trim() : undefined);
      entry = {
        kind: "engine",
        admin: authz.admin === true,
        label,
        judgeCaps: effectiveCaps(authz.taskCaps ?? {}, authz.grant),
        judgeVis: effectiveVisibility(authz.taskVis ?? {}, authz.grant),
        port: existing?.port,
        updatedAt: this.now(),
      };
    } else {
      // Interim format (allow/sessions result table) — kept until myco
      // switches to the engine format; semantics: outside-list = deny.
      const allow = Array.isArray(body.allow) && body.allow.every((item) => typeof item === "string")
        ? new Set(body.allow)
        : undefined;
      const sessions = Array.isArray(body.sessions) && body.sessions.every((item) => typeof item === "string")
        ? new Set(body.sessions.map(normalizeSessionId))
        : undefined;
      entry = {
        kind: "simple",
        allow: allow ?? existing?.allow,
        sessions: sessions ?? existing?.sessions,
        port: existing?.port,
        updatedAt: this.now(),
      };
    }
    this.viewers.set(viewerDid, entry);
    void this.persist();
    return { ok: true, policy: entry };
  }

  /**
   * Signature / replay verification only.
   * @param {object} body - parsed JSON body.
   * @param {Buffer} key - control key bytes.
   * @returns `{ok:true}` or `{ok:false, error}`.
   */
  verify(body, key) {
    if (body === null || typeof body !== "object") return { ok: false, error: "bad-body" };
    const { sig } = body;
    if (typeof sig !== "string" || sig.length === 0) return { ok: false, error: "missing-sig" };
    const expected = createHmac("sha256", key).update(canonicalBody(body)).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: "bad-sig" };
    const ts = Number(body.ts);
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > TIMESTAMP_WINDOW_MS) {
      return { ok: false, error: "stale-ts" };
    }
    const nonce = String(body.nonce ?? "");
    if (nonce.length === 0) return { ok: false, error: "missing-nonce" };
    if (this.seenNonces.has(nonce)) return { ok: false, error: "replayed-nonce" };
    this.seenNonces.set(nonce, this.now());
    if (this.seenNonces.size > NONCE_CACHE_MAX) {
      const cutoff = this.now() - 2 * TIMESTAMP_WINDOW_MS;
      for (const [value, at] of this.seenNonces) {
        if (at < cutoff) this.seenNonces.delete(value);
      }
    }
    return { ok: true };
  }

  /**
   * The policy governing one local port (`undefined` = full access).
   * @param {number} port - listener port.
   * @returns the viewer entry, or `undefined`.
   */
  byPort(port) {
    for (const entry of this.viewers.values()) {
      if (entry.port === port) return entry;
    }
    return undefined;
  }

  /** Snapshot for `GET /policy` (myco restart recovery). */
  describe() {
    return [...this.viewers.entries()].map(([viewerDid, entry]) => ({
      viewerDid,
      port: entry.port,
      kind: entry.kind ?? "simple",
      label: entry.label,
      allow: entry.allow === undefined ? undefined : [...entry.allow],
      sessions: entry.sessions === undefined ? undefined : [...entry.sessions],
      updatedAt: entry.updatedAt,
    }));
  }
}

/* ─────────────────────────── decision helpers ───────────────────────────── */

/**
 * Decide one HTTP request against a policy entry (either format).
 * Engine entries run the ported Rust chain; simple entries keep the
 * interim allow-list semantics.
 * @param policy - viewer entry or `undefined` (owner port).
 * @param {string} method - RPC method derived from the URL.
 * @returns `{allowed: true}` or `{allowed: false, reason, rule?}`.
 */
export function decideHttp(policy, method) {
  if (policy === undefined) return { allowed: true };
  if (method === undefined) return { allowed: true }; // static assets etc.
  if (policy.kind === "engine") return judgeMethod(policy.judgeCaps, method, policy.admin === true);
  if (policy.allow !== undefined && !policy.allow.has(method)) {
    return { allowed: false, reason: `method "${method}" not in allow list` };
  }
  return { allowed: true };
}

/**
 * Decide one session-scoped call against the session allowlist (either
 * format: engine visibility or simple allowlist).
 * @param policy - viewer entry or `undefined`.
 * @param {string} sessionId - the session the call touches.
 * @returns `{allowed: true}` or `{allowed: false, reason}`.
 */
export function decideSession(policy, sessionId) {
  if (policy === undefined) return { allowed: true };
  if (policy.kind === "engine") {
    return sessionVisible(policy.judgeVis, sessionId)
      ? { allowed: true }
      : { allowed: false, reason: "session outside visibility" };
  }
  if (policy.sessions === undefined) return { allowed: true };
  if (typeof sessionId !== "string" || !policy.sessions.has(normalizeSessionId(sessionId))) {
    return { allowed: false, reason: "session outside allowlist" };
  }
  return { allowed: true };
}

/**
 * Decide one WS stream-open against a policy.
 * @param policy - viewer entry or `undefined`.
 * @param {string} endpoint - opened endpoint (`session/follow`).
 * @returns `{allowed: true}` or `{allowed: false, reason}`.
 */
export function decideStream(policy, endpoint) {
  if (policy === undefined) return { allowed: true };
  if (policy.allow !== undefined && !policy.allow.has(endpoint)) {
    return { allowed: false, reason: `endpoint "${endpoint}" not in allow list` };
  }
  return { allowed: true };
}

/* ─────────────────────────── the benign envelope ────────────────────────── */

/**
 * Build the benign denial envelope (DSH gateway shape, measured 2026-11-08).
 * @param {string} rpcId - the caller's rpcId, echoed back.
 * @param {string} reason - human-readable denial reason.
 * @returns the serialized envelope.
 */
export function denialEnvelope(rpcId, reason) {
  return JSON.stringify({
    type: "server-response",
    rpcId: rpcId ?? null,
    result: {
      ok: false,
      error: {
        code: POLICY_DENIED_CODE,
        message: `dsh-web-proxy: ${reason}`,
      },
    },
  });
}

/**
 * Build a mux error frame for a denied stream open.
 * @param {string} streamId - the stream the client opened.
 * @param {string} reason - denial reason.
 * @returns the frame text.
 */
export function denialStreamFrame(streamId, reason) {
  return JSON.stringify({
    type: "error",
    streamId: streamId ?? null,
    error: { code: POLICY_DENIED_CODE, message: `dsh-web-proxy: ${reason}` },
  });
}

/**
 * Extract the RPC method from a proxied URL path (`/api/<ns>/<method>`).
 * @param {string} url - request URL.
 * @returns e.g. `session/list`, or `undefined` for non-RPC paths.
 */
export function methodFromUrl(url) {
  const match = /^\/api\/([a-z-]+)\/([a-z-]+)\/?$/i.exec(url ?? "");
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}
