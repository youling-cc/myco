/**
 * Credential-free local web listener — the plugin's stable DSH web entry.
 *
 * Contract (agreed with the myco session, 2026-11-08):
 *   - `http://127.0.0.1:<port>/` opens the full DSH web app with **no**
 *     credentials in the browser: every proxied request carries a freshly
 *     minted browser-session cookie (secret from `~/.dsh/.credentials.yaml`).
 *   - The listener lives exactly as long as the DSH host process; no idle
 *     recycling. State file `~/.dsh/web-listener.json` is written by the
 *     plugin (sole writer) and read by myco (sole reader):
 *       {"port":N,"pid":<host pid>,"since":<ts>,"basePath":"/",
 *        "upstream":"http://127.0.0.1:<dsh web port>"}
 *   - Port acquisition: try the file's port → on EADDRINUSE walk upward from
 *     `basePort` → write the winning port back.
 *   - WebSocket `/api/remote.mux` is bridged at the TCP level: the browser's
 *     `Sec-WebSocket-Key` passes through, so no frame parsing at all.
 *
 * Multi-host note: this profile can load in two host processes at once
 * (desktop shell + nohup). Each instance binds its own listener; a 30s
 * heartbeat re-points the state file at a live listener whenever the port
 * it names dies, so "valid while DSH lives" holds with a ≤30s heal window.
 *
 * @module @myco/dsh-plugin/web-listener
 */

import http from "node:http";
import net from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { detectDshPorts, mintDshCookie, readDshSecret } from "./directory.js";
import { isPromptWrite, signPromptBody } from "./signature.js";
import {
  PolicyStore,
  decideHttp,
  decideSession,
  decideStream,
  denialEnvelope,
  denialStreamFrame,
  ensureControlKey,
  methodFromUrl,
  normalizeSessionId,
} from "./policy-proxy.js";
import { capsDeniedEnvelope, judgeMethod, sessionVisible, visibilityDeniedEnvelope } from "./judge-engine.js";

/** Default state file (absolute). */
export const DEFAULT_STATE_FILE = () => {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return `${home}/.dsh/web-listener.json`;
};

/** First port to try when the state file has no live candidate. */
export const DEFAULT_BASE_PORT = 17878;

/**
 * Default persistent policy table (`~/.dsh/web-proxy-policy.json`).
 *
 * 2026-11-11 用户裁决：**授权表绝不能因插件/宿主重启而丢失**，且"表为空"必须
 * fail-closed（503），不能回退放行。写穿落盘（原子 tmp+rename）+ 启动加载，
 * 让"重启后仍按原授权执行"成为默认行为。
 *
 * @returns absolute path.
 */
export function DEFAULT_POLICY_STATE_FILE() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return `${home}\\.dsh\\web-proxy-policy.json`;
}

/** How far past `basePort` the acquisition walk may go. */
export const MAX_PORT_ATTEMPTS = 200;

/** Heartbeat interval for state-file healing (ms). */
export const HEARTBEAT_MS = 30_000;

/** Probe timeout when checking whether a port is still alive (ms). */
export const PORT_PROBE_MS = 400;

/* ────────────────────────── state file (pure-ish) ───────────────────────── */

/**
 * Parse one state-file payload.
 * @param text - raw file contents.
 * @returns `{port, pid, since?, basePath?}` or `undefined` when unusable.
 */
export function parseState(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.port !== "number") return undefined;
  const port = value.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  return {
    port,
    pid: Number.isInteger(value.pid) ? value.pid : undefined,
    since: Number.isFinite(value.since) ? value.since : undefined,
    basePath: typeof value.basePath === "string" ? value.basePath : "/",
  };
}

/**
 * Render one state-file payload (sole-writer format). Known fields keep
 * their order; extra fields (e.g. `controlPort`) pass through.
 * @param record - the record to persist.
 * @returns the JSON text.
 */
export function renderState(record) {
  return `${JSON.stringify({
    port: record.port,
    pid: record.pid,
    since: record.since,
    basePath: record.basePath,
    upstream: record.upstream,
    ...(record.controlPort === undefined ? {} : { controlPort: record.controlPort }),
  }, null, 2)}\n`;
}

/**
 * Atomic state write: temp file in the same directory, then rename.
 * @param path - state file path.
 * @param record - the record to persist.
 */
