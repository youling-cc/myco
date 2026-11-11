/**
 * `@myco/dsh-plugin` — a DSH (DeepSeek Harness) Cordis plugin that
 * contributes one dynamic runtime context per request and one built-in `myco`
 * skill:
 *
 *     [myco:session-identity] 本会话自身身份（myco runtime context）
 *     - sessionId: session-...
 *     - title: ...                          (omitted when the session has no title yet)
 *     - youling账号: CJ26 <did:youling:...> (only while logged in)
 *     - myco设备: DESKTOP <did:myco:...>    (only while logged in)
 *
 * Two DSH rc.5 seams are used, exactly as the first-party
 * `@deepseek-ai/dsh-working-directory` plugin uses them:
 *
 * 1. `ctx.systemPrompt.context(...)` registers the slot (fixed `order: 130`,
 *    `required: true`, `interpolate: false`) and its base text.
 * 2. A prepended `system-prompt/assemble` listener starts the identity probe
 *    without awaiting it, awaits `next()` so the rest of the assembly is never
 *    blocked, then rewrites the slot's text with the DID lines.
 *
 * One rc.5 detail the first-party `dsh-working-directory` plugin does not have
 * to care about: `dsh-agent-loop` calls `systemPrompt.refreshContext(...)`
 * after the waterfall for every model step, and that refresh *re-resolves every
 * registered provider*, discarding waterfall mutations. A synchronous fact can
 * simply be recomputed there; an asynchronously probed DID cannot. The
 * waterfall therefore leaves its finished text in a per-session slot that the
 * provider re-emits on the refresh — still one probe per request, no
 * cross-request cache.
 *
 * @module @myco/dsh-plugin
 */

import { appendFile } from "node:fs/promises";

import {
  CONTEXT_NAME,
  DEFAULT_ORDER,
  DEFAULT_STATUS_ARGS,
  DEFAULT_TIMEOUT_MS,
  baseText,
  cleanLine,
  contextText,
  didLines,
  queryIdentity,
  readIdentity,
  readNames,
  resolveMycoExe,
} from "./identity.js";
import { mycoSkill } from "./skill.js";
import { startProxySuite } from "./web-listener.js";

/** Cordis plugin name. */
export const name = "myco";

/** Live web-listener handle (closed implicitly with the host process). */
let webListenerHandle;

/**
 * Hard dependencies only. `sessionTitle` / `sessionProjections` are read
 * optionally through `ctx.get(...)` so a profile without them still loads.
 */
export const inject = ["systemPrompt", "skills"];

/**
 * Read one latest-title snapshot from the optional title service, falling back
 * to the `title` projection. Both are untrusted: any throw is swallowed and
 * degrades to "no title line".
 *
 * @param ctx - plugin context.
 * @param session - agent session.
 * @returns the cleaned title, or `undefined`.
 */
export function readTitle(ctx, session) {
  try {
    const service = typeof ctx.get === "function" ? ctx.get("sessionTitle") : undefined;
    if (service !== undefined && service !== null && typeof service.get === "function") {
      const snapshot = service.get(session);
      const candidate = snapshot === null || snapshot === undefined
        ? undefined
        : typeof snapshot === "string" ? snapshot : snapshot.title;
      const title = cleanLine(candidate);
      if (title !== undefined) return title;
    }
  } catch {
    // A broken title service must only cost us the title line.
  }
  try {
    const projections = typeof ctx.get === "function" ? ctx.get("sessionProjections") : undefined;
    if (projections !== undefined && projections !== null && typeof projections.stateOf === "function") {
      const value = projections.stateOf(session, "title");
      if (typeof value === "string") return cleanLine(value);
    }
  } catch {
    // Same: never fail assembly over a projection read.
  }
  return undefined;
}

/**
 * Render the base block (session id + optional title) for one assembly context.
 * @param ctx - plugin context.
 * @param context - assembly context provided by DSH.
 * @returns the base text, or the empty string when there is no agent/session.
 */
export function baseContextText(ctx, context) {
  const session = context?.agent?.session;
  if (session === undefined || session === null) return "";
  const sessionId = cleanLine(session.id) ?? "(missing session id)";
  return baseText(sessionId, readTitle(ctx, session));
}

/** How long a waterfall-produced text stays authoritative for its session. */
export const STASH_TTL_MS = 10_000;

