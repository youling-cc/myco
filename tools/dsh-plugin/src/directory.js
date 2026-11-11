/**
 * Agent Directory — 协作智能体清单（数据层）。
 *
 * 设计源：docs/DESIGN-agent-directory.md。三个数据源合并成一份统一的
 * Agent Entry 列表，渲染成注入 systemPrompt 的人话摘要：
 *
 *   A. myco 好友列表  — `GET http://127.0.0.1:3102/api/chat_state`
 *      （端口不通再试 3103；返回 `{friends:[{did,name,status,pending}]}`，
 *       过滤 pending）。注意：截至 2026-11-07 桌面端管理面尚未挂
 *       `/api/chat_state` HTTP 路由（404），因此 HTTP 失败后回退
 *       `myco cli chat state`（cli.rs:897，实测同形状，含 `myDid`）。
 *   B. myco 分享注册表 — `GET :3102/api/dshShare/list`（同样 3103 兜底），
 *      返回 `{shares:[...]}`，过滤 `state === "closed"`。
 *   C. 本机 DSH 会话 — typed RPC `session/list`（`DSH_WEB_URL`，默认
 *      `http://127.0.0.1:19387`），带自签 browser-session cookie，过滤当前
 *      会话（`DSH_SESSION_ID`，注意 RPC 项带 `session-` 前缀而环境变量不带）。
 *
 * 容错：任一数据源不可达 → 该类清空 + 一句说明，绝不影响其他类，也绝不
 * 让 prompt 组装失败。
 *
 * 缓存：清单不需要每请求重建。模块级缓存 + 30s TTL；`getDirectorySnapshot()`
 * 同步读缓存（可返回过期值），过期时后台触发一次重建（dedup、绝不抛）。
 * vitest 环境默认关闭自动拉取（`MYCO_DIRECTORY_AUTOFETCH=0/1` 可强制），
 * 保证现有 identity/plugin 测试的确定性。
 *
 * 本模块不 import identity.js（identity 反向 import 本模块取注入文本，
 * 避免 ESM 环），因此自带 cleanLine / parseJsonObject 等小工具。
 *
 * @module @myco/dsh-plugin/directory
 */

import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Registered runtime-context block name (inside the identity injection). */
export const DIRECTORY_CONTEXT_NAME = "myco:协作智能体清单";

/** Header line of the injected block. */
export const DIRECTORY_BLOCK_HEADER = `[${DIRECTORY_CONTEXT_NAME}]`;

/** How long one built directory stays authoritative, in milliseconds. */
export const DIRECTORY_TTL_MS = 30_000;

/** Summary truncation: at most this many entries, then “…另有 N 个”. */
export const MAX_SUMMARY_ENTRIES = 20;

/** myco 桌面端管理面候选端口（主 3102，兜底 3103），按序尝试。 */
export const MYCO_API_PORTS = Object.freeze([3102, 3103]);

/** Default DSH web/RPC base URL; overridden by `$DSH_WEB_URL`. */
export const DEFAULT_DSH_WEB_URL = "http://127.0.0.1:19387";

/** One HTTP probe / CLI probe hard timeout, in milliseconds. */
export const DEFAULT_SOURCE_TIMEOUT_MS = 1500;

/**
 * `session/list` RPC budget, in milliseconds.
 *
 * 2026-11-08 实测（本机，1559 个会话）：整包 1.49 MB，暖态 335–392 ms。
 * 冷态要现开会话索引并序列化全部 projections，用通用的 1.5 s 探测预算会超时，
 * 表现为“本机DSH会话列表暂不可达”。这里留约 20 倍暖态余量，且整体预算
 * （SESSIONS_SOURCE_BUDGET_MS）仍低于 DIRECTORY_TTL_MS。
 */
export const DEFAULT_RPC_TIMEOUT_MS = 8000;

/** Whole sessions source budget across detected ports and retries, in milliseconds. */
export const SESSIONS_SOURCE_BUDGET_MS = 12_000;

/** Section titles in the summary, in source order (好友 > 分享 > 会话). */
export const SECTION_TITLES = Object.freeze({
  friend: "好友：",
  share: "分享任务：",
  session: "本机其他会话：",
});

/** Per-source “unreachable” notes rendered in place of the section body. */
export const SOURCE_NOTES = Object.freeze({
  friend: "好友列表暂不可达",
  share: "分享任务列表暂不可达",
  session: "本机DSH会话列表暂不可达",
});