export async function writeStateFile(path, record) {
  const tmp = `${path}.tmp-${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, renderState(record), "utf8");
  await rename(tmp, path);
}

/**
 * Read the state file, tolerating absence and corruption.
 * @param path - state file path.
 * @returns the parsed state, or `undefined`.
 */
export async function readStateFile(path) {
  try {
    return parseState(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/* ───────────────────────────── helper probes ────────────────────────────── */

/**
 * Whether a local TCP port currently accepts connections.
 * @param port - port to probe.
 * @param timeoutMs - probe timeout.
 * @returns `true` when something is listening.
 */
export function probePortLive(port, timeoutMs = PORT_PROBE_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Whether a pid is alive (`process.kill(pid, 0)` semantics).
 * @param pid - process id.
 * @returns `true` when the process exists.
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // exists but owned by someone else
  }
}

/**
 * Extract the `host:port` authority of an upstream URL.
 * @param upstream - e.g. `http://127.0.0.1:60266`.
 * @returns the authority, or `undefined` for an unparseable URL.
 */
export function upstreamAuthority(upstream) {
  try {
    const url = new URL(upstream);
    return url.host.includes(":") ? url.host : `${url.host}:${url.port || "80"}`;
  } catch {
    return undefined;
  }
}

/* ──────────────────────────── HTTP request proxy ────────────────────────── */

/** Request headers we replace rather than forward (authority-bound). */
const REWRITTEN_REQUEST_HEADERS = new Set(["host", "origin", "cookie"]);

/**
 * Response headers never relayed to the browser. Everything else — including
 * `content-encoding` and `content-length` — passes through untouched, because
 * the proxy relays raw bytes: the browser offered the encodings itself, so it
 * decodes them exactly as it would against the upstream directly.
 */
const DROPPED_RESPONSE_HEADERS = new Set(["set-cookie", "connection", "keep-alive", "transfer-encoding"]);

/**
 * Build the upstream request headers for one proxied request.
 *
 * `host`/`origin`/`cookie` are rewritten to the upstream authority (the minted
 * browser-session cookie is authority-bound, and DSH validates the Host
 * header against the cookie's authority); `accept-encoding` passes through —
 * the proxy relays raw bytes, so the browser decodes exactly what it asked
 * for, as if it talked to the upstream directly.
 *
 * @param incoming - listener-side request headers.
 * @param authority - upstream `host:port`.
 * @param cookie - minted DSH browser-session cookie header value.
 * @returns forwarded header pairs.
 */
export function proxyRequestHeaders(incoming, authority, cookie, { includeWebSocketHeaders = false } = {}) {
  const headers = [];
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (REWRITTEN_REQUEST_HEADERS.has(key)) continue;
    if (key === "connection" || key === "keep-alive" || key === "upgrade") continue;
    if (!includeWebSocketHeaders && key.startsWith("sec-websocket-")) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.push([name, item]);
  }
  headers.push(["host", authority]);
  headers.push(["origin", `http://${authority}`]);
  headers.push(["cookie", cookie]);
  return headers;
}

/* ────────────────────────────── the listener ────────────────────────────── */

/**
 * Resolve the upstream DSH web base URL.
 *
 * Priority: `$DSH_WEB_URL` (nohup/`dsh web` hosts carry it) →
 * `config.dshWebUrl` (explicit profile override) → tasklist+netstat
 * detection with a live probe (the desktop-shell host process carries no
 * `DSH_WEB_URL`, but its listeners are owned by `DeepSeek Harness.exe`).
 *
 * @param env - environment to read `DSH_WEB_URL` from.
 * @param config - `{dshWebUrl?}` plus `execFileImpl`/`fetchImpl` seams.
 * @param secret - browser-session secret for the probe.
 * @param log - logger.
 * @returns `http://127.0.0.1:<port>` or `undefined`.
 */
export async function resolveUpstream(env, config, secret, log) {
  const fromEnv = cleanAuthorityUrl(env?.DSH_WEB_URL);
  if (fromEnv !== undefined) return fromEnv;
  const fromConfig = cleanAuthorityUrl(config?.dshWebUrl);
  if (fromConfig !== undefined) return fromConfig;
  // 兜底①：myco watchdog 维护的端口文件（每 2 分钟刷新，宿主换代即跟随）。
  const fromFile = await readDshPortFile(config?.dshPortFile);
  if (fromFile !== undefined) {
    const base = `http://127.0.0.1:${fromFile}`;
    if (await probeDshWeb(base, secret, config)) {
      log(`web-listener: upstream detected via dsh-port.txt -> ${base}`);
      return base;
    }
  }
  const ports = await detectDshPorts(config?.execFileImpl);
  // 2026-11-09 真案：探测把**另一个 web-listener 的口**当成了 DSH web 口
  //（同是 DeepSeek Harness.exe 名下的监听、session/list probe 也 200）→
  // 两个 listener 串联（浏览器→listener→listener→上游）。listener 段
  //（basePort..+220 与状态文件记录口）一律不作上游候选。
  const state = await readStateFile(DEFAULT_STATE_FILE());
  const listenerRange = (port) => {
    const base = Number.isInteger(config?.basePort) ? config.basePort : DEFAULT_BASE_PORT;
    return port >= base && port < base + 220;
  };
  for (const port of ports) {
    if (listenerRange(port)) continue;
    if (state?.port === port) continue;
    const base = `http://127.0.0.1:${port}`;
    if (await probeDshWeb(base, secret, config)) {
      log(`web-listener: upstream detected via netstat probe -> ${base}`);
      return base;
    }
  }
  return undefined;
}

/**
 * Probe one candidate base URL with the session/list RPC (200 = real DSH web).
 *
 * @param base - `http://127.0.0.1:<port>`.
 * @param secret - browser-session secret.
 * @param config - seams.
 * @returns whether the candidate answers as a DSH web host.
 */
