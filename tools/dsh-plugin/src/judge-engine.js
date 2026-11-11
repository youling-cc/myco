/**
 * Ported P/A judge engine — the semantic core dsh_share.rs locks with 210
 * tests (source anchors in docs/JUDGE-ENGINE-porting-notes.md).
 *
 * Status: pre-integration. The decision layer lands in the proxy once the
 * cross-run against the Rust side agrees on every vector; the wire shape of
 * the control-plane body follows the spec summary myco sends in the morning.
 *
 * Every rule below mirrors the Rust original 1:1 — including the two that
 * inverted my interim "allow-list" semantics:
 *   - method gate: CAPS_DENIED is a fallback, NOT a capability source;
 *     methods outside the list are ALLOWED (§3.12.4)
 *   - `session/prompt` sits in CAPS_DENIED and passes only through the
 *     explicit `session.input` declaration (A09 fix)
 *
 * @module @myco/dsh-plugin/judge-engine
 */

/* ───────────────────────────── constants ───────────────────────────────── */

/**
 * The capability-id catalogue (CAP_IDS_ALL, cross-run agreed 2026-11-09):
 * the four personal toggles + model.select + the five high-risk ids.
 * Entries whose id sits outside this catalogue are dropped from the
 * intersection — a made-up id does not survive (cross-run finding: it
 * silently vanished in the Rust side, and must vanish here too).
 */
export const CAP_IDS = Object.freeze([
  "session.read",
  "session.input",
  "agent.view",
  "scope.switch",
  "model.select",
  "settings.write",
  "terminal.exec",
  "files.read",
  "files.write",
]);

/** The four "personal toggle" ids model.select builds on (caps_for_grant, L13400). */
const FOUR_TOGGLE_IDS = Object.freeze(["session.read", "session.input", "agent.view", "scope.switch"]);

/** Collaborator default: read + input only (default_caps, L13255). */
export function defaultCaps() {
  return {
    o: [{ id: "session.read", label: "看会话内容", methods: ["session/page", "session/list"] }],
    a: [{ id: "session.input", label: "输入内容", methods: ["session/prompt"] }],
  };
}

/** Owner default: full wildcard (owner_caps, L13362). */
export function ownerCaps() {
  return {
    o: [{ id: "*", label: "全部", methods: ["*"] }],
    a: [{ id: "*", label: "全部", methods: ["*"] }],
  };
}

/** Default-deny fallback list (CAPS_DENIED, L14026-14113). NOT a capability source. */
export const CAPS_DENIED = Object.freeze([
  "session/create", "session/delete", "session/fork", "session/archive",
  "workspace/create", "workspace/delete", "workspace/switch", "workspace/pick", "workspace/select",
  "model/", "llm/", "credentials/", "settings/", "permissionPresets/",
  "terminal", "files/", "workspaceFiles/", "commands/", "job/",
  "workspace/unpinSession",
  "skills/list", "speech/transcribe", "speech/prepare", "speech/configure", "speech/cancelPreparation",
  "subagent/", "session/activate", "session/selectModel",
  "session/prompt", "session/steer",
]);

/** Read-exempt faces: only "describes its own shape" surfaces (L14127). */
const CAPS_READ_EXEMPT_FACES = Object.freeze(["commands", "llm", "settings", "permissionPresets"]);
const READ_WORDS = Object.freeze(["list", "describe", "catalog", "inventory", "summary"]);

/**
 * High-risk method families: each demands its specific capability **id** be
 * declared — a `*` or custom id carrying the method does NOT count
 * (HIGH_RISK_METHOD_RULES, L14165-14191; task-38 P1-2: shape heuristics
 * would let plain collaborators promote themselves).
 * Order-sensitive: concrete reads precede the generalized `files/` rules.
 */
export const HIGH_RISK_METHOD_RULES = Object.freeze([
  ["model/", "model.select"],
  ["session/selectModel", "model.select"],
  ["llm/", "model.select"],
  ["settings/", "settings.write"],
  ["permissionPresets/", "settings.write"],
  ["credentials/", "settings.write"],
  ["terminal", "terminal.exec"],
  ["commands/", "terminal.exec"],
  ["job/", "terminal.exec"],
  ["files/read", "files.read"],
  ["files/list", "files.read"],
  ["files/stat", "files.read"],
  ["files/search", "files.read"],
  ["files/write", "files.write"],
  ["files/delete", "files.write"],
  ["files/rename", "files.write"],
  ["files/move", "files.write"],
  ["files/copy", "files.write"],
  ["files/", "files.write"],
  ["workspaceFiles/list", "files.read"],
  ["workspaceFiles/read", "files.read"],
  ["workspaceFiles/stat", "files.read"],
  ["workspaceFiles/", "files.write"],
]);