/** Source order used for merging and sorting. */
const KIND_ORDER = Object.freeze(["friend", "share", "session"]);

/* ────────────────────────── small local helpers ────────────────────────── */

/**
 * Normalize one string into a prompt-safe single line (same rules as
 * identity.js `cleanLine`, duplicated to avoid an import cycle).
 * @param value - candidate text of unknown type.
 * @returns the cleaned line, or `undefined` when nothing visible remains.
 */
function cleanLine(value) {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex -- terminal/ANSI noise must never reach the prompt
  const stripped = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? undefined : collapsed;
}

/**
 * Parse one JSON object from a possibly noisy stdout payload.
 * @param text - raw stdout.
 * @returns the parsed plain object, or `undefined`.
 */
function parseJsonObject(text) {
  if (typeof text !== "string" || text.trim().length === 0) return undefined;
  const candidates = [text.trim()];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Last 4 characters of a DID (or any token) — the display last resort.
 * @param did - full DID string.
 * @returns the tail, or `undefined`.
 */
export function didTail4(did) {
  if (typeof did !== "string") return undefined;
  const trimmed = did.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(-4);
}

/**
 * Shorten one DID to `did:youling:z6Mk...sHaW` (body head4 + ... + tail4).
 * @param did - full DID string.
 * @returns the shortened form, or the raw value when it is not shortenable.
 */
export function shortDid(did) {
  if (typeof did !== "string") return undefined;
  const trimmed = did.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return trimmed;
  const prefix = trimmed.slice(0, colon + 1);
  const body = trimmed.slice(colon + 1);
  if (body.length <= 8) return trimmed;
  return `${prefix}${body.slice(0, 4)}...${body.slice(-4)}`;
}

/**
 * Normalize a session id for comparison: the RPC items carry a `session-`
 * prefix while `$DSH_SESSION_ID` does not — compare the bare uuid.
 * @param value - session id in any form.
 * @returns the prefix-stripped id, or `undefined`.
 */
function bareSessionId(value) {
  const cleaned = cleanLine(value);
  if (cleaned === undefined) return undefined;
  return cleaned.replace(/^session-/, "");
}

/* ───────────────────────────── entry builders ───────────────────────────── */

/**
 * Map one `chat_state.friends[]` record to a friend Agent Entry.
 * @param raw - `{did, name, status, pending?}`.
 * @returns the entry, or `undefined` when it must be skipped (pending / no did).
 */
export function friendEntry(raw) {
  if (raw === null || typeof raw !== "object") return undefined;
  if (raw.pending === true) return undefined;
  const did = cleanLine(raw.did);
  if (did === undefined) return undefined;
  const nickname = cleanLine(raw.name);
  return {
    kind: "friend",
    id: `friend-${did}`,
    did,
    friendNickname: nickname,
    online: raw.status === "ok",
    presence: raw.status === "ok" ? "active" : "offline",
    displayName: nickname ?? didTail4(did),
  };
}

/**
 * Does one grants[] record mark the share owner? Tolerates both the live
 * `label: "owner"` shape and a hypothetical `role`/boolean form.
 * @param grant - one grants[] record.
 * @returns `true` when the record is an owner grant.
 */
function isOwnerGrant(grant) {
  if (grant === null || typeof grant !== "object") return false;
  if (grant.label === "owner" || grant.role === "owner") return true;
  return grant.owner === true;
}

/**
 * Decide my role in one share.
 *
 * `myDid` from `chat_state` is the youling **root** DID while grants[] carry
 * **device** DIDs (live data, 2026-11-07), so owner is decided when either
 * level matches. Without `myDid`: fall back to the task-spec rule — any owner
 * grant in the registry entry means I am the owner, because the local
 * registry lists shares this machine participates in.
 *
 * @param grants - grants[] of the share.
 * @param myDid - my root DID (chat_state `myDid`) when known.
 * @param ownerAccount - the share's `ownerAccount` (youling DID) when present.
 * @returns `"owner"` or `"collaborator"`.
 */
function decideMyRole(grants, myDid, ownerAccount) {
  if (myDid !== undefined && ownerAccount !== undefined && ownerAccount === myDid) return "owner";
  const ownerGrants = Array.isArray(grants) ? grants.filter(isOwnerGrant) : [];
  if (ownerGrants.length === 0) return "collaborator";
  if (myDid === undefined) return "owner";
  return ownerGrants.some((grant) => grant.did === myDid) ? "owner" : "collaborator";
}

/**
 * Map one `dshShare/list` share record to a share Agent Entry.
 *
 * displayName priority (DESIGN §3.2): 任务自定义名 > 任务卡原始名 > shareId.
 * `ownerLabel`（"我" / 好友名 / 短DID）供摘要行渲染，需要好友表做交叉命名。
 *
 * @param raw - one shares[] record (`shareId` in the live API, `id` tolerated).
 * @param options - `{friendsByDid?, myDid?}`.
 * @returns the entry, or `undefined` when it must be skipped (closed / no id).
 */
export function shareEntry(raw, options = {}) {
  if (raw === null || typeof raw !== "object") return undefined;
  if (raw.state === "closed") return undefined;
  const shareId = cleanLine(raw.shareId ?? raw.id);
  if (shareId === undefined) return undefined;
  const taskTitle = cleanLine(raw.title);
  const customName = cleanLine(raw.customName ?? raw.customTitle ?? raw.renamedTitle);
  const boundSessionId = cleanLine(raw.sessionId);
  const ownerDid = cleanLine(raw.ownerAccount);
  const myRole = decideMyRole(raw.grants, options.myDid, ownerDid);
  const friendName = ownerDid === undefined ? undefined : options.friendsByDid?.get(ownerDid);
  return {
    kind: "share",
    id: `share-${shareId}`,
    shareId,
    taskTitle,
    customName,
    boundSessionId,
    myRole,
    ownerDid,
    ownerLabel: myRole === "owner"
      ? "我"
      : friendName ?? (ownerDid === undefined ? "他人" : shortDid(ownerDid)),
    displayName: customName ?? taskTitle ?? shareId,
  };
}

/**
 * Map one DSH `session/list` item to a session Agent Entry.
 *
 * `blank === true` 是“建了但还没有任何对话”的空壳会话（本机常有几百上千个，
 * 例如点一下「新会话」就留一个），它没有上下文、也接不了协作消息，一律跳过。
 *
 * @param raw - one items[] record (`sessionId`, `projections.values.title`, `blank`, `updatedAt`).
 * @returns the entry, or `undefined` when there is no usable session id or it is blank.
 */
export function sessionEntry(raw) {
  if (raw === null || typeof raw !== "object") return undefined;
  if (raw.blank === true) return undefined;
  const sessionId = cleanLine(raw.sessionId ?? raw.id);
  if (sessionId === undefined) return undefined;
  const title = cleanLine(raw?.projections?.values?.title) ?? cleanLine(raw.title);
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined;
  return {
    kind: "session",
    id: `session-${bareSessionId(sessionId)}`,
    sessionId,
    sessionTitle: title,
    running: raw.running === true,
    updatedAt,
    displayName: title ?? "（未命名会话）",
  };
}

/* ────────────────────────── pure assembly + render ──────────────────────── */

/**
 * Render the human-readable summary body (no block header).
 *
 * Sections appear in source order; each unreachable source renders its note
 * line in place of the body. Truncation is global: at most `maxEntries`
 * bullet lines across all sections, then one final `…另有 N 个` line.
 *
 * @param agents - merged entries, already in source order.
 * @param notes - per-kind unreachable note flags (`{friend:true}` …).
 * @param maxEntries - maximum rendered bullet lines.
 * @returns the summary text; empty string when there is nothing to say.
 */
export function renderSummary(agents, notes = {}, maxEntries = MAX_SUMMARY_ENTRIES) {
  const list = Array.isArray(agents) ? agents : [];
  const linesByKind = new Map();
  let shown = 0;
  let hidden = 0;
  for (const kind of KIND_ORDER) {
    const lines = [];
    const note = notes[kind] === true;
    const kindEntries = list.filter((entry) => entry?.kind === kind);
    if (note) {
      lines.push(`- （${SOURCE_NOTES[kind]}）`);
    } else {
      for (const entry of kindEntries) {
        if (shown < maxEntries) {
          lines.push(renderEntryLine(entry));
          shown += 1;
        } else {
          hidden += 1;
        }
      }
    }
    if (lines.length > 0) linesByKind.set(kind, lines);
  }
  const sections = [];
  for (const kind of KIND_ORDER) {
    const lines = linesByKind.get(kind);
    if (lines === undefined) continue;
    sections.push([SECTION_TITLES[kind], ...lines].join("\n"));
  }
  if (hidden > 0) sections.push(`…另有 ${hidden} 个`);
  return sections.join("\n\n");
}

/**
 * Render one bullet line for one entry.
 * @param entry - a built Agent Entry.
 * @returns the line.
 */
function renderEntryLine(entry) {
  if (entry.kind === "friend") {
    return `- ${entry.displayName} (${shortDid(entry.did)}) — ${entry.online ? "在线" : "离线"}`;
  }
  if (entry.kind === "share") {
    const bound = entry.boundSessionId === undefined
      ? "无绑定会话"
      : `绑定会话=${entry.boundSessionId}`;
    return `- "${entry.displayName}" (shareId=${entry.shareId}, owner=${entry.ownerLabel}, ${bound})`;
  }
  return `- "${entry.displayName}" (${entry.sessionId})`;
}

/**
 * Build the directory from already-fetched sources — the pure core.
 *
 * Each source value is either the raw record array (`friends`/`shares`/
 * `sessions`) or `{error: reason}` marking that source unreachable.
 * Bad records inside a reachable array are skipped individually.
 *
 * @param sources - `{friends?, shares?, sessions?, myDid?}`.
 * @param options - `{currentSessionId?, maxEntries?, now?}`.
 * @returns `{agents, summary, count, notes, shown, hidden, builtAt}`.
 */
export function buildDirectoryFromSources(sources = {}, options = {}) {
  const raw = sources !== null && typeof sources === "object" ? sources : {};
  const friendsByDid = new Map();
  const notes = {};
  const agents = [];

  const friendsSource = raw.friends;
  if (Array.isArray(friendsSource)) {
    for (const record of friendsSource) {
      const entry = friendEntry(record);
      if (entry === undefined) continue;
      if (entry.friendNickname !== undefined) friendsByDid.set(entry.did, entry.friendNickname);
      agents.push(entry);
    }
  } else if (isErrorSource(friendsSource)) {
    notes.friend = true;
  }

  const sharesSource = raw.shares;
  if (Array.isArray(sharesSource)) {
    for (const record of sharesSource) {
      const entry = shareEntry(record, { friendsByDid, myDid: cleanLine(raw.myDid) });
      if (entry !== undefined) agents.push(entry);
    }
  } else if (isErrorSource(sharesSource)) {
    notes.share = true;
  }

  const current = bareSessionId(options.currentSessionId);
  const sessionsSource = raw.sessions;
  if (Array.isArray(sessionsSource)) {
    const sessionEntries = [];
    for (const record of sessionsSource) {
      const entry = sessionEntry(record);
      if (entry === undefined) continue;
      if (current !== undefined && bareSessionId(entry.sessionId) === current) continue;
      sessionEntries.push(entry);
    }
    // Newest first: a stale session is the least useful thing to hand an AI
    // when only MAX_SUMMARY_ENTRIES bullets fit. Ties keep host order (stable sort).
    sessionEntries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    agents.push(...sessionEntries);
  } else if (isErrorSource(sessionsSource)) {
    notes.session = true;
  }

  const maxEntries = Number.isFinite(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : MAX_SUMMARY_ENTRIES;
  const summary = renderSummary(agents, notes, maxEntries);
  return {
    agents,
    summary,
    count: agents.length,
    notes,
    shown: Math.min(agents.length, maxEntries),
    hidden: Math.max(agents.length - maxEntries, 0),
    builtAt: typeof options.now === "function" ? options.now() : Date.now(),
  };
}

/**
 * A source value is “unreachable” when it is an object carrying `error`.
 * @param value - one source value.
 * @returns `true` when the value marks a failed source.
 */
function isErrorSource(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && typeof value.error === "string" && value.error.length > 0;
}

/**
 * Render the full injected block (header + intro + summary + footer).
 * @param result - a build result, or `undefined`.
 * @returns the block text, or `undefined` when there is nothing to inject.
 */
export function renderDirectoryBlock(result) {
  if (result === null || typeof result !== "object") return undefined;
  const summary = typeof result.summary === "string"
    ? result.summary
    : renderSummary(Array.isArray(result.agents) ? result.agents : [], result.notes ?? {});
  if (summary.length === 0) return undefined;
  return [
    DIRECTORY_BLOCK_HEADER,
    "你可以向以下对象发送跨会话/跨账号消息（用 myco skill 的 send 功能）：",
    "",
    summary,
    "",
    "发消息：调 myco skill / send.py --to <名称或ID> --stdin",
    "对方会话的 AI 会立即收到你的消息并处理。",
    "清单最多 30s 旧；要最新/完整清单（或按名称过滤）调 mcp__myco__list_agents。",
  ].join("\n");
}

/* ─────────────────────────────── data sources ───────────────────────────── */

/**
 * Resolve the myco executable (mirrors identity.js `resolveMycoExe` rules,
 * kept local to avoid an import cycle).
 * @param options - `{env?, mycoExe?, exists?}`.
 * @returns the executable path, or `undefined` when nothing plausible exists.
 */
function resolveMycoExeLocal(options = {}) {
  const env = options.env ?? process.env;
  const configured = options.mycoExe ?? env.MYCO_EXE;
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  if (process.platform === "win32") {
    const localAppData = typeof env.LOCALAPPDATA === "string" ? env.LOCALAPPDATA : undefined;
    const candidates = [];
    if (localAppData !== undefined) candidates.push(join(localAppData, "Programs", "Youling", "myco.exe"));
    candidates.push(join(homedir(), "AppData", "Local", "Programs", "Youling", "myco.exe"));
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Run one CLI probe and hand back its parsed JSON object.
 * @param options - `{exe, args, timeoutMs, execFileImpl?}`.
 * @returns the parsed object, or `undefined`.
 */
async function execJson(options) {
  const run = options.execFileImpl ?? execFile;
  return new Promise((resolve) => {
    try {
      run(options.exe, options.args, {
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
      }, (error, out) => {
        resolve(error === null || error === undefined ? parseJsonObject(out) : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Source A — myco friends (`chat_state`).
 *
 * HTTP first (3102 → 3103, per the task contract); when the management API
 * does not expose the route yet (live 404 as of 2026-11-07), fall back to
 * `myco cli chat state` which prints the same snapshot (including `myDid`).
 *
 * @param options - `{env?, fetchImpl?, execFileImpl?, timeoutMs?, mycoExe?}`.
 * @returns `{data, meta?}` or `{error}`; never throws.
 */
export async function fetchFriends(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  for (const port of MYCO_API_PORTS) {
    const result = await getJson(fetchImpl, `http://127.0.0.1:${port}/api/chat_state`, timeoutMs);
    if (result !== undefined) {
      return { data: Array.isArray(result.friends) ? result.friends : [], meta: { myDid: result.myDid } };
    }
  }
  const exe = resolveMycoExeLocal(options);
  if (exe !== undefined) {
    const parsed = await execJson({ exe, args: ["cli", "chat", "state"], timeoutMs, execFileImpl: options.execFileImpl });
    if (parsed !== undefined) {
      return { data: Array.isArray(parsed.friends) ? parsed.friends : [], meta: { myDid: parsed.myDid } };
    }
  }
  return { error: "unreachable" };
}

/**
 * Source B — myco share registry (`dshShare/list`), closed shares filtered
 * later at entry build time.
 * @param options - `{fetchImpl?, timeoutMs?}`.
 * @returns `{data}` or `{error}`; never throws.
 */
export async function fetchShares(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  for (const port of MYCO_API_PORTS) {
    const result = await getJson(fetchImpl, `http://127.0.0.1:${port}/api/dshShare/list`, timeoutMs);
    if (result !== undefined) {
      return { data: Array.isArray(result.shares) ? result.shares : [] };
    }
  }
  return { error: "unreachable" };
}

/**
 * GET one URL and parse a JSON object, swallowing every failure.
 * @param fetchImpl - fetch-like function.
 * @param url - absolute URL.
 * @param timeoutMs - hard timeout.
 * @returns the parsed object, or `undefined`.
 */
async function getJson(fetchImpl, url, timeoutMs) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response?.status !== 200) return undefined;
    return parseJsonObject(await response.text());
  } catch {
    return undefined;
  }
}

/**
 * Read the DSH browser-session secret from `~/.dsh/.credentials.yaml`.
 * @param options - `{dshHome?, readFileImpl?}`.
 * @returns the secret bytes, or `undefined`.
 */
export async function readDshSecret(options = {}) {
  const read = options.readFileImpl ?? readFile;
  const home = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  let text;
  try {
    text = await read(join(home, ".credentials.yaml"), "utf8");
  } catch {
    return undefined;
  }
  if (typeof text !== "string") return undefined;
  let inRecord = false;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("client-connection/browser-session:")) {
      inRecord = true;
      continue;
    }
    if (!inRecord) continue;
    if (stripped.length > 0 && !line.startsWith("    ")) {
      inRecord = false;
      continue;
    }
    if (stripped.startsWith("secret:")) {
      const value = stripped.slice("secret:".length).trim();
      if (value.length === 0) return undefined;
      return Buffer.from(value, "base64url");
    }
  }
  return undefined;
}

/**
 * Mint one DSH browser-session cookie (port of dsh_rpc.py `mint`).
 * @param authority - `127.0.0.1:<port>`.
 * @param secret - secret bytes.
 * @param now - injectable clock.
 * @returns the cookie header value.
 */
export function mintDshCookie(authority, secret, now = Date.now) {
  const issuedAt = now();
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 24 * 3600 * 1000 };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body, "utf8").digest();
  const name = createHash("sha256").update(authority, "utf8").digest().toString("base64url");
  return `dsh-auth-${name}=v1.${body}.${signature.toString("base64url")}`;
}

/**
 * Source C — local DSH sessions via typed RPC `session/list`.
 *
 * `$DSH_WEB_URL` is authoritative when present (shell children see it), but
 * the plugin host process may not carry it — the legacy default port is then
 * usually wrong, so failing candidates fall through to a netstat detection of
 * the "DeepSeek Harness" loopback listeners (same trick as tools/dsh_rpc.py).
 * DSH also has intermittent 401 busy windows (dsh_rpc.py, 2026-10-19): three
 * attempts with backoff, then degrade to `{error}` — the caller only loses
 * this one section, never the whole directory.
 *
 * @param options - `{env?, fetchImpl?, timeoutMs?, budgetMs?, dshWebUrl?, readFileImpl?, dshHome?, now?, execFileImpl?}`.
 *   `timeoutMs` here defaults to {@link DEFAULT_RPC_TIMEOUT_MS} (the 1.49 MB list
 *   needs more than the 1.5 s probe budget); `budgetMs` caps the whole source
 *   across all bases and retries (default {@link SESSIONS_SOURCE_BUDGET_MS}).
 * @returns `{data}` or `{error}`; never throws.
 */
export async function fetchSessions(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0
    ? options.budgetMs
    : SESSIONS_SOURCE_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const primary = cleanLine(options.dshWebUrl ?? options.env?.DSH_WEB_URL ?? DEFAULT_DSH_WEB_URL);
  const secret = await readDshSecret(options);
  if (secret === undefined) return { error: "no-credentials" };

  const bases = [];
  if (primary !== undefined) bases.push(primary);
  const detected = await detectDshPorts(options.execFileImpl);
  for (const port of detected) {
    const base = `http://127.0.0.1:${port}`;
    if (!bases.some((candidate) => candidate.replace(/\/+$/, "") === base)) bases.push(base);
  }
  if (bases.length === 0) return { error: "no-url" };

  for (const base of bases) {
    if (Date.now() >= deadline) return { error: "budget" };
    const result = await postSessionList(base, secret, { ...options, fetchImpl, timeoutMs, deadline });
    if (result !== undefined) return result;
  }
  return Date.now() >= deadline ? { error: "budget" } : { error: "unreachable" };
}

/**
 * POST one `session/list` RPC against one base URL.
 * @param base - base URL (`http://127.0.0.1:<port>`).
 * @param secret - browser-session secret bytes.
 * @param options - `{fetchImpl, timeoutMs, deadline?, now?}`.
 * @returns `{data}`/`{error}` when decided, or `undefined` to try the next base.
 */
async function postSessionList(base, secret, options) {
  const root = base.replace(/\/+$/, "");
  let url;
  try {
    url = new URL(root);
  } catch {
    return undefined;
  }
  const authority = url.host.includes(":") ? url.host : `${url.host}:${url.port || 80}`;
  const cookie = mintDshCookie(authority, secret, options.now ?? Date.now);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await delay(attempt === 1 ? 400 : 800);
    // Each attempt may only consume what is left of this source's budget.
    const remaining = options.deadline === undefined
      ? options.timeoutMs
      : Math.min(options.timeoutMs, options.deadline - Date.now());
    if (!(remaining > 0)) return { error: "budget" };
    try {
      const response = await options.fetchImpl(`${root}/api/session/list`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: `http://${authority}`,
        },
        body: JSON.stringify({
          type: "client-request",
          rpcId: `dir${Date.now() % 1000000}`,
          method: "session/list",
          payload: { args: { _request: {} } },
        }),
        signal: AbortSignal.timeout(remaining),
      });
      if (response?.status === 401) continue; // busy window: retry, same base
      if (response?.status !== 200) return undefined; // wrong port: next base
      const parsed = parseJsonObject(await response.text());
      const items = parsed?.result?.value?.items ?? parsed?.value?.items ?? parsed?.items;
      if (Array.isArray(items)) return { data: items };
      return { error: "bad-shape" };
    } catch {
      // connection refused / aborted (budget) / fetch failure
      if (options.deadline !== undefined && Date.now() >= options.deadline) return { error: "budget" };
      return undefined; // → next base
    }
  }
  return { error: "busy" };
}

/** Module-level cache of the netstat detection (ports live as long as the host). */
let detectedDshPorts;

/**
 * Detect the DSH desktop loopback listeners via tasklist+netstat — the same
 * candidate-port trick as tools/dsh_rpc.py, used only when the configured
 * base URL fails. Non-Windows / any failure yields an empty list.
 * Exported for web-listener.js: the desktop-shell host process carries no
 * `$DSH_WEB_URL`, so its plugin instance discovers its upstream this way.
 * @param execFileImpl - injectable execFile.
 * @returns distinct listening ports of the DSH process.
 */
export async function detectDshPorts(execFileImpl) {
  if (process.platform !== "win32") return [];
  if (detectedDshPorts !== undefined) return detectedDshPorts;
  const tasklist = await captureProcessOutput(execFileImpl, "tasklist", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"]);
  const netstat = await captureProcessOutput(execFileImpl, "netstat", ["-ano", "-p", "TCP"]);
  if (tasklist === undefined || netstat === undefined) {
    detectedDshPorts = [];
    return detectedDshPorts;
  }
  const pids = new Set();
  for (const line of tasklist.split(/\r?\n/)) {
    const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, "").trim());
    if (cells.length >= 2 && /^\d+$/.test(cells[1])) pids.add(cells[1]);
  }
  const ports = [];
  for (const line of netstat.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[3] !== "LISTENING") continue;
    if (!fields[1].startsWith("127.0.0.1:") && !fields[1].startsWith("0.0.0.0:")) continue;
    if (!pids.has(fields[4])) continue;
    const port = Number.parseInt(fields[1].split(":").pop() ?? "", 10);
    if (Number.isInteger(port) && port > 0 && !ports.includes(port)) ports.push(port);
  }
  detectedDshPorts = ports;
  return ports;
}