async function probeDshWeb(base, secret, config) {
  const authority = base.replace(/^http:\/\//, "");
  try {
    const response = await (config?.fetchImpl ?? fetch)(`${base}/api/session/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: mintDshCookie(authority, secret),
        origin: `http://${authority}`,
      },
      // Lightweight shape: args {} answers with a ~250 B envelope, so the
      // probe never pays the 1.5 MB full-list price.
      body: JSON.stringify({ type: "client-request", rpcId: "probe", method: "session/list", payload: { args: {} } }),
      signal: AbortSignal.timeout(1500),
    });
    const ok = response.status === 200;
    await response.body?.cancel?.();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Read the myco watchdog port file (`%LOCALAPPDATA%\Youling\dsh-port.txt`).
 *
 * 2026-11-10 真案：宿主重启窗口内 netstat 探测可能一次都探不到（secret 写入
 * 或监听就绪时序），插件于是 `no-upstream` 永久失败。watchdog 每 2 分钟刷
 * 这个文件，是独立于探测时序的兜底来源。
 *
 * @param override - explicit path (tests).
 * @returns the port number or `undefined`.
 */
async function readDshPortFile(override) {
  const path = typeof override === "string" && override.length > 0
    ? override
    : (process.env.LOCALAPPDATA === undefined
      ? undefined
      : `${process.env.LOCALAPPDATA}\\Youling\\dsh-port.txt`);
  if (path === undefined) return undefined;
  try {
    const text = await readFile(path, "utf8");
    const port = Number(String(text).trim().split(/\s+/)[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the upstream with a bounded retry (host restart window).
 *
 * 2026-11-10: 宿主重启后 listener 必须自愈——探测失败不再一次性放弃，
 * 而是在启动窗口内按 2s 间隔重试（默认 15 次 ≈ 30s）。
 *
 * @param env - environment.
 * @param config - seams.
 * @param secret - browser-session secret.
 * @param log - logger.
 * @returns upstream base URL or `undefined`.
 */
export async function resolveUpstreamWithRetry(env, config, secret, log) {
  const attempts = Number.isInteger(config?.upstreamAttempts) && config.upstreamAttempts > 0
    ? config.upstreamAttempts
    : 15;
  const delayMs = Number.isInteger(config?.upstreamRetryMs) && config.upstreamRetryMs >= 0
    ? config.upstreamRetryMs
    : 2000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const upstream = await resolveUpstream(env, config, secret, log);
    if (upstream !== undefined) {
      if (attempt > 1) log(`web-listener: upstream resolved on attempt ${attempt}/${attempts}`);
      return upstream;
    }
    if (attempt < attempts) {
      log(`web-listener: upstream not ready (attempt ${attempt}/${attempts}) — retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return undefined;
}

/**
 * Normalize one candidate URL to `http://<host>:<port>`, or `undefined`.
 * @param value - raw candidate.
 * @returns the cleaned base URL.
 */
function cleanAuthorityUrl(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Start the credential-free listener.
 *
 * Never throws: any precondition failure (no `$DSH_WEB_URL`, no secret,
 * every candidate port busy) resolves to `{started:false, reason}` so the
 * plugin's identity/skill work is never impacted.
 *
 * @param options - `{env?, config?{basePort?, stateFile?, dshWebUrl?}, secret?, log?, now?}`;
 *   `secret` (browser-session bytes) is a test seam — production reads it
 *   from `~/.dsh/.credentials.yaml`. Upstream resolution:
 *   `$DSH_WEB_URL` → `config.dshWebUrl` → netstat probe (desktop hosts).
 * @returns `{started:true, port, upstream, close()} | {started:false, reason}`.
 */
export async function startWebListener(options = {}) {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const log = typeof options.log === "function" ? options.log : () => {};
  const stateFile = config.stateFile ?? DEFAULT_STATE_FILE();
  const basePort = Number.isInteger(config.basePort) && config.basePort > 0
    ? config.basePort
    : DEFAULT_BASE_PORT;

  const secret = options.secret ?? await readDshSecret({ env, dshHome: options.dshHome });
  if (secret === undefined) return { started: false, reason: "no-credentials" };

  const upstream = await resolveUpstreamWithRetry(env, config, secret, log);
  if (upstream === undefined) return { started: false, reason: "no-upstream" };
  const authority = upstreamAuthority(upstream);

  const mint = () => mintDshCookie(authority, secret, options.now ?? Date.now);

  const server = createProxyServer(upstream, authority, mint, options.resolvePolicy ?? (() => undefined), log, options.connection);
  const bridges = server.$bridges;

  const port = await listenOnAcquiredPort(server, stateFile, basePort);
  if (port === undefined) {
    closeServer(server, bridges);
    return { started: false, reason: "no-free-port" };
  }

  const record = {
    port,
    pid: process.pid,
    since: Math.floor(Date.now() / 1000),
    basePath: "/",
    upstream,
  };
  try {
    await writeStateFile(stateFile, record);
  } catch (error) {
    log(`web-listener: state write failed (${String(error?.message ?? error)})`);
  }
  log(`web-listener: listening on 127.0.0.1:${port} -> ${upstream} (state: ${stateFile})`);

  // Multi-host healing: when the state file names a dead port/pid, take over.
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const state = await readStateFile(stateFile);
        if (state === undefined || state.port === port) return;
        if (await probePortLive(state.port)) return; // another live listener owns it
        await writeStateFile(stateFile, record);
        log(`web-listener: took over state file from dead port ${state.port}`);
      } catch {
        // healing is best-effort
      }
    })();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    started: true,
    port,
    upstream,
    mint,
    stateFile,
    stateRecord: record,
    close: () => {
      clearInterval(heartbeat);
      closeServer(server, bridges);
    },
  };
}

/* ──────────────────── control plane (no per-viewer ports) ──────────────── */

/**
 * Start the whole proxy suite: **one** owner port + control plane.
 *
 * 2026-11-10 用户决定：**删除 per-viewer 分口**（viewerPort / 179xx）。
 * 理由：分口带来端口漂移、抢口与脏状态，debug 成本高于收益；而 owner 口
 * 已认连接身份（x-myco-viewer / x-myco-viewer-did），网关统一转发到
 * 状态文件的 port 即可正确归属。`openPort` 字段保留兼容但**被忽略**，
 * 响应不再返回 port；`closePort` 退化为「撤销该 viewer 的策略 + 断开
 * 其连接」（连接级撤销语义仍成立）。
 *
 * @param options - as {@link startWebListener}, plus
 *   `{controlPort?, keyPath?, controlKey?, requireViewerHeader?}`.
 * @returns `{started, owner, control, store, close}` or `{started:false, reason}`.
 */
export async function startProxySuite(options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const key = options.controlKey ?? await ensureControlKey(options.keyPath);
  // 持久化路径**只由插件入口显式传入**（index.js → DEFAULT_POLICY_STATE_FILE()）。
  // 默认 undefined = 不落盘：测试/临时 suite 永远不会碰到生产的
  // ~/.dsh/web-proxy-policy.json（2026-11-11 真案：测试把 AAAA/BBBB 写进了生产文件）。
  const store = options.store ?? new PolicyStore({
    statePath: options.policyStatePath,
    log,
  });
  if (typeof store.load === "function" && store.loaded !== true) {
    await store.load();
  }
  // 连接级身份（2026-11-10）：网关把 x-myco-viewer 头带进来时，按连接查策略——
  // **owner 口同样生效**（owner 口没有口级策略，但带头时按该 viewer 执行 P/A+署名）。
  // 这让「网关统一转发到状态文件的 port（17879）」也能正确归属，无需先改分口路由。
  const connection = {
    verify: (request) => {
      // ① 签名头（高信任）：x-myco-viewer: did.ts.hmac
      const signed = verifyViewerHeader(request.headers["x-myco-viewer"], key);
      if (signed !== undefined) return signed;
      // ② 纯 DID 头（低信任，本机回环域内等价可信）：x-myco-viewer-did: did:myco:...
      //    2026-11-10 兼容 myco 现网已有的头形态，避免为签名格式再等一轮部署。
      const raw = request.headers["x-myco-viewer-did"];
      if (typeof raw === "string") {
        const did = raw.trim();
        if (/^did:[a-z0-9]+:[A-Za-z0-9]+$/i.test(did)) {
          log(`web-listener: unsigned viewer header accepted (${did})`);
          return did;
        }
      }
      return undefined;
    },
    lookup: (did) => store.viewers.get(did),
    hasAnyPolicy: () => store.viewers.size > 0,
    keys: () => [...store.viewers.keys()],
    require: options.requireViewerHeader === true,
  };
  const owner = await startWebListener({ ...options, connection: { ...connection, require: false } });
  if (!owner.started) return owner;

  const control = http.createServer(async (request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(payload));
    };
    if (request.method === "GET" && (request.url ?? "").startsWith("/policy")) {
      send(200, { ok: true, viewers: store.describe() });
      return;
    }
    if (request.method === "POST" && (request.url ?? "").startsWith("/policy")) {
      const body = await bufferJsonBody(request, 256_000);
      if (body === undefined) { send(400, { ok: false, error: "bad-json" }); return; }
      const verdict = store.apply(body, key);
      if (verdict.ok !== true) { send(401, { ok: false, error: verdict.error }); return; }
      const viewerDid = String(body.viewerDid);
      // openPort: 分口已删除（2026-11-10）——字段接受但忽略，不返回 port。
      if (body.closePort === true) {
        // 撤销：删策略条目即生效（连接级身份查不到 entry → 拒绝）。
        // 必须写穿落盘，否则重启后撤销失效（2026-11-11 持久化测试抓到）。
        store.viewers.delete(viewerDid);
        if (typeof store.persist === "function") await store.persist();
        log(`web-listener: policy revoked for ${viewerDid} (closePort)`);
        send(200, { ok: true, viewerDid, closedPort: null });
        return;
      }
      send(200, { ok: true, viewerDid });
      return;
    }
    send(404, { ok: false, error: "not-found" });
  });
  const controlPort = await new Promise((resolve) => {
    // Walk up a few ports when busy: two hosts (shell + nohup) both run the
    // suite, and the second must not lose its whole listener over one port.
    const candidates = [options.controlPort ?? 17877];
    if (options.controlPort === undefined) {
      for (let offset = 1; offset <= 5; offset += 1) candidates.push(17877 + offset);
    }
    let index = 0;
    const tryListen = () => {
      if (index >= candidates.length) { resolve(undefined); return; }
      const port = candidates[index];
      index += 1;
      const onError = () => { control.removeListener("listening", onListening); tryListen(); };
      const onListening = () => { control.removeListener("error", onError); resolve(control.address().port); };
      control.once("error", onError);
      control.once("listening", onListening);
      control.listen(port, "127.0.0.1");
    };
    tryListen();
  });
  if (controlPort === undefined) {
    owner.close();
    return { started: false, reason: "control-port-busy" };
  }
  log(`web-listener: control plane on 127.0.0.1:${controlPort} (POST/GET /policy)`);
  // Republish the state file with the control port for myco's benefit.
  // The mutation also reaches the owner's heartbeat rewrites (same record
  // object): without it, a heartbeat takeover would drop `controlPort`.
  try {
    owner.stateRecord.controlPort = controlPort;
    await writeStateFile(owner.stateFile, owner.stateRecord);
  } catch (error) {
    log(`web-listener: state rewrite with controlPort failed (${String(error?.message ?? error)})`);
  }

  // 内存/连接诊断（2026-11-11 host 4GB OOM 事故）：每 60s 记一行，崩前有据可查。
  // 只读 process.memoryUsage() 与 owner 的 sockets 计数，零额外内存。
  const diagTimer = setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const sockets = typeof owner.server?.getConnections === "function"
        ? undefined
        : undefined;
      // arrayBuffers 是 Buffer/ArrayBuffer 的 native 占用（不进 heapUsed）——
      // 2026-11-12 OOM 现场 RSS(2.9G) ≫ heapUsed(1.3G)+external(66M)，缺口在 native，
      // 这条字段是把它单独量出来的关键。
      log(`web-listener: diag rss=${Math.round(mem.rss / 1048576)}MB `
        + `heapUsed=${Math.round(mem.heapUsed / 1048576)}MB `
        + `heapTotal=${Math.round(mem.heapTotal / 1048576)}MB `
        + `external=${Math.round(mem.external / 1048576)}MB `
        + `arrayBuffers=${Math.round((mem.arrayBuffers ?? 0) / 1048576)}MB `
        + `viewers=${store.viewers.size} pid=${process.pid}`);
    } catch { /* diagnostics must never break the listener */ }
  }, 60_000);
  diagTimer.unref?.();

  return {
    started: true,
    owner,
    control,
    controlPort,
    store,
    close: () => {
      clearInterval(diagTimer);
      control.close();
      owner.close();
    },
  };
}