/** The concrete family name a denied high-risk method reports (L14221 chain). */
const HIGH_RISK_REPORT_RULES = Object.freeze([
  "terminal", "files/", "workspaceFiles/", "settings/", "model/", "llm/", "credentials/", "commands/",
]);

/* ─────────────────────────── caps normalization ─────────────────────────── */

/**
 * Normalize externally supplied caps (normalize_caps, L13268): missing o/a
 * keys fall back to the v1 default; **explicit empty arrays mean "that
 * direction fully off" and are respected**; other keys pass through.
 * @param caps - raw caps value.
 * @returns normalized caps object.
 */
export function normalizeCaps(caps) {
  if (caps === null || typeof caps !== "object" || Array.isArray(caps)) return defaultCaps();
  const d = defaultCaps();
  const out = { ...caps };
  for (const dir of ["o", "a"]) {
    if (!Array.isArray(out[dir])) out[dir] = d[dir];
  }
  return out;
}

/* ───────────────────── effective caps (L13400/L13451) ───────────────────── */

/**
 * Per-grant narrowing (caps_for_grant, L13400).
 *
 * - Fixed ids follow the grant's boolean flags; a missing flag inherits the
 *   task declaration.
 * - Dynamic (non-fixed) ids pass through untouched.
 * - model.select: explicit flag wins; all four toggles on ("全权") implies it.
 *
 * @param shareCaps - task-level caps (raw).
 * @param flags - per-person boolean overrides.
 * @returns the effective caps.
 */
export function capsForGrant(shareCaps, flags) {
  const base = normalizeCaps(shareCaps);
  const flagOf = (id) => {
    const value = flags?.[id];
    return typeof value === "boolean" ? value : true; // missing = inherit
  };
  const out = {};
  for (const dir of ["o", "a"]) {
    out[dir] = base[dir].filter((item) => {
      const id = typeof item?.id === "string" ? item.id : "";
      if (!CAP_IDS.includes(id)) return false; // outside catalogue: dropped
      return flagOf(id);
    });
  }
  const allFour = FOUR_TOGGLE_IDS.every((id) => flags?.[id] === false ? false : flags?.[id] === true);
  const modelOn = typeof flags?.["model.select"] === "boolean" ? flags["model.select"] : allFour;
  if (modelOn) {
    const has = out.a.some((item) => item?.id === "model.select");
    if (!has) {
      out.a.push({ id: "model.select", label: "切换模型", methods: ["session/selectModel", "model/"] });
    }
  }
  return out;
}

/**
 * Effective caps chain (effective_caps, L13451).
 * @param taskCaps - task-level caps (raw).
 * @param grant - `{owner?: boolean, caps?: object}` or `undefined`.
 * @returns the caps governing this viewer.
 */
export function effectiveCaps(taskCaps, grant) {
  if (grant !== undefined && grant.owner === true) return ownerCaps();
  if (grant !== undefined && grant.caps !== null && typeof grant.caps === "object") {
    return capsForGrant(taskCaps, grant.caps);
  }
  return normalizeCaps(taskCaps);
}

/* ─────────────────────── method gate (L13986-14200) ─────────────────────── */

/** One declared method entry matches? (hit closure inside caps_declares) */
function declaredMatches(rule, name) {
  if (rule.length === 0) return false;
  if (rule === "*") return true;
  const prefix = rule.endsWith("/*") ? rule.slice(0, -2) : rule.endsWith("/") ? rule.slice(0, -1) : null;
  if (prefix !== null) {
    return prefix.length > 0 && (name === prefix || name.startsWith(`${prefix}/`));
  }
  return name === rule || name.startsWith(`${rule}/`);
}

/**
 * Does the caps set explicitly declare this RPC method? (caps_declares, L13986)
 * @param caps - normalized caps.
 * @param name - RPC method (`session/list`).
 */
