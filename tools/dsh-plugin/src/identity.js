/**
 * Identity resolution for `@myco/dsh-plugin`.
 *
 * Everything in this module is independent of DSH: no `@deepseek-ai/*` import,
 * no network, no hard-coded absolute path (the Windows default install
 * location is *derived* from `%LOCALAPPDATA%` / the OS home). The plugin entry
 * (`./index.js`) only wires these pure helpers into the Cordis lifecycle, so
 * the whole decision table — logged in, unlinked, half-broken, missing title,
 * timeout, garbage output — is unit-testable without a Harness.
 *
 * 2026-11-07 起本模块在同一注入里追加 `[myco:协作智能体清单]` 块
 * （DESIGN-agent-directory.md §4.1）：`baseText()` 从 directory.js 的模块级
 * 30s 缓存**同步**读取已构建好的清单；本模块自身仍然零网络——探测与重建
 * 都在 directory.js 的后台路径里完成，缓存为空时清单块整体省略。
 *
 * @module @myco/dsh-plugin/identity
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { directoryBlockText } from "./directory.js";

/** Registered runtime-context name. Stable: other plugins may grep for it. */
export const CONTEXT_NAME = "myco:session-identity";

/** Root (person) DID method owned by the youling identity service. */
export const ROOT_DID_PREFIX = "did:youling:";

/** Device (embodiment) DID method owned by myco. */
export const DEVICE_DID_PREFIX = "did:myco:";

/** Order slot: right after the first-party 125 TEAM_IDENTITY and before 200 HARNESS_SOURCE. */
export const DEFAULT_ORDER = 130;

/** Hard ceiling for one `myco cli status` probe, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 1000;

/** Arguments of the identity probe. Overridable only for tests / future CLI shapes. */
export const DEFAULT_STATUS_ARGS = Object.freeze(["cli", "status"]);

/** stdout cap for one probe. */
export const MAX_BUFFER = 256 * 1024;

/** Placeholder used when a session object has no usable id (defensive only). */
export const MISSING_SESSION_ID = "(missing session id)";

/**
 * Trim one configured path-ish string.
 * @param value - candidate value of unknown type.
 * @returns the trimmed non-empty string, or `undefined`.
 */