/**
 * Create the proxy server core (owner port only — per-viewer ports were removed).
 * @param upstream - upstream base URL.
 * @param authority - upstream `host:port`.
 * @param mint - cookie minter.
 * @param resolvePolicy - `() => policy | undefined` for this port (live).
 * @param log - logger.
 * @returns the `http.Server` (not yet listening).
 */
/**
 * Verify a `x-myco-viewer` connection-identity header injected by myco.
 *
 * Format: `<did>.<unix-ms>.<base64url HMAC-SHA256(key, did + "\n" + ts)>`.
 * Returns the did when valid, `undefined` otherwise. Time window ±5 min.
 *
 * 2026-11-09（用户实测暴露）：viewer 口没有连接级身份时，本机直连 17901
 * 也会被签成该口的 viewer label（口级归因）。网关按连接注入此头后，
 * 插件即可按「连接是谁」而非「哪个口」判定与署名。
 *
 * @param value - header value.
 * @param key - control-plane key (base64url text).
 * @param now - current epoch ms (injectable for tests).
 * @param windowMs - allowed clock skew.
 * @returns viewer did or undefined.
 */
export function verifyViewerHeader(value, key, now = Date.now(), windowMs = 300_000) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const keyBytes = Buffer.isBuffer(key)
    ? key
    : (typeof key === "string" && key.length > 0 ? Buffer.from(key, "base64url") : undefined);
  if (keyBytes === undefined) return undefined;
  const parts = value.split(".");
  if (parts.length !== 3) return undefined;
  const [did, tsRaw, sig] = parts;
  if (!did.startsWith("did:") || !/^\d+$/.test(tsRaw)) return undefined;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > windowMs) return undefined;
  let expected;
  try {
    expected = createHmac("sha256", keyBytes)
      .update(`${did}\n${ts}`)
      .digest("base64url");
  } catch {
    return undefined;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  return did;
}