/**
 * Render the runtime-context text for one assembly.
 *
 * DSH rc.5 resolves every *registered* runtime context twice per model step:
 * once inside `assemble()`, and again inside `refreshContext()` after the
 * `system-prompt/assemble` waterfall has run. The second resolution calls this
 * provider again and would therefore throw away an async DID that only the
 * waterfall could know about. The waterfall leaves its finished text here,
 * keyed by the live Session object, so the refreshed resolution re-emits it
 * instead of the bare base block.
 *
 * This is not a query cache: the identity probe still runs once per request.
 * It only carries a rendering result across the two resolutions of the *same*
 * request, and it expires so a stale entry can never outlive one step.
 *
 * @param ctx - plugin context.
 * @param context - assembly context provided by DSH.
 * @param cache - per-plugin session map written by the waterfall.
 * @returns the text this context contributes.
 */
export function renderContextText(ctx, context, cache = new WeakMap()) {
  const session = context?.agent?.session;
  if (session === undefined || session === null) return "";
  const stashed = cache.get(session);
  if (stashed !== undefined && Date.now() - stashed.at <= STASH_TTL_MS) return stashed.text;
  return baseContextText(ctx, context);
}

/**
 * Normalize the plugin configuration.
 * @param config - raw loader config.
 * @returns validated settings with defaults applied.
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === "object" ? config : {};
  const order = Number.isFinite(raw.order) ? raw.order : DEFAULT_ORDER;
  const timeoutMs = Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULT_TIMEOUT_MS;
  const statusArgs = Array.isArray(raw.statusArgs) && raw.statusArgs.every((item) => typeof item === "string") && raw.statusArgs.length > 0
    ? raw.statusArgs
    : DEFAULT_STATUS_ARGS;
  const debugLog = typeof raw.debugLog === "string" && raw.debugLog.trim().length > 0 ? raw.debugLog.trim() : undefined;
  const listenerRaw = raw.webListener !== null && typeof raw.webListener === "object" ? raw.webListener : {};
  return {
    order,
    timeoutMs,
    statusArgs,
    debugLog,
    mycoExe: raw.mycoExe,
    webListener: {
      enabled: listenerRaw.enabled !== false,
      forceInTests: listenerRaw.forceInTests === true,
      basePort: Number.isInteger(listenerRaw.basePort) && listenerRaw.basePort > 0
        ? listenerRaw.basePort
        : undefined,
      stateFile: typeof listenerRaw.stateFile === "string" && listenerRaw.stateFile.trim().length > 0
        ? listenerRaw.stateFile.trim()
        : undefined,
      dshWebUrl: typeof listenerRaw.dshWebUrl === "string" && listenerRaw.dshWebUrl.trim().length > 0
        ? listenerRaw.dshWebUrl.trim()
        : undefined,
    },
  };
}

/**
 * Append one JSONL evidence line for the per-request timing log.
 * Fire-and-forget: a log write must never delay or fail a request.
 *
 * @param path - log file.
 * @param record - serializable record.
 */
function appendDebug(path, record) {
  void appendFile(path, `${JSON.stringify(record)}\n`, "utf8").catch(() => {});
}