function configuredPath(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Locate the myco executable.
 *
 * Precedence, highest first: the plugin's `mycoExe` configuration, `$MYCO_EXE`,
 * the platform default install directory, then a `PATH` scan. A configured or
 * environment path is returned verbatim even when it does not exist, so an
 * explicit operator choice always wins (and fails loudly into the degrade
 * path) instead of silently falling through to another binary.
 *
 * @param options - resolution inputs; every one is injectable for tests.
 * @returns the chosen executable and which rule chose it.
 */
export function resolveMycoExe(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const home = options.home ?? homedir();

  const fromConfig = configuredPath(options.configured);
  if (fromConfig !== undefined) return { exe: fromConfig, source: "config" };

  const fromEnv = configuredPath(env.MYCO_EXE);
  if (fromEnv !== undefined) return { exe: fromEnv, source: "env" };

  const windows = platform === "win32";
  if (windows) {
    const localAppData = configuredPath(env.LOCALAPPDATA);
    const candidates = [];
    if (localAppData !== undefined) candidates.push(join(localAppData, "Programs", "Youling", "myco.exe"));
    candidates.push(join(home, "AppData", "Local", "Programs", "Youling", "myco.exe"));
    for (const candidate of candidates) {
      if (exists(candidate)) return { exe: candidate, source: "default" };
    }
  }

  const names = windows ? ["myco.exe", "myco.cmd", "myco"] : ["myco"];
  for (const directory of String(env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    for (const candidateName of names) {
      const candidate = join(directory, candidateName);
      if (exists(candidate)) return { exe: candidate, source: "path" };
    }
  }
  return { exe: windows ? "myco.exe" : "myco", source: "none" };
}

/**
 * Parse one `myco cli status` stdout payload.
 *
 * Tolerates banner lines before or after the JSON object, because the CLI
 * prints human diagnostics on some failure paths; anything that does not
 * contain a complete JSON object yields `undefined`.
 *
 * @param text - raw stdout.
 * @returns the parsed object, or `undefined` when it is not a JSON object.
 */
export function parseStatus(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = parseObject(trimmed) ?? parseObject(sliceObject(trimmed));
  return parsed;
}

/**
 * Parse strict JSON into a plain object.
 * @param text - candidate JSON text.
 * @returns the object, or `undefined` for arrays/scalars/syntax errors.
 */
function parseObject(text) {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/**
 * Slice the outermost `{...}` span of a noisy payload.
 * @param text - raw stdout.
 * @returns the sliced text, or `undefined` when no span exists.
 */
function sliceObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}

/**
 * Require a DID token whose method-specific body is non-empty.
 *
 * `did:youling:` with an empty body is not an identity, it is a truncated
 * string: injecting it would put a half DID in front of the model. The prefix
 * alone is never enough.
 *
 * @param token - candidate DID token.
 * @param prefix - expected method prefix, including the trailing colon.
 * @returns the token when it carries a body, or `undefined`.
 */
function didWithBody(token, prefix) {
  if (typeof token !== "string") return undefined;
  const trimmed = token.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  return trimmed.length > prefix.length ? trimmed : undefined;
}

/**
 * Decide whether a status payload represents a logged-in myco session.
 *
 * This is the single gate for every DID line: a valid `did:youling:` root DID
 * with a non-empty body, a role other than `unlinked`, and a valid `did:myco:`
 * device DID with a non-empty body. Anything else — including a valid device
 * DID next to a missing root DID — is logged out.
 *
 * @param status - parsed status payload.
 * @returns `true` only for a complete, logged-in identity.
 */
export function isLoggedIn(status) {
  if (status === null || typeof status !== "object") return false;
  const { rootDid, role, deviceDid } = status;
  if (didWithBody(rootDid, ROOT_DID_PREFIX) === undefined) return false;
  if (role === "unlinked") return false;
  if (didWithBody(deviceDid, DEVICE_DID_PREFIX) === undefined) return false;
  return true;
}

/**
 * Normalize one DID into a single safe token.
 * @param value - candidate DID of unknown type.
 * @returns the trimmed token, or `undefined` when it is empty or multi-line.
 */
function didToken(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // eslint-disable-next-line no-control-regex -- control characters must never reach the prompt
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Read the two DIDs that may be injected.
 *
 * Returns `undefined` unless the session is logged in *and* both DIDs are
 * single-line tokens with the expected method prefix — the "abnormal shape"
 * state must degrade to no DID lines rather than half a group.
 *
 * @param status - parsed status payload.
 * @returns the injectable identity, or `undefined`.
 */
export function readIdentity(status) {
  if (!isLoggedIn(status)) return undefined;
  const rootDid = didToken(status.rootDid);
  const deviceDid = didToken(status.deviceDid);
  if (didWithBody(rootDid, ROOT_DID_PREFIX) === undefined) return undefined;
  if (didWithBody(deviceDid, DEVICE_DID_PREFIX) === undefined) return undefined;
  return Object.freeze({ rootDid, deviceDid });
}

/**
 * Read one JSON document from disk.
 *
 * A missing/corrupt file is not an error: the caller degrades to “no name”.
 *
 * @param file - absolute path.
 * @returns the parsed value, or `undefined`.
 */
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Find the first non-revoked, non-logged-out entry with the exact DID.
 * @param entries - candidate account/device records.
 * @param did - DID to match.
 * @param rejectedField - field that marks an unusable record.
 * @returns the matching record, or `undefined`.
 */
function activeEntry(entries, did, rejectedField) {
  if (!Array.isArray(entries)) return undefined;
  return entries.find((entry) => entry?.did === did && entry[rejectedField] !== true);
}

/**
 * Read the human-friendly account/device names from myco's local registry.
 *
 * Names are optional decoration: when either file is missing, corrupt, or has
 * no exact DID match, the corresponding name is simply omitted and the DID is
 * still injected inside angle brackets.
 *
 * @param status - a parsed, logged-in `myco cli status` payload.
 * @returns `{ accountName?, deviceName? }`; either field may be absent.
 */
export async function readNames(status) {
  if (!isLoggedIn(status)) return Object.freeze({});
  const configDir = typeof status.configDir === "string" ? status.configDir.trim() : "";
  if (configDir.length === 0) return Object.freeze({});

  const [accounts, devices] = await Promise.all([
    readJson(join(configDir, "accounts.json")),
    readJson(join(configDir, "authorized-dids.json")),
  ]);
  const account = activeEntry(accounts, status.rootDid, "loggedOut");
  const device = activeEntry(devices, status.deviceDid, "revoked");
  return Object.freeze({
    ...account?.name === undefined ? {} : { accountName: cleanLine(account.name) },
    ...device?.name === undefined ? {} : { deviceName: cleanLine(device.name) },
  });
}

/**
 * Normalize one title/client string into a prompt-safe single line.
 * @param value - candidate text of unknown type.
 * @returns the cleaned line, or `undefined` when nothing visible remains.
 */
export function cleanLine(value) {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex -- ANSI/control noise comes from terminal titles
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? undefined : collapsed;
}

/**
 * Render the always-present part of the runtime context.
 *
 * When directory.js has a cached 协作智能体清单 (30s TTL, module-level), the
 * `[myco:协作智能体清单]` block is appended in the same injection. The read
 * is synchronous and infallible: no cache → no block, never a prompt failure.
 *
 * @param sessionId - session identifier.
 * @param title - latest session title, already cleaned.
 * @returns the base block, without DID lines.
 */
export function baseText(sessionId, title) {
  const lines = ["[myco:session-identity] 本会话自身身份（myco runtime context）"];
  lines.push(`- sessionId: ${sessionId}`);
  if (title !== undefined) lines.push(`- title: ${title}`);
  const base = lines.join("\n");
  const directory = directoryBlockText();
  return directory === undefined ? base : `${base}\n\n${directory}`;
}

/**
 * Render the logged-in DID block.
 * @param identity - identity returned by {@link readIdentity}.
 * @returns the two DID lines, or the empty string.
 */
export function didLines(identity) {
  if (identity === undefined) return "";
  const accountPrefix = identity.accountName === undefined ? "" : `${identity.accountName} `;
  const devicePrefix = identity.deviceName === undefined ? "" : `${identity.deviceName} `;
  return `- youling账号: ${accountPrefix}<${identity.rootDid}>\n- myco设备: ${devicePrefix}<${identity.deviceDid}>`;
}

/**
 * Render the complete runtime context.
 * @param sessionId - session identifier.
 * @param title - latest session title, already cleaned.
 * @param identity - injectable identity, or `undefined` when logged out.
 * @returns the exact text this plugin contributes.
 */
export function contextText(sessionId, title, identity) {
  const base = baseText(sessionId, title);
  const dids = didLines(identity);
  return dids.length === 0 ? base : `${base}\n${dids}`;
}

/**
 * Classify one failed probe.
 * @param error - the `execFile` error.
 * @returns a short machine reason used in logs and tests.
 */
function failureReason(error) {
  if (error === null || error === undefined) return "exit";
  if (typeof error === "object") {
    if (error.name === "AbortError" || error.code === "ABORT_ERR") return "aborted";
    if (error.killed === true || error.signal === "SIGKILL" || error.code === "ETIMEDOUT") return "timeout";
    if (error.code === "ENOENT" || error.code === "EACCES") return "spawn";
  }
  return "exit";
}

/**
 * Run one `myco cli status` probe with a hard timeout and a real kill.
 *
 * The child is spawned without a shell, so the recorded pid is the executable
 * itself and `killSignal: SIGKILL` really terminates it (on Windows Node maps
 * SIGKILL to `TerminateProcess`). Every failure mode — missing binary,
 * non-zero exit, timeout, unparsable stdout — resolves to a `result` instead
 * of throwing: a broken identity probe must never fail prompt assembly.
 *
 * @param options - probe inputs; `execFileImpl` is injectable for tests.
 * @returns the parsed status (when any) plus timing and the failure reason.
 */
export async function queryIdentity(options = {}) {
  const exe = typeof options.exe === "string" ? options.exe.trim() : "";
  if (exe.length === 0) return { status: undefined, reason: "no-exe", elapsedMs: 0, pid: undefined };

  const args = Array.isArray(options.statusArgs) && options.statusArgs.length > 0
    ? options.statusArgs
    : DEFAULT_STATUS_ARGS;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const run = options.execFileImpl ?? execFile;
  const startedAt = Date.now();

  let pid;
  try {
    const stdout = await new Promise((resolve, reject) => {
      const child = run(exe, args, {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        ...options.signal === undefined ? {} : { signal: options.signal },
        ...options.env === undefined ? {} : { env: options.env },
      }, (error, out) => {
        if (error !== null && error !== undefined) reject(error);
        else resolve(out);
      });
      if (child !== undefined && child !== null && typeof child.pid === "number") pid = child.pid;
    });
    const elapsedMs = Date.now() - startedAt;
    const status = parseStatus(stdout);
    if (status === undefined) return { status: undefined, reason: "bad-output", elapsedMs, pid };
    return { status, reason: "ok", elapsedMs, pid };
  } catch (error) {
    return { status: undefined, reason: failureReason(error), elapsedMs: Date.now() - startedAt, pid };
  }
}