function createProxyServer(upstream, authority, mint, resolvePolicy, log, connection = undefined) {
  const bridges = new Set();
  const server = http.createServer((request, response) => {
    proxyHttpRequest(request, response, upstream, authority, mint, log, resolvePolicy, connection);
  });
  server.on("upgrade", (request, socket, head) => {
    bridgeWebSocket(request, socket, head, upstream, authority, mint, bridges, resolvePolicy, connection);
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  server.$bridges = bridges;
  return server;
}

/**
 * Resolve the policy for one incoming connection: connection identity first
 * (signed header from myco), port-level entry as fallback.
 *
 * @returns `{policy, rejected}` — rejected=true when strict mode demands an identity.
 */
/** Best-effort list of policy keys for diagnostic logging. */
function storeViewers(connection) {
  try {
    return typeof connection?.keys === "function" ? connection.keys() : [];
  } catch {
    return [];
  }
}

function resolveConnectionPolicy(request, resolvePolicy, connection) {
  const portPolicy = resolvePolicy();
  if (connection === undefined) return { policy: portPolicy, rejected: false };
  const did = connection.verify(request);
  if (did !== undefined) {
    const byDid = connection.lookup(did);
    if (byDid !== undefined) return { policy: byDid, rejected: false };
    // 2026-11-11 用户裁决（零容忍）：**授权未就绪也必须拒绝**，绝不放行。
    // 表空 = 控制面尚未下发（全新安装或尚未推全量）→ 503（服务未就绪，非"无权限"）；
    // 表非空但缺该 DID = 未授权/已撤销 → 403。
    if (typeof connection.hasAnyPolicy === "function" && connection.hasAnyPolicy() === false) {
      return { policy: undefined, rejected: true, status: 503, reason: "authorization-not-ready" };
    }
    return { policy: undefined, rejected: true, status: 403, reason: `policy-missing:${did}` };
  }
  if (connection.require === true && portPolicy !== undefined) return { policy: portPolicy, rejected: true, reason: "identity-required" };
  return { policy: portPolicy, rejected: false };
}

/**
 * Forward one plain HTTP request to the upstream DSH web server, applying
 * the port's policy first (method allowlist + session allowlist), answering
 * denials locally with the benign envelope so the SPA never breaks.
 *
 * @param request - listener request.
 * @param response - listener response.
 * @param upstream - upstream base URL.
 * @param authority - upstream `host:port`.
 * @param mint - cookie minter.
 * @param log - logger.
 * @param resolvePolicy - live policy resolver for this port.
 */
function proxyHttpRequest(request, response, upstream, authority, mint, log, resolvePolicy = () => undefined, connection = undefined) {
  const resolved = resolveConnectionPolicy(request, resolvePolicy, connection);
  if (resolved.rejected) {
    // 诊断脚注（给页面和日志同时看）：真实原因不是"缺头"，而是
    // 带了合法身份但策略表里没有该 DID 的授权（或严格模式要求身份）。
    const reason = resolved.reason ?? "identity-required";
    const status = Number.isInteger(resolved.status) ? resolved.status : 403;
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(status === 503
      ? `authorization not ready (${reason})`
      : `viewer policy missing (${reason})`);
    log(`web-listener: rejected ${request.method} ${request.url} — ${reason} `
      + `(policy keys: ${JSON.stringify([...storeViewers(connection)])})`);
    return;
  }
  const policy = resolved.policy;
  const engine = policy?.kind === "engine";
  const method = methodFromUrl(request.url);
  const methodVerdict = decideHttp(policy, method);
  if (method !== undefined && methodVerdict.allowed === false) {
    answerDenialFromRequest(request, response, {
      envelope: engine ? "engine" : "simple",
      rule: methodVerdict.rule,
      reason: methodVerdict.reason,
    }, method);
    return;
  }
  const isList = method === "session/list";
  const scoped = engine ? !isList : (policy?.sessions !== undefined && method !== undefined && !isList);
  if (scoped) {
    // Session-scoped call: buffer the (small JSON) body to check sessionId.
    // (session/list never buffers here — the filtered forwarder owns the body.)
    bufferJsonBody(request, 1_000_000).then((body) => {
      const sessionId = body === undefined ? undefined : extractSessionId(method, body);
      if (sessionId !== undefined && !decideSession(policy, sessionId).allowed) {
        answerDenial(request, response, body, {
          envelope: engine ? "engine" : "simple",
          visibility: true,
          sessionId,
          reason: "session outside visibility",
        }, method);
        return;
      }
      forwardBuffered(request, response, body, upstream, authority, mint, log, policy);
    });
    return;
  }
  if ((engine || policy?.sessions !== undefined) && isList) {
    forwardAndFilterList(request, response, upstream, authority, mint, log, policy);
    return;
  }
  pipeUpstream(request, response, upstream, authority, mint, log);
}

/** Relay with full piping (no policy interposition). */
function pipeUpstream(request, response, upstream, authority, mint, log) {
  let target;
  try {
    target = new URL(request.url ?? "/", upstream);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const headers = proxyRequestHeaders(request.headers, authority, mint());
  const upstreamRequest = http.request({
    host: target.hostname,
    port: target.port || 80,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, relayedHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end(`web-listener: upstream unreachable (${String(error?.message ?? error)})\n`);
    log(`web-listener: proxy ${request.method} ${request.url} failed: ${String(error?.message ?? error)}`);
  });
  request.on("error", () => upstreamRequest.destroy());
  response.on("close", () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

/** Buffer a JSON request body (bounded), resolving `undefined` on failure. */
function bufferJsonBody(request, limitBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        resolve(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    request.on("error", () => resolve(undefined));
  });
}

/** Pull the session id a method's body addresses, by known shapes. */
function extractSessionId(method, body) {
  const value = body?.payload?.args?.request?.sessionId
    ?? body?.payload?.args?.sessionId
    ?? body?.payload?.args?.address?.sessionId;
  return typeof value === "string" ? value : undefined;
}

/** Answer a denied buffered request with the format-matching envelope. */
function answerDenial(request, response, body, verdict, method) {
  const rpcId = typeof body?.rpcId === "string" ? body.rpcId : null;
  const engine = verdict.envelope === "engine";
  let payload;
  if (engine && verdict.visibility === true) {
    payload = visibilityDeniedEnvelope(rpcId, verdict.sessionId ?? "");
  } else if (engine) {
    payload = capsDeniedEnvelope(rpcId, verdict.rule ?? method ?? "");
  } else {
    payload = denialEnvelope(rpcId, verdict.reason ?? "denied");
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(payload);
}

/** Pull the RPC method out of a parsed request envelope (best effort). */
function methodFromPayload(body) {
  return typeof body?.method === "string" ? body.method : undefined;
}

/** Denial without a body yet (method-level): read rpcId from the stream best-effort. */
function answerDenialFromRequest(request, response, verdict, method) {
  bufferJsonBody(request, 256_000).then((body) => answerDenial(request, response, body, verdict, method));
}

/** Strip length headers before forwarding a re-serialized body. */
function withoutLengthHeaders(headers) {
  return headers.filter(([name]) => {
    const key = name.toLowerCase();
    return key !== "content-length" && key !== "transfer-encoding";
  });
}

/** Re-send a buffered request upstream unchanged (optionally device-signed). */
function forwardBuffered(request, response, body, upstream, authority, mint, log, policy) {
  let payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
  // 设备发言署名：0.2.x 的 RPC 走 fetch POST（WS 只有下行事件），所以治理点就在这里。
  // 只有带权威 label 的 viewer 口才签；owner 口（无 policy）永远不签。
  const label = policy?.label;
  if (typeof label === "string" && label.length > 0 && isPromptWrite(methodFromPayload(body))) {
    const signed = signPromptBody(payload.toString("utf8"), label);
    if (signed !== undefined) {
      payload = Buffer.from(signed, "utf8");
      log(`web-listener: device-signed prompt as ${label}`);
    }
  }
  const target = new URL(request.url ?? "/", upstream);
  const headers = withoutLengthHeaders(proxyRequestHeaders(request.headers, authority, mint()));
  headers.push(["content-length", String(payload.length)]);
  const upstreamRequest = http.request({
    host: target.hostname,
    port: target.port || 80,
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, relayedHeaders(upstreamResponse.headers));
    upstreamResponse.pipe(response);
  });
  upstreamRequest.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502).end();
    log(`web-listener: forward ${request.url} failed: ${String(error?.message ?? error)}`);
  });
  response.on("close", () => upstreamRequest.destroy());
  upstreamRequest.end(payload);
}

/** `session/list` with a session allowlist: decode, filter, re-encode. */
function forwardAndFilterList(request, response, upstream, authority, mint, log, policy) {
  Promise.all([bufferJsonBody(request, 1_000_000), Promise.resolve(mint())]).then(([body, cookie]) => {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
    const target = new URL(request.url ?? "/", upstream);
    const headers = withoutLengthHeaders(proxyRequestHeaders(request.headers, authority, cookie));
    headers.push(["content-length", String(payload.length)]);
    const upstreamRequest = http.request({
      host: target.hostname,
      port: target.port || 80,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (upstreamResponse) => {
      const encoding = String(upstreamResponse.headers["content-encoding"] ?? "").toLowerCase();
      const plain = upstreamResponse.statusCode === 200 && (encoding === "" || encoding === "identity");
      if (upstreamResponse.statusCode !== 200 || !plain) {
        // Compressed / unexpected: relay untouched (the allowlist then only
        // gates requests, not the listing); DSH normally answers identity
        // when the proxy offered no accept-encoding.
        response.writeHead(upstreamResponse.statusCode ?? 502, relayedHeaders(upstreamResponse.headers));
        upstreamResponse.pipe(response);
        return;
      }
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const items = parsed?.result?.value?.items;
          if (Array.isArray(items)) {
            parsed.result.value.items = policy.kind === "engine"
              ? items.filter((item) => sessionVisible(policy.judgeVis, item.sessionId))
              : items.filter((item) => policy.sessions.has(normalizeSessionId(item.sessionId)));
          }
          const out = Buffer.from(JSON.stringify(parsed), "utf8");
          response.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          response.end(out);
        } catch {
          response.writeHead(502).end();
        }
      });
    });
    upstreamRequest.on("error", () => {
      if (!response.headersSent) response.writeHead(502).end();
      log("web-listener: filtered session/list upstream error");
    });
    response.on("close", () => upstreamRequest.destroy());
    upstreamRequest.end(payload);
  });
}

