package com.myco.phone;

import android.util.Base64;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * NativeRdpTunnel — env 端口（本地固定口 → 对端目标口）的**原生数据面**。
 *
 * 根因背景：旧链路里 X25519/AES-GCM/帧序号全在 WebView JS（`vnet-forward.ts` +
 * `p2p-tunnel.ts`），原生只搬字节。外部客户端 App 一到前台（或被系统冻结），
 * myco 的 WebView JS 就停投回调 → 隧道停摆（0.3.175 A/B 定案）。本类把**整条链路**
 * 的协议栈搬进原生线程：握手信封/设备签名（{@link Ed25519}）/X25519+ECDH/HKDF/
 * AES-GCM 帧（{@link TunnelCrypto}、{@link TunnelFrameIo}）/WS 承载（{@link TunnelWs}，
 * 支持 relay:// 中继腿）全在 Java，不再依赖 Activity/WebView 活性。
 *
 * 2026-11-01 泛化：CFG 本来就是按 localPort 分桶的，原先只放开 23389/23911 是
 * 灰度白名单；真机（用户手机连 ECS 的 23390）证明**任何** env 端口都会踩同一个坑，
 * 现在任意 localPort（带显式 targetPort）都可托管，JS 侧也不再维护白名单。
 *
 * ── 身份与签名材料从哪来（不重复实现身份存储） ──────────────────────────────
 * JS 身份层（`vnet-forward.ts`）在身份就绪后经 `MycoShell.vnetRdpArm(json)` **注入**：
 * 账号 DID / 设备 DID / 设备种子（base64）/ 候选腿清单。种子只存在内存
 * （volatile 字段，disarm/重注即换），不落盘——身份存储仍在 WebView 的 localStorage/
 * vault，唯一来源不变。JS 冻结期间原生拿这份内存注入继续签新连接（正是本修的目标）。
 *
 * ── 与 ForwardListener 的分工 ───────────────────────────────────────────────
 * ForwardListener 负责 127.0.0.1:&lt;localPort&gt; 的监听/accept/本地读线程（在
 * `:tunnel` 进程里）；对已 arm 的端口，acceptLoop 调 {@link #take} 把连接交给
 * 本类（不再派 onConn 给 JS），本地读线程的字节经 {@link #onLocalData} 进加密泵，
 * 回程明文经 ForwardListener.send 写回本地 socket。本地侧关闭（EOF/drop）经
 * {@link #onLocalGone} 通知本类收尾 WS。
 *
 * 线程模型：每连接一个协调线程（{@link NativeRdpConn}）+ 每腿一个拨号线程
 * （{@link NativeRdpDialer}）+ 复用 ForwardListener 的本地读线程与 TunnelWs 的
 * reader 线程做双向泵。全部守护线程，随进程存亡（KeepAliveService 前台服务保进程，
 * 并在 tick 里watchdog 本类——见 KeepAliveService.startTunnelTick）。
 */
public class NativeRdpTunnel {

    /** RDP 固定本地口（与 remote-desktop.ts RDP_DEFAULT_LOCAL / eval/vnet/manual.md 同口径）。 */
    public static final int RDP_LOCAL_PORT = 23389;
    /** RDP 目标端口（PC 侧 3389）。 */
    public static final int RDP_TARGET_PORT = 3389;
    /** DSH 固定本地口（InAppBrowser 打开的 http://127.0.0.1:23911）。 */
    public static final int DSH_LOCAL_PORT = 23911;
    /** DSH 目标端口（PC 分享网关 13911）。 */
    public static final int DSH_TARGET_PORT = 13911;
    /** 整场赛跑硬预算（对齐 JS vnet-forward TOTAL_BUDGET_MS=12s，留握手余量）。 */
    public static final long RACE_TOTAL_MS = 15000;
    /** 单腿加密握手等待（对齐 JS handshakeTimeoutMs 默认 8s）。 */
    public static final long HANDSHAKE_TIMEOUT_MS = 8000;

    /** arm 配置（由 JS 注入；纯数据持有者，conns 快照引用，重 arm 不影响在途连接）。 */
    public static class Config {
        public int localPort;
        public String account;
        public String device;
        public byte[] seed;
        public String targetDevice;
        public int targetPort = RDP_TARGET_PORT;
        public List<String> legs = new ArrayList<String>();
        public long armedAtMs;
    }

    /**
     * 所有已 arm 的本地口都在 :tunnel 进程独立承载（CFG 按 localPort 分桶）。
     * InAppBrowser 全屏覆盖 MainActivity / 外部客户端 App 前台时主 WebView
     * document.hidden，Chromium 停投 `__mycoFwd`/`__mycoTunnel` 回调；resumeTimers
     * 不能恢复——所以数据面不能依赖主进程 WebView。
     */
    private static final Map<Integer, Config> CFG = new ConcurrentHashMap<Integer, Config>();
    private static final Map<String, NativeRdpConn> CONNS = new ConcurrentHashMap<String, NativeRdpConn>();
    private static final AtomicInteger CONN_SEQ = new AtomicInteger(1);

    // 诊断计数（EnvServer / GwLog 可读；不参与协议）
    private static final AtomicLong OPENED = new AtomicLong();
    private static final AtomicLong FAILED = new AtomicLong();
    private static final AtomicLong IN_BYTES = new AtomicLong();
    private static final AtomicLong OUT_BYTES = new AtomicLong();
    private static volatile String lastErr = "";
    private static volatile String lastOkLeg = "";
    private static int tickCount = 0;

    // ══════════════════ arm / disarm（JS 桥入口） ══════════════════

    /**
     * JS 注入配置（幂等可重复——身份/候选刷新即重注）。
     * json：{localPort,targetDevice,targetPort,account,device,seedB64,legs:[wsUrl...]}
     * 返回 {"ok":true,...} / {"ok":false,"err":"人话"}。
     */
    public static synchronized String arm(String json) {
        try {
            JSONObject o = new JSONObject(json == null ? "" : json);
            int localPort = o.optInt("localPort", 0);
            // 2026-11-01 泛化：不再限定 23389/23911——任意 env 本地口都可托管。
            if (localPort <= 0 || localPort > 65535) {
                return "{\"ok\":false,\"err\":\"localPort 非法（须 1..65535）\"}";
            }
            String targetDevice = o.optString("targetDevice", "").trim();
            String account = o.optString("account", "").trim();
            String device = o.optString("device", "").trim();
            String seedB64 = o.optString("seedB64", "").trim();
            int defaultTarget = localPort == DSH_LOCAL_PORT ? DSH_TARGET_PORT
                    : localPort == RDP_LOCAL_PORT ? RDP_TARGET_PORT : 0;
            int targetPort = o.optInt("targetPort", defaultTarget);
            if (targetDevice.isEmpty() || account.isEmpty() || device.isEmpty()) {
                return "{\"ok\":false,\"err\":\"身份/目标设备缺失（等身份就绪再注）\"}";
            }
            byte[] seed;
            try {
                seed = Base64.decode(seedB64, Base64.NO_WRAP);
            } catch (Exception e) {
                return "{\"ok\":false,\"err\":\"seedB64 解码失败\"}";
            }
            if (seed == null || seed.length != 32) {
                return "{\"ok\":false,\"err\":\"设备种子必须 32B\"}";
            }
            int resolvedTarget = targetPort > 0 ? targetPort : defaultTarget;
            if (resolvedTarget <= 0 || resolvedTarget > 65535) {
                return "{\"ok\":false,\"err\":\"targetPort 非法（非 23389/23911 端口必须显式给 targetPort）\"}";
            }
            JSONArray legsArr = o.optJSONArray("legs");
            Config c = new Config();
            c.localPort = localPort;
            c.account = account;
            c.device = device;
            c.seed = seed;
            c.targetDevice = targetDevice;
            c.targetPort = resolvedTarget;
            if (legsArr != null) {
                for (int i = 0; i < legsArr.length(); i++) {
                    String leg = legsArr.optString(i, "").trim();
                    if (!leg.isEmpty()) c.legs.add(leg);
                }
            }
            if (c.legs.isEmpty()) {
                return "{\"ok\":false,\"err\":\"候选腿为空（至少要中继腿）\"}";
            }
            c.armedAtMs = System.currentTimeMillis();
            boolean rearm = CFG.containsKey(localPort);
            CFG.put(localPort, c);
            GwLog.note(null, "native-stream arm local=" + localPort + " " + (rearm ? "刷新" : "就绪")
                    + " 目标=" + shortDid(c.targetDevice) + ":" + c.targetPort + " legs=" + c.legs.size());
            return "{\"ok\":true,\"localPort\":" + localPort + ",\"legs\":" + c.legs.size() + "}";
        } catch (Exception e) {
            return "{\"ok\":false,\"err\":\"" + ForwardListener.esc(String.valueOf(e)) + "\"}";
        }
    }

    /** 撤注指定端口（转发删除/停用时 JS 调；在途连接自然收尾）。 */
    public static synchronized void disarm(int localPort) {
        if (CFG.remove(localPort) != null) {
            GwLog.note(null, "native-stream disarm local=" + localPort + "（新连接回落 JS 路径）");
        }
    }

    /** 撤注全部原生流端口（兼容旧 vnetRdpDisarm 无参桥）。 */
    public static synchronized void disarmAll() {
        if (!CFG.isEmpty()) GwLog.note(null, "native-stream disarm all=" + CFG.keySet());
        CFG.clear();
    }

    public static boolean armed() {
        return !CFG.isEmpty();
    }

    /** 是否是原生路径要接的端口（ForwardListener.acceptLoop 问）。 */
    public static boolean wants(int localPort) {
        return CFG.containsKey(localPort);
    }

    // ══════════════════ ForwardListener 挂点 ══════════════════

    /**
     * 接管一条本地连接（acceptLoop 在派 onConn 之前问；返回 false = 仍走 JS）。
     * 接管 = 起协调线程（拨腿赛跑 + 加密握手 + 接泵）。
     */
    public static boolean take(int localPort, int connId, Socket local) {
        Config c = CFG.get(localPort);
        if (c == null) return false;
        NativeRdpConn conn = new NativeRdpConn(c, localPort, connId, local);
        CONNS.put(connKey(localPort, connId), conn);
        OPENED.incrementAndGet();
        GwLog.note(null, "native-stream conn :" + localPort + "/" + connId + " 原生接管（" + c.legs.size() + " 腿）");
        Thread t = new Thread(conn, "myco-stream-" + localPort + "-" + connId);
        t.setDaemon(true);
        t.start();
        return true;
    }

    /** 复合键：端口隔离，绝不让 23389/23911 的同号 connId 串台。 */
    private static String connKey(int localPort, int connId) {
        return localPort + ":" + connId;
    }

    private static NativeRdpConn conn(int localPort, int connId) {
        return CONNS.get(connKey(localPort, connId));
    }

    /** 本地 socket 来了字节（ForwardListener 读线程调）。 */
    public static void onLocalData(int localPort, int connId, byte[] data) {
        NativeRdpConn conn = conn(localPort, connId);
        if (conn != null) conn.onLocalData(data);
    }

    /** 该连接是否已被原生接管（ForwardListener.onRead 路由判据）。 */
    public static boolean peekNative(int localPort, int connId) {
        return conn(localPort, connId) != null;
    }

    /** 本地连接没了（EOF/drop/stop；ForwardListener.drop 调）——收尾 WS。 */
    public static void onLocalGone(int localPort, int connId, String why) {
        NativeRdpConn conn = conn(localPort, connId);
        if (conn != null) conn.onLocalGone(why);
    }

    static void noteConnClosed(NativeRdpConn conn, String why, long inBytes, long outBytes) {
        // 条件删除：即使 connId 将来被复用，旧连接也只能删掉自己，不能误删新连接。
        CONNS.remove(connKey(conn.localPort, conn.connId), conn);
        IN_BYTES.addAndGet(inBytes);
        OUT_BYTES.addAndGet(outBytes);
        GwLog.note(null, "native-stream conn :" + conn.localPort + "/" + conn.connId + " 关闭 " + why
                + " in=" + inBytes + "B out=" + outBytes + "B");
    }

    static void noteEstablished(int connId, int localPort, String leg, long ms) {
        lastOkLeg = leg;
        GwLog.note(null, "native-stream conn :" + localPort + "/" + connId + " 隧道通 " + leg + " " + ms + "ms");
    }

    static void noteFail(int connId, int localPort, String why) {
        FAILED.incrementAndGet();
        lastErr = why;
        GwLog.note(null, "native-stream conn :" + localPort + "/" + connId + " 建连失败 " + why);
    }

    // ══════════════════ 诊断（EnvServer / KeepAliveService tick 用） ══════════════════

    /** 当前 :tunnel 进程是否仍有任一有效 arm；用于 disarm 后停止 presence 心跳。 */
    public static boolean hasArmed() { return !CFG.isEmpty(); }

    /** 状态 JSON（`MycoShell.vnetRdpState()` → EnvServer eval 可读；streams 含 RDP/DSH）。 */
    public static String state() {
        try {
            Config rdp = CFG.get(RDP_LOCAL_PORT);
            JSONObject root = new JSONObject();
            root.put("ok", true);
            root.put("armed", rdp != null);
            root.put("localPort", RDP_LOCAL_PORT);
            if (rdp != null) {
                root.put("targetDevice", shortDid(rdp.targetDevice));
                root.put("targetPort", rdp.targetPort);
                root.put("legs", rdp.legs.size());
                root.put("armedAtMs", rdp.armedAtMs);
            }
            root.put("conns", CONNS.size());
            root.put("opened", OPENED.get());
            root.put("failed", FAILED.get());
            root.put("inBytes", IN_BYTES.get());
            root.put("outBytes", OUT_BYTES.get());
            if (!lastOkLeg.isEmpty()) root.put("lastOkLeg", lastOkLeg);
            if (!lastErr.isEmpty()) root.put("lastErr", lastErr);
            JSONArray streams = new JSONArray();
            List<Integer> ports = new ArrayList<Integer>(CFG.keySet());
            java.util.Collections.sort(ports);
            for (Integer port : ports) {
                Config c = CFG.get(port);
                if (c == null) continue;
                JSONObject s = new JSONObject();
                s.put("localPort", c.localPort);
                s.put("targetDevice", shortDid(c.targetDevice));
                s.put("targetPort", c.targetPort);
                s.put("legs", c.legs.size());
                s.put("armedAtMs", c.armedAtMs);
                streams.put(s);
            }
            root.put("streams", streams);
            return root.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"err\":\"" + ForwardListener.esc(String.valueOf(e)) + "\"}";
        }
    }

    /** KeepAliveService 每 4s 调；每 ~32s 落一行 watchdog（冻结窗口里的活性证据）。 */
    public static void tick() {
        tickCount++;
        if ((tickCount % 8) != 0) return;
        GwLog.note(null, "native-stream tick armed=" + CFG.keySet()
                + " conns=" + CONNS.size() + " opened=" + OPENED.get() + " failed=" + FAILED.get()
                + " in=" + (IN_BYTES.get() / 1024) + "KB out=" + (OUT_BYTES.get() / 1024) + "KB");
    }

    static String shortDid(String did) {
        if (did == null) return "";
        return did.length() > 10 ? "…" + did.substring(did.length() - 8) : did;
    }

    static String nextConnTag() {
        return "c" + CONN_SEQ.getAndIncrement();
    }
}