export function capsDeclares(caps, name) {
  if (typeof name !== "string" || name.length === 0) return false;
  for (const dir of ["o", "a"]) {
    const arr = caps?.[dir];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      const methods = item?.methods;
      if (!Array.isArray(methods)) continue;
      for (const raw of methods) {
        if (typeof raw === "string" && declaredMatches(raw, name)) return true;
      }
    }
  }
  return false;
}

/** CAPS_DENIED entry hit? (caps_denied_hit, L14115) */
export function capsDeniedHit(rule, name) {
  if (rule.endsWith("/")) {
    const prefix = rule.slice(0, -1);
    return name === prefix || name.startsWith(`${prefix}/`);
  }
  return name === rule || name.startsWith(`${rule}/`);
}

/** Pure-read on an exempt face? (rpc_read_exempt, L14138) */
export function rpcReadExempt(name) {
  const face = name.split("/")[0];
  if (!CAPS_READ_EXEMPT_FACES.includes(face)) return false;
  const tail = name.split("/").pop() ?? "";
  return READ_WORDS.some((word) => tail.includes(word))
    || ["get", "page", "history", "read"].includes(tail);
}

/**
 * Does the caps set declare a capability **id** (not methods)?
 * (caps_id_declared, L13316 — used by the high-risk layer.)
 * @param caps - normalized caps.
 * @param id - capability id (`model.select`).
 */
export function capsIdDeclared(caps, id) {
  for (const dir of ["o", "a"]) {
    const arr = caps?.[dir];
    if (!Array.isArray(arr)) continue;
    if (arr.some((item) => item?.id === id)) return true;
  }
  return false;
}

/** The capability id a high-risk method family demands, if any (L14194). */
export function highRiskCapFor(name) {
  for (const [rule, cap] of HIGH_RISK_METHOD_RULES) {
    if (capsDeniedHit(rule, name)) return cap;
  }
  return undefined;
}

/**
 * Full method verdict (caps_violation_as chain, L14201 comment + L14211):
 *   ⓪ admin → allowed; ① non-RPC → allowed; ② exempt read → allowed;
 *   ③ high-risk family: its capability id must be declared (`*`/custom ids
 *      do not count) → else denied; ④ declared (methods match) → allowed;
 *   ⑤ CAPS_DENIED → denied; else allowed (§3.12.4).
 * @param effective - effective caps for this viewer.
 * @param name - RPC method, or `undefined` for non-RPC paths.
 * @param admin - explicit owner/admin bypass (never inferred from shape).
 * @returns `{allowed: true} | {allowed: false, rule}` — rule is the hit entry.
 */
export function judgeMethod(effective, name, admin = false) {
  if (admin) return { allowed: true };
  if (typeof name !== "string" || name.length === 0) return { allowed: true };
  if (rpcReadExempt(name)) return { allowed: true };
  const highRiskCap = highRiskCapFor(name);
  if (highRiskCap !== undefined) {
    if (!capsIdDeclared(effective, highRiskCap)) {
      const report = HIGH_RISK_REPORT_RULES.find((rule) => capsDeniedHit(rule, name)) ?? "high-risk";
      return { allowed: false, rule: report };
    }
    return { allowed: true };
  }
  if (capsDeclares(effective, name)) return { allowed: true };
  for (const rule of CAPS_DENIED) {
    if (capsDeniedHit(rule, name)) return { allowed: false, rule };
  }
  return { allowed: true };
}

/* ───────────────────── visibility P-plane (L1094-1135, L2260) ─────────── */

/** Narrower space wins; smaller rank = narrower (space_narrower, L1125). */
const SPACE_RANK = Object.freeze({ session: 0, project: 1, machine: 2 });
export function spaceNarrower(a, b) {
  const ra = SPACE_RANK[a] ?? SPACE_RANK.machine;
  const rb = SPACE_RANK[b] ?? SPACE_RANK.machine;
  return ra <= rb ? a : b;
}