/**
 * Response header pairs safe to relay.
 *
 * Accepts a node `IncomingHttpHeaders`-shaped object (values may be strings
 * or arrays). `content-encoding`/`content-length` stay: bytes pass through
 * unmodified, so the browser decodes what it itself requested.
 * @param headers - upstream response headers.
 * @returns relayed pairs.
 */
export function relayedHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Bridge one WebSocket upgrade transparently to the upstream mux.
 *
 * The browser's `Sec-WebSocket-Key` is forwarded untouched, so the upstream
 * handshake answer validates at the browser — no frame inspection at all.
 * The two sockets are then piped byte-for-byte in both directions.
 *
 * Upgraded sockets leave Node's HTTP connection accounting, so neither
 * `server.close()` nor `closeAllConnections()` reaps them; the pair is
 * registered in `bridges` and destroyed explicitly on close.
 *
 * @param request - listener upgrade request.
 * @param socket - browser socket.
 * @param head - first bytes already buffered after the upgrade request.
 * @param upstream - upstream base URL.
 * @param authority - upstream `host:port`.
 * @param mint - cookie minter.
 * @param bridges - live bridge registry this pair is added to.
 */
function bridgeWebSocket(request, socket, head, upstream, authority, mint, bridges = new Set(), resolvePolicy = () => undefined, connection = undefined) {
  const target = new URL(request.url ?? "/", upstream);
  const headers = proxyRequestHeaders(request.headers, authority, mint(), { includeWebSocketHeaders: true });
  headers.push(["connection", "Upgrade"]);
  headers.push(["upgrade", "websocket"]);

  const pending = socket;
  pending.pause();

  const upgradeRequest = http.request({
    host: "127.0.0.1",
    port: target.port,
    method: "GET",
    path: `${target.pathname}${target.search}`,
    headers,
  });
  upgradeRequest.on("upgrade", (response, upstreamSocket, upstreamHead) => {
    const pair = { socket, upstreamSocket };
    bridges.add(pair);
    let headLine = `HTTP/1.1 101 Switching Protocols\r\n`;
    for (const [name, value] of Object.entries(response.headers)) {
      headLine += `${name}: ${value}\r\n`;
    }
    socket.write(`${headLine}\r\n`);
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    const drop = () => {
      bridges.delete(pair);
      socket.destroy();
      upstreamSocket.destroy();
    };
    socket.once("error", drop);
    upstreamSocket.once("error", drop);
    socket.once("close", () => { bridges.delete(pair); upstreamSocket.destroy(); });
    upstreamSocket.once("close", () => { bridges.delete(pair); socket.destroy(); });
    pending.resume();
    const startPipe = (firstChunk) => {
      if (firstChunk !== undefined && firstChunk.length > 0) upstreamSocket.write(firstChunk);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    };
    // First-frame policy: hold the pipe until the client's first WS frame
    // (an `open`) is inspected; only then forward it and everything after.
    const policy = resolveConnectionPolicy(request, resolvePolicy, connection).policy;
    if (policy === undefined) {
      startPipe();
    } else {
      interceptFirstClientFrame(socket, policy, drop, startPipe);
    }
  });
  upgradeRequest.on("response", (response) => {
    // Non-101 (typically 401): relay the verdict and close.
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? ""}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  });
  upgradeRequest.on("error", () => {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
    socket.destroy();
  });
  upgradeRequest.end();
}