/**
 * Run one short-lived command and capture stdout.
 * @param execFileImpl - injectable execFile.
 * @param file - executable.
 * @param args - arguments.
 * @returns stdout, or `undefined` on any failure.
 */
async function captureProcessOutput(execFileImpl, file, args) {
  const run = execFileImpl ?? execFile;
  return new Promise((resolve) => {
    try {
      run(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, out) => {
        resolve(error === null || error === undefined ? out : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Promise-based delay.
 * @param ms - milliseconds.
 * @returns a promise resolving after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ──────────────────────── orchestration + 30s cache ─────────────────────── */

/**
 * Build the full directory: fetch all three sources in parallel, then run
 * the pure assembly. Any failing source degrades to its note.
 *
 * @param options - passed through to the fetchers; also
 *   `{currentSessionId?, maxEntries?, now?}` for the assembly step.
 * @returns the build result; never throws.
 */
export async function buildDirectory(options = {}) {
  const env = options.env ?? process.env;
  const currentSessionId = options.currentSessionId ?? env.DSH_SESSION_ID;
  const sourceOptions = { ...options, env };
  const [friends, shares, sessions] = await Promise.all([
    fetchFriends(sourceOptions).catch(() => ({ error: "unreachable" })),
    fetchShares(sourceOptions).catch(() => ({ error: "unreachable" })),
    fetchSessions(sourceOptions).catch(() => ({ error: "unreachable" })),
  ]);
  return buildDirectoryFromSources({
    friends: isErrorSource(friends) ? friends : friends.data,
    shares: isErrorSource(shares) ? shares : shares.data,
    sessions: isErrorSource(sessions) ? sessions : sessions.data,
    myDid: friends.meta?.myDid,
  }, { currentSessionId, maxEntries: options.maxEntries, now: options.now });
}

/** Module-level cache: `{at, result}` plus the in-flight refresh promise. */
let directoryCache = { at: 0, result: undefined };
let inflightRefresh;
let autofetchEnabled = defaultAutofetch(process.env);

/**
 * Auto background refresh defaults: off under vitest (hermetic existing
 * tests), on otherwise; `MYCO_DIRECTORY_AUTOFETCH=0|1` always wins.
 * @param env - environment to inspect.
 * @returns whether background refresh may start.
 */
function defaultAutofetch(env) {
  if (env.MYCO_DIRECTORY_AUTOFETCH === "0") return false;
  if (env.MYCO_DIRECTORY_AUTOFETCH === "1") return true;
  return env.VITEST === undefined;
}

/**
 * Rebuild the directory and refresh the module cache.
 * @param options - forwarded to {@link buildDirectory}.
 * @returns the fresh result; never throws.
 */
export async function refreshDirectory(options = {}) {
  const now = typeof options.now === "function" ? options.now() : Date.now();
  let result;
  try {
    result = await buildDirectory(options);
  } catch {
    result = {
      agents: [],
      summary: renderSummary([], { friend: true, share: true, session: true }),
      count: 0,
      notes: { friend: true, share: true, session: true },
      shown: 0,
      hidden: 0,
      builtAt: now,
    };
  }
  directoryCache = { at: now, result };
  return result;
}

/**
 * Synchronous cache read for the prompt-assembly path.
 *
 * Fresh cache → returned as is. Stale/missing cache → the previous result is
 * still returned (prompt keeps the last known directory) while a background
 * rebuild starts — unless disabled, e.g. under vitest. Never throws, never
 * awaits: `baseText()` stays synchronous.
 *
 * @param now - injectable clock (tests).
 * @returns the cached result, or `undefined` before the first build lands.
 */
export function getDirectorySnapshot(now = Date.now()) {
  if (directoryCache.result !== undefined && now - directoryCache.at <= DIRECTORY_TTL_MS) {
    return directoryCache.result;
  }
  startBackgroundRefresh();
  return directoryCache.result;
}

/**
 * Kick off one deduplicated background rebuild.
 */
function startBackgroundRefresh() {
  if (!autofetchEnabled || inflightRefresh !== undefined) return;
  inflightRefresh = refreshDirectory()
    .catch(() => undefined)
    .finally(() => {
      inflightRefresh = undefined;
    });
}

/**
 * The injected block text for the identity prompt, from the cache.
 * @param now - injectable clock (tests).
 * @returns the block, or `undefined` when nothing is cached/nothing to say.
 */
export function directoryBlockText(now = Date.now()) {
  return renderDirectoryBlock(getDirectorySnapshot(now));
}

/**
 * Introspect the cache (used by tests and diagnostics).
 * @param now - injectable clock.
 * @returns `{hasResult, ageMs?, count?}`.
 */
export function directoryCacheState(now = Date.now()) {
  const hasResult = directoryCache.result !== undefined;
  return {
    hasResult,
    ageMs: hasResult ? now - directoryCache.at : undefined,
    count: directoryCache.result?.count,
  };
}

// #ifdef TEST
// —— 以下导出只服务于 mock 测试/注入，生产路径不引用（task: buildDirectoryMock）——

/**
 * Pure-logic entry point for mock tests: build a directory from fake source
 * data without any I/O. Identical to {@link buildDirectoryFromSources}.
 *
 * @param sources - `{friends?, shares?, sessions?, myDid?}`; a source may be
 *   the raw record array or `{error: "..."}` to simulate an unreachable feed.
 * @param options - `{currentSessionId?, maxEntries?, now?}`.
 * @returns `{agents, summary, count, notes, shown, hidden, builtAt}`.
 */
export function buildDirectoryMock(sources, options = {}) {
  return buildDirectoryFromSources(sources, options);
}

/**
 * Force the autofetch switch (tests keep the module hermetic).
 * @param enabled - `true` to allow background refresh.
 */
export function setDirectoryAutofetch(enabled) {
  autofetchEnabled = enabled === true;
}

/**
 * Seed the module cache directly (tests of the identity injection seam).
 * @param result - a build result (or `undefined` to represent “not built”).
 * @param at - cache timestamp.
 */
export function setDirectoryCacheForTests(result, at = 0) {
  directoryCache = { at, result };
}
// #endif