/** Stricter window wins; null = unbounded (window_stricter, L1135). */
export function windowStricter(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/** Coerce one raw visibility object into Vis shape (vis_of, L973 — tolerant). */
export function visOf(raw) {
  const v = raw !== null && typeof raw === "object" ? raw : {};
  return {
    space: typeof v.space === "string" ? v.space : "machine",
    sessions: Array.isArray(v.sessions) ? v.sessions.filter((s) => typeof s === "string") : [],
    windowMs: Number.isFinite(v.windowMs) ? v.windowMs : Number.isFinite(v.window_ms) ? v.window_ms : null,
    projectCwd: typeof v.projectCwd === "string" ? v.projectCwd : typeof v.project_cwd === "string" ? v.project_cwd : null,
    projects: Array.isArray(v.projects) ? v.projects.filter((p) => typeof p === "string") : [],
  };
}

/**
 * Two-layer visibility intersection — only tightens (merge_vis, L2277).
 * @param taskRaw - task-level visibility.
 * @param perRaw - grant-level visibility.
 * @returns the merged Vis.
 */
export function mergeVis(taskRaw, perRaw) {
  const task = visOf(taskRaw);
  const per = visOf(perRaw);
  const tNarrow = task.space === "session" && task.sessions.length > 0;
  const pNarrow = per.space === "session" && per.sessions.length > 0;
  let sessions;
  if (tNarrow && pNarrow) {
    sessions = task.sessions.filter((s) => per.sessions.includes(s));
  } else if (tNarrow) {
    sessions = [...task.sessions];
  } else if (pNarrow) {
    sessions = [...per.sessions];
  } else {
    sessions = [];
  }
  const projectCwd = per.projectCwd ?? task.projectCwd;
  let projects;
  if (task.projects.length > 0) {
    if (per.projects.length === 0) {
      projects = [...task.projects];
    } else {
      const hit = task.projects.filter((p) => per.projects.includes(p));
      projects = hit.length === 0 ? [...task.projects] : hit; // empty cross → keep task
    }
  } else {
    projects = [...per.projects];
  }
  const space = spaceNarrower(task.space, per.space);
  const projectBound = task.space === "project" || per.space === "project"
    || (projects.length > 0 && space !== "machine");
  return { space, sessions, windowMs: windowStricter(task.windowMs, per.windowMs), projectCwd, projects, projectBound };
}

/**
 * Effective visibility (effective_visibility, L2260): owner sees all;
 * otherwise task ∩ grant.
 * @param taskRaw - task-level visibility.
 * @param grant - `{owner?, visibility?}` or `undefined`.
 */
export function effectiveVisibility(taskRaw, grant) {
  if (grant !== undefined && grant.owner === true) return visOf({ space: "machine" });
  const task = visOf(taskRaw);
  if (grant === undefined || grant.visibility === null || typeof grant.visibility !== "object") {
    return task;
  }
  return mergeVis(task, grant.visibility);
}

/** Is one session id visible under a Vis? (session scope = allowlist) */
export function sessionVisible(vis, sessionId) {
  if (typeof sessionId !== "string") return false;
  if (vis.space !== "session" || vis.sessions.length === 0) return true;
  return vis.sessions.some((s) => s === sessionId || s === `session-${sessionId}` || sessionId === `session-${s}`);
}

/* ─────────────────────────── denial envelopes ──────────────────────────── */

/**
 * A-plane denial (caps_denied_response, L14267): Chinese short code — the
 * harness prints it into the UI verbatim.
 * @param rpcId - echoed rpc id.
 * @param rule - the hit CAPS_DENIED entry.
 * @returns serialized envelope.
 */
export function capsDeniedEnvelope(rpcId, rule, what = "这个操作") {
  return JSON.stringify({
    type: "server-response",
    rpcId: rpcId ?? null,
    result: {
      ok: false,
      error: {
        code: "受保护",
        message: `${what}由分享者控制；需要就在 myco 任务群里告诉 TA。`,
        details: { rule, action: what },
      },
    },
  });
}

/**
 * P-plane denial (visibility_denied_json, L10927).
 * @param rpcId - echoed rpc id.
 * @param sessionId - the session asked for.
 * @returns serialized envelope.
 */
export function visibilityDeniedEnvelope(rpcId, sessionId) {
  return JSON.stringify({
    type: "server-response",
    rpcId: rpcId ?? null,
    result: {
      ok: false,
      error: {
        code: "不在可见范围",
        message: "这个会话不在分享者开放给你的范围里；需要就在 myco 任务群里告诉 TA。",
        details: { sessionId, scope: "session" },
      },
    },
  });
}