/**
 * Hold the first client WebSocket frame, inspect it, then start piping.
 *
 * Client→server frames are masked; the frame is parsed (never modified).
 * Only `open` frames are inspected: a denial answers with a proper
 * unmasked error frame and closes the socket — coarse (one WS carries many
 * streams) but simple; clients reconnect and other streams proceed.
 *
 * @param socket - client socket.
 * @param policy - the port's live policy.
 * @param drop - destroy callback.
 * @param startPipe - `(firstChunk) => void`, called on allow with buffered bytes.
 */
function interceptFirstClientFrame(socket, policy, drop, startPipe) {
  const chunks = [];
  let decided = false;
  const onData = (chunk) => {
    if (decided) return;
    chunks.push(chunk);
    const buffered = Buffer.concat(chunks);
    const parsed = parseClientTextFrame(buffered);
    if (parsed === undefined) {
      if (buffered.length > 1_000_000) { decided = true; cleanup(); drop(); }
      return; // incomplete header/payload: wait for more bytes
    }
    decided = true;
    cleanup();
    const engine = policy.kind === "engine";
    try {
      const message = JSON.parse(parsed.payload.toString("utf8"));
      if (message?.type === "open") {
        const endpoint = typeof message.endpoint === "string" ? message.endpoint : undefined;
        // Engine entries judge through the ported Rust chain (method gate);
        // simple entries keep the interim allow-list semantics.
        const verdict = engine
          ? judgeMethod(policy.judgeCaps, endpoint, policy.admin === true)
          : decideStream(policy, endpoint);
        if (verdict.allowed === false) {
          const frame = engine
            ? JSON.stringify({
              type: "error",
              streamId: message.streamId ?? null,
              error: { code: "受保护", message: "这个操作由分享者控制；需要就在 myco 任务群里告诉 TA。" },
            })
            : denialStreamFrame(message.streamId, `endpoint "${endpoint}" not in allow list`);
          writeServerTextFrame(socket, frame);
          drop();
          return;
        }
        const sessionId = message?.payload?.args?.address?.sessionId ?? message?.payload?.args?.sessionId;
        if (endpoint !== undefined && sessionId !== undefined && !decideSession(policy, sessionId).allowed) {
          const frame = engine
            ? JSON.stringify({
              type: "error",
              streamId: message.streamId ?? null,
              error: { code: "不在可见范围", message: "这个会话不在分享者开放给你的范围里；需要就在 myco 任务群里告诉 TA。", details: { sessionId, scope: "session" } },
            })
            : denialStreamFrame(message.streamId, "session outside allowlist");
          writeServerTextFrame(socket, frame);
          drop();
          return;
        }
      }
    } catch {
      // not JSON or no open semantics: forward untouched
    }
    startPipe(buffered);
  };
  const cleanup = () => socket.off("data", onData);
  socket.on("data", onData);
}