/**
 * Cordis plugin entry.
 * @param ctx - plugin context.
 * @param config - optional loader configuration.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const located = resolveMycoExe({ configured: settings.mycoExe });
  /** Per-session waterfall text, consumed by the post-waterfall refresh. */
  const refreshed = new WeakMap();

  ctx.logger?.info?.(`myco: exe=${located.exe} source=${located.source} timeout=${settings.timeoutMs}ms`);

  // Credential-free local web listener (myco collaboration entry). Started
  // fire-and-forget: a listener failure must never cost the identity/skill
  // work this plugin exists for. Off under vitest (same default as the
  // directory autofetch) unless a test opts in explicitly.
  const listenerWanted = settings.webListener.enabled
    && (process.env.VITEST === undefined || settings.webListener.forceInTests === true);
  // 2026-11-10 诊断：apply 阶段无条件记一条（含全部判据），确认 "listener 完全
  // 无日志" 到底是 wanted=false、还是 debugLog 没配、还是 apply 没走到这里。
  {
    // 必须写成 JSON 行：debugLog 是 JSONL，纯文本行会让任何按行 JSON.parse
    // 的消费者（含测试）整文件解析失败（2026-11-11 真案）。
    const record = {
      ts: new Date().toISOString(),
      listener: "apply-reached",
      wanted: listenerWanted,
      enabled: settings.webListener.enabled,
      vitest: process.env.VITEST ?? null,
      debugLog: settings.debugLog ?? null,
      pid: process.pid,
    };
    if (typeof settings.debugLog === "string" && settings.debugLog.length > 0) {
      void appendFile(settings.debugLog, `${JSON.stringify(record)}\n`, "utf8").catch(() => {});
    }
    ctx.logger?.info?.(`myco: listener apply-reached wanted=${listenerWanted} enabled=${settings.webListener.enabled} pid=${process.pid}`);
  }
  if (listenerWanted) {
    // 可观测性（2026-11-09 真案：桌面壳 host 上 listener 静默不起，logger
    // 输出在 GUI 里看不到）：启动结果与失败原因同时落 debugLog，便于对照。
    const listenerNote = (level, message) => {
      const record = { ts: new Date().toISOString(), listener: level, message };
      if (typeof settings.debugLog === "string" && settings.debugLog.length > 0) {
        void appendFile(settings.debugLog, `${JSON.stringify(record)}\n`, "utf8").catch(() => {});
      }
    };
    listenerNote("info", `starting (basePort=${settings.webListener.basePort ?? "default"} state=${settings.webListener.stateFile ?? "default"})`);
    void startProxySuite({
      env: process.env,
      config: settings.webListener,
      log: (message) => {
        ctx.logger?.info?.(message);
        listenerNote("info", message);
      },
    }).then((handle) => {
      if (handle.started) {
        webListenerHandle = handle;
        const message = `myco: web-listener ready on http://127.0.0.1:${handle.owner.port}/ (control ${handle.controlPort})`;
        ctx.logger?.info?.(message);
        listenerNote("ready", message);
      } else {
        const message = `myco: web-listener not started (${handle.reason})`;
        ctx.logger?.warn?.(message);
        listenerNote("not-started", message);
      }
    }).catch((error) => {
      const message = `myco: web-listener start failed: ${String(error?.message ?? error)}`;
      ctx.logger?.warn?.(message);
      listenerNote("failed", `${message}\n${String(error?.stack ?? "")}`);
    });
  }

  // Built-in skill: makes the plugin self-contained and portable across hosts.
  ctx.skills.register(mycoSkill);

  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: settings.order,
    required: true,
    interpolate: false,
    text: (context) => renderContextText(ctx, context, refreshed),
  });

  ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
    if (context.agent === void 0) return next();
    const startedAt = Date.now();

    // Start the probe first, then let the rest of the assembly run: the model
    // request never waits on `myco cli status`.
    const pending = queryIdentity({
      exe: located.exe,
      statusArgs: settings.statusArgs,
      timeoutMs: settings.timeoutMs,
      signal: context.signal,
    });

    const assembly = await next();
    if (!Array.isArray(assembly?.contexts)) return assembly;

    const probe = await pending;
    const identity = readIdentity(probe.status);
    const names = identity === undefined ? Object.freeze({}) : await readNames(probe.status);
    const enrichedIdentity = identity === undefined
      ? undefined
      : Object.freeze({ ...identity, ...names });
    const session = context.agent.session;

    // Always rebuild the base block from the live session: `entry.text` can
    // already be last step's finished text (the refresh slot), so reusing it
    // would duplicate the DID lines and freeze the previous title.
    const base = baseContextText(ctx, context);
    const text = enrichedIdentity === undefined ? base : `${base}\n${didLines(enrichedIdentity)}`;

    const entry = assembly.contexts.find((candidate) => candidate.name === CONTEXT_NAME);
    if (entry === undefined) {
      assembly.contexts.unshift({ name: CONTEXT_NAME, text, interpolate: false });
    } else {
      entry.text = text;
      entry.interpolate = false;
    }

    // `refreshContext()` re-resolves this registered provider right before the
    // request is admitted; hand it the finished text for this same step.
    refreshed.set(session, { text, at: Date.now() });

    if (settings.debugLog !== undefined) {
      appendDebug(settings.debugLog, {
        ts: new Date().toISOString(),
        sessionId: cleanLine(session?.id) ?? null,
        title: cleanLine(readTitle(ctx, session)) ?? null,
        loggedIn: identity !== undefined,
        role: typeof probe.status?.role === "string" ? probe.status.role : null,
        probe: probe.reason,
        probeMs: probe.elapsedMs,
        totalMs: Date.now() - startedAt,
        bytes: Buffer.byteLength(text, "utf8"),
        didCount: (text.match(/did:/g) ?? []).length,
        exe: located.exe,
        source: located.source,
      });
    }

    return assembly;
  }, { prepend: true });
}

export { CONTEXT_NAME, contextText, mycoSkill };