/**
 * Parse one complete masked text frame from a buffer start.
 * @param buffered - bytes received so far.
 * @returns `{payload: Buffer}` when a whole frame is present, else `undefined`.
 */
export function parseClientTextFrame(buffered) {
  if (buffered.length < 2) return undefined;
  const opcode = buffered[0] & 0x0f;
  const masked = (buffered[1] & 0x80) !== 0;
  let length = buffered[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffered.length < 4) return undefined;
    length = buffered.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffered.length < 10) return undefined;
    const big = buffered.readBigUInt64BE(2);
    if (big > 4_000_000n) return undefined;
    length = Number(big);
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffered.length < offset + maskLength + length) return undefined;
  const mask = masked ? buffered.subarray(offset, offset + 4) : undefined;
  const payloadStart = offset + maskLength;
  const payload = buffered.subarray(payloadStart, payloadStart + length);
  if (mask === undefined) return { opcode, payload };
  const unmasked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ mask[i & 3];
  return { opcode, payload: unmasked };
}

/** Write one unmasked server text frame (denial path only). */
function writeServerTextFrame(socket, text) {
  const payload = Buffer.from(text, "utf8");
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

/* ─────────────────────────── port acquisition ───────────────────────────── */

/**
 * Bind `server` on the state file's port when free, else walk upward from
 * `basePort`.
 * @param server - the HTTP server.
 * @param stateFile - state file path.
 * @param basePort - walk start.
 * @returns the bound port, or `undefined` when every candidate is busy.
 */
export async function listenOnAcquiredPort(server, stateFile, basePort) {
  const state = await readStateFile(stateFile);
  const candidates = [];
  if (state !== undefined && state.port !== basePort) candidates.push(state.port);
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) candidates.push(basePort + offset);
  for (const port of candidates) {
    if (await tryListen(server, port)) return port;
  }
  return undefined;
}

/**
 * Attempt one `server.listen`; resolve `false` on EADDRINUSE.
 * @param server - the HTTP server.
 * @param port - candidate port.
 * @returns whether the bind succeeded.
 */
function tryListen(server, port) {
  return new Promise((resolve) => {
    const onError = (error) => {
      cleanup();
      resolve(error?.code === "EADDRINUSE" ? false : false);
    };
    const onListening = () => { cleanup(); resolve(true); };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Close a server. Upgraded sockets escape Node's HTTP connection accounting
 * — `server.close()` and `closeAllConnections()` never reap them, which
 * would leave the process (and any awaiting test) hanging — so live bridges
 * are destroyed explicitly first (Node ≥18.2 for the connection calls).
 * @param server - the HTTP server.
 * @param bridges - live bridge registry (may be undefined).
 */
function closeServer(server, bridges) {
  for (const pair of bridges ?? []) {
    try {
      pair.socket.destroy();
      pair.upstreamSocket.destroy();
    } catch {
      // already dead
    }
  }
  bridges?.clear();
  try {
    server.closeAllConnections?.();
  } catch {
    // older runtimes
  }
  try {
    server.close();
  } catch {
    // already closed
  }
}
