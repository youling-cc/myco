package com.myco.phone;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * P2pDeviceTunnel（保留旧名 P2pSyncTunnel 以免动 MainActivity 接线）
 * —— 手机到某台对端设备的**设备级 vnet 隧道 + 端口映射表**（2026-11-11）。
 *
 * ## 为什么是"一条连接 + 多端口映射"
 * myco 现役配置 `MYCO_VNET_MULTI_FORWARD=1`：对端**只**起一条设备级
 * multi-forward server（peer_id = SHA256("vnet-peer"||did||":server:multi-forward-v1")），
 * 逐端口 server（`:server:9100` 之类）根本不启动。所以：
 *   · 连接必须用**设备级** peer_id 建，且只建一条（多建会互抢本地口）；
 *   · 每个要用的对端端口（9100 对账 / 15200 网关 / 3389 RDP）用
 *     `vnet_client_add_forward` 追加一条本地回环口。
 *
 * ## 为什么不再"单隧道、换目标先停旧实例"
 * 旧实现（同日早些时候）为省端口把隧道做成单实例，换目标就停旧的。实测两个后果：
 *   ① 两台设备（PC + 笔记本）交替对账时互相拆台，两边的 ensure 都失败；
 *   ② 承接 DSH/RDP 的第二个端口无处可放。
 * 现在按 **device** 一条连接、按 **(device,targetPort)** 一条转发，本地口由本类
 * 从 {@link #PORT_BASE} 起自动分配，调用方不需要自己算。
 *
 * ## 期望面（DESIRED）：重建后必须重放，不能只补当前这一条
 * vnet 的 `stopClientPeer` 是**整条连接**级的：它一停，挂在这条连接上的**所有端口**
 * listener 同时消失。2026-11-12 实测 RED：给同一设备再 ensure 一个坏端口
 * （target 22，探活必然失败）→ 触发重建 → 该设备的转发表只剩新端口，
 * DSH 的 23912 和对账的 25911 **一起消失**，浏览器当场 ERR_CONNECTION_REFUSED。
 * 所以本类另存一份与连接无关的"期望转发集" `DESIRED`：重建时按它逐条重放，
 * **本地口沿用旧值**——已经打开的页面 URL（`<alias>.localhost:23912`）不会失效。
 *
 * ## 与 :tunnel 进程 VnetTransport.arm 的分工
 * 那是 RDP/DSH 的 `ForwardListener` 语义数据面（撤注即 vnet_client_stop 停全部
 * 实例），跑在 :tunnel 进程；本类在**主进程**，按需给 JS/WebView 提供本地回环口。
 * libvnet 状态按进程隔离，互不干扰。
 */
public final class P2pSyncTunnel {

    /** 默认对端端口：p2p 数据面（对账）。 */
    public static final int DEFAULT_TARGET_PORT = 9100;
    /** 本地回环口自动分配起点（避开 ForwardListener/env 固定口段）。 */
    public static final int PORT_BASE = 25910;
    public static final int PORT_MAX = 25999;
    /** dataPlaneAlive 结论复用窗口：窗口内重复 ensure 不再端到端探活。
     *  为什么需要：探活最坏 5s（读超时），而 JS 一次打开会并发/连续 ensure 多个端口，
     *  串行叠加会把 ensure 拖到十几秒（实测曾有 14 个 p2p-ensure 线程排队）。 */
    public static final long ALIVE_TTL_MS = 8000;
    /** 重建后的冷静期：这段时间内不再因探活失败二次重建。
     *  为什么需要：重建后客户端刚起，P2P/relay 还在握手，别的端口这一拍的
     *  dataPlaneAlive 必然失败 → 又触发重建 → 重建风暴（2026-11-12 实测一次
     *  ensure 引发 rebuilds 1→3，第二次重建把正在加载的页面打断）。
     *  冷静期内只认 listener（probeLocal），把「数据面是否真通」交给调用方的
     *  真实请求去判——失败由用户/页面下一次 ensure 兜。 */
    public static final long REBUILD_GRACE_MS = 12000;

    /** deviceDid → 该设备的 multi-forward client peer_id。 */
    private static final Map<String, Integer> DEVICE_CLIENT = new HashMap<>();
    /** "deviceDid|targetPort" → 本地回环口（已 armed）。 */
    private static final Map<String, Integer> FORWARDS = new HashMap<>();
    /** 本地回环口 → "deviceDid|targetPort"（反向占用表，防两个组合抢同一口）。 */
    private static final Map<Integer, String> PORT_OWNER = new HashMap<>();
    /** deviceDid → (targetPort → localPort)：**期望**转发集，跨客户端重建存活。 */
    private static final Map<String, Map<Integer, Integer>> DESIRED = new HashMap<>();
    /** 本地回环口 → 上次端到端探活通过的时刻（见 {@link #ALIVE_TTL_MS}）。 */
    private static final Map<Integer, Long> ALIVE_OK_AT = new HashMap<>();

    // ═══ 2026-11-13 期望面持久化（用户立法：卡定需求，重启不失忆）═══
    // 真机 RED：app 重启 → DESIRED（内存态）清空 → 3389(RDP) 无人挂载，
    // 直到用户点卡才现场 ensure——PC 重启/手机重启后的第一次点卡必踩
    // 「隧道重建窗」而失败。期望面必须跨进程重启存活，并在启动后主动拉起。
    private static android.content.Context appCtx;
    /** 最近一次 ensure 传入的本机设备 did（恢复线程要用它拼 ensure 请求）。 */
    private static volatile String myDeviceDid = "";
    /** deviceDid → 上次重建时刻（冷静期判据，见 {@link #REBUILD_GRACE_MS}）。 */
    private static final Map<String, Long> REBUILD_AT = new HashMap<>();

    private static volatile String lastErr = "";
    private static volatile long lastOkAtMs = 0;
    private static volatile String lastDevice = "";
    private static volatile int lastTargetPort = 0;
    private static volatile int lastLocalPort = 0;
    private static volatile long rebuilds = 0;
    private static volatile String lastRebuildReason = "";
    private static volatile long lastRebuildAtMs = 0;
    /** 最后一次重建的重放明细（逐端口 rc/probe/why），重建失败时唯一的现场。 */
    private static volatile String lastReplay = "";
    /** 最后一次 ensure 的分支轨迹（走了哪条路、命中什么、重建看到什么）。 */
    private static volatile String lastTrace = "";

    private P2pSyncTunnel() {}

    private static String key(String device, int targetPort) {
        return device + "|" + targetPort;
    }

    /** 本地回环口探活（250ms×v4/v6）：转发 listener 随 vnet 连接死亡而关闭，
     *  connect 被拒 = 连接已死。只证本地 listener，不证对端业务——但覆盖
     *  「连接销毁/进程重启后映射残留」这一类（2026-11-12 白屏实案的杀手）。 */
    private static boolean probeLocal(int port) {
        for (String host : new String[] { "127.0.0.1", "::1" }) {
            java.net.Socket s = new java.net.Socket();
            try {
                s.connect(new java.net.InetSocketAddress(host, port), 250);
                s.close();
                return true;
            } catch (Throwable ignored) {
                try { s.close(); } catch (Throwable ignored2) { }
            }
        }
        return false;
    }

    /** 数据面端到端探活：经隧道拉网关的 /myco-assets/manifest.webmanifest
     *  （无鉴权小文件 ~0.5KB，网关恒供）。probeLocal 只证「listener 在 accept」，
     *  app 后台冻结杀 socket 后 listener 仍在但 vnet 连接已死——数据全黑洞。
     *  超时口径：连接层失败/立即 EOF = 死；首字节慢（P2P-v6 冷启动可能 >2s）不算死
     *  ——读超时 5s，只在 IOException（拒绝/重置）时判死，readTimeout 到点视为
     *  「慢但活」不 evict（避免误杀健康连接引发重建循环）。 */
    private static boolean dataPlaneAlive(int port) {
        // 2026-11-13 按端口选探活方式（用户立法：探活方式是卡的属性，不是平台的）：
        // RDP(目标 3389) 是 X.224 二进制协议——HTTP GET 它只会挂到读超时被误判「慢但活」，
        // 隧道死了也查不出来（幂等分支放行 → 黑洞）。改发 X.224 CR、等 CC 首字节：
        // 有应答=真活，静默/异常=死。探活包取 returnpath 回归的同款字节。
        String owner = PORT_OWNER.get(port);
        if (owner != null && owner.endsWith("|3389")) {
            return x224Alive(port);
        }
        return httpAlive(port);
    }

    /** X.224 探活：发 CR TPDU，等任意首字节（RDP 服务器会回 CC）。2.5s 内
     *  无应答/异常 = 死（RDP 应答是即时的，不存在「慢但活」）。 */
    private static boolean x224Alive(int localPort) {
        java.net.Socket s = new java.net.Socket();
        try {
            s.connect(new java.net.InetSocketAddress("127.0.0.1", localPort), 800);
            s.setSoTimeout(2500);
            s.getOutputStream().write(new byte[] {
                    3, 0, 0, 19, 14, (byte) 0xE0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0 });
            s.getOutputStream().flush();
            int b = s.getInputStream().read();
            return b == 0x03; // CC TPDU 也以 03 00 00 开头
        } catch (Throwable t) {
            return false;
        } finally {
            try { s.close(); } catch (Throwable ignored) { }
        }
    }

    private static boolean httpAlive(int port) {
        java.net.HttpURLConnection c = null;
        try {
            java.net.URL u = new java.net.URL("http://127.0.0.1:" + port
                    + "/myco-assets/manifest.webmanifest");
            c = (java.net.HttpURLConnection) u.openConnection();
            c.setConnectTimeout(800);
            c.setReadTimeout(5000);
            c.setRequestProperty("Accept-Encoding", "identity");
            return c.getResponseCode() == 200;
        } catch (java.net.SocketTimeoutException e) {
            // 读超时 = 首字节慢（P2P-v6 冷启动/对端忙）——慢≠死，不 evict
            return true;
        } catch (java.io.IOException e) {
            // 连接拒绝/重置/立即 EOF = listener 或隧道真死
            return false;
        } catch (Throwable t) {
            return true; // 未知异常保守视为活，交由上层 open 语义兜底
        } finally {
            if (c != null) { try { c.disconnect(); } catch (Throwable ignored) { } }
        }
    }

    /** 带结论缓存的端到端探活（见 {@link #ALIVE_TTL_MS}）。 */
    private static boolean aliveCached(int port) {
        Long at = ALIVE_OK_AT.get(port);
        long now = System.currentTimeMillis();
        if (at != null && now - at >= 0 && now - at < ALIVE_TTL_MS) return true;
        boolean ok = dataPlaneAlive(port);
        if (ok) ALIVE_OK_AT.put(port, now); else ALIVE_OK_AT.remove(port);
        return ok;
    }

    /** 分配一个没被占用的本地口（从 PORT_BASE 起顺序找）。 */
    private static int allocPort() {
        for (int p = PORT_BASE; p <= PORT_MAX; p++) {
            if (!PORT_OWNER.containsKey(p)) return p;
        }
        return 0;
    }

    /** 起一条设备级客户端（先停同 peer_id 的旧实例，保证干净）。
     *  返回 peer_id 或 **null**（失败，原因在 {@link #lastErr}）。
     *
     *  ⚠ 必须用可空 Integer 判失败：vnet peer_id 是 **u32**，Java `int` 有一半概率
     *  是负数（实测 `cp=-1827200503` 是合法 id）。2026-11-12 用 `cp < 0` 判失败，
     *  把自己刚起的连接当失败，连带 rebuild 直接早退不重放——整链假死。
     */
    private static Integer startClientFor(String device, String targetDevice, String relay, String secret) {
        int cp = VnetTransport.clientPeerId(device, targetDevice, 0);
        int multiServer = VnetTransport.multiServerPeerId(targetDevice);
        try { VnetClient.stopClientPeer(cp); } catch (Throwable ignored) { }
        int rc = VnetClient.vnet_client_start_multi(relay, cp, multiServer, secret);
        if (rc != VnetClient.VNET_OK && rc != VnetClient.VNET_ERR_RUNNING) {
            lastErr = "vnet_client_start_multi rc=" + rc + " why=" + VnetClient.lastError();
            return null;
        }
        DEVICE_CLIENT.put(targetDevice, cp);
        return cp;
    }

    /** 逐端口 arm 结果明细（重建排障用：只记最后一次 arm 的 rc/probe/why）。 */
    private static volatile String armDetail = "";

    /** 挂一条转发并登记到活表/期望表（幂等：重复挂同口同目标无害）。 */
    private static boolean armPort(int clientPeer, String targetDevice, int targetPort, int localPort) {
        int rc = VnetClient.vnet_client_add_forward(clientPeer, (short) localPort, (short) targetPort);
        if (rc != VnetClient.VNET_OK && rc != VnetClient.VNET_ERR_RUNNING) {
            // 幂等兜底：vnet 对「同口重复转发」返回 INTERNAL；若该口确实在 accept，
            // 说明映射早已存在于连接里（活表丢帧/重放重复），按已挂处理而不是报错。
            boolean listening = probeLocal(localPort);
            armDetail = localPort + "<-" + targetPort + " rc=" + rc + " probe=" + listening
                    + " why=" + VnetClient.lastError();
            if (!listening) {
                lastErr = "add_forward(" + localPort + "->" + targetPort + ") rc=" + rc
                        + " why=" + VnetClient.lastError();
                return false;
            }
        } else {
            armDetail = localPort + "<-" + targetPort + " rc=" + rc + " ok";
        }
        FORWARDS.put(key(targetDevice, targetPort), localPort);
        PORT_OWNER.put(localPort, key(targetDevice, targetPort));
        Map<Integer, Integer> want = DESIRED.get(targetDevice);
        if (want == null) {
            want = new LinkedHashMap<>();
            DESIRED.put(targetDevice, want);
        }
        want.put(targetPort, localPort);
        persistDesired();
        return true;
    }

    // ═══ 期望面持久化：init 恢复 / armPort 落盘 / 恢复线程主动拉起 ═══

    /** MainActivity.onCreate 调：恢复上次的期望面，并排一个延迟恢复线程。 */
    public static void init(android.content.Context ctx) {
        appCtx = ctx.getApplicationContext();
        try {
            String s = appCtx.getSharedPreferences("p2p_tunnel", 0).getString("desired", null);
            if (s != null && !s.isEmpty()) {
                JSONObject o = new JSONObject(s);
                myDeviceDid = o.optString("device", "");
                JSONObject want = o.optJSONObject("desired");
                if (want != null) {
                    java.util.Iterator<String> it = want.keys();
                    while (it.hasNext()) {
                        String dev = it.next();
                        JSONObject ports = want.getJSONObject(dev);
                        Map<Integer, Integer> m = new LinkedHashMap<>();
                        java.util.Iterator<String> pk = ports.keys();
                        while (pk.hasNext()) {
                            String k = pk.next();
                            m.put(Integer.parseInt(k), ports.getInt(k));
                        }
                        DESIRED.put(dev, m);
                    }
                }
                android.util.Log.i("P2pDeviceTunnel", "init: 恢复期望面 devices=" + DESIRED.size());
            }
        } catch (Throwable t) {
            android.util.Log.w("P2pDeviceTunnel", "init: 期望面恢复失败 " + t);
        }
        // 恢复线程：等网络/身份就绪（SPA vnet-identity 注入）后把期望面全部拉起。
        // 25s = 冷启动身份链（presence/注册）实测余量；失败不重试——
        // 各端口的自然消费者（sync tick / 点卡）会兜底 ensure。
        Thread t = new Thread(() -> {
            try { Thread.sleep(25_000); } catch (InterruptedException ignored) { }
            try { restoreDesired(); } catch (Throwable x) {
                android.util.Log.w("P2pDeviceTunnel", "restore: " + x);
            }
        }, "p2p-restore");
        t.setDaemon(true);
        t.start();
    }

    private static void restoreDesired() {
        if (myDeviceDid.isEmpty() || DESIRED.isEmpty()) return;
        Map<String, Map<Integer, Integer>> snap;
        synchronized (P2pSyncTunnel.class) { snap = new HashMap<>(DESIRED); }
        for (Map.Entry<String, Map<Integer, Integer>> e : snap.entrySet()) {
            for (Map.Entry<Integer, Integer> p : e.getValue().entrySet()) {
                try {
                    String r = ensure(new JSONObject()
                            .put("device", myDeviceDid)
                            .put("targetDevice", e.getKey())
                            .put("targetPort", p.getKey())
                            .put("localPort", p.getValue()).toString());
                    android.util.Log.i("P2pDeviceTunnel",
                            "restore " + e.getKey() + ":" + p.getKey() + " -> " + r);
                } catch (Throwable ignored) { }
            }
        }
    }

    private static void persistDesired() {
        if (appCtx == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("device", myDeviceDid);
            JSONObject want = new JSONObject();
            for (Map.Entry<String, Map<Integer, Integer>> e : DESIRED.entrySet()) {
                JSONObject ports = new JSONObject();
                for (Map.Entry<Integer, Integer> p : e.getValue().entrySet()) {
                    ports.put(String.valueOf(p.getKey()), p.getValue());
                }
                want.put(e.getKey(), ports);
            }
            o.put("desired", want);
            appCtx.getSharedPreferences("p2p_tunnel", 0).edit()
                    .putString("desired", o.toString()).apply();
        } catch (Throwable ignored) { }
    }

    /**
     * 客户端重建：停旧实例 → 起新实例 → **按 DESIRED 重放该设备全部转发**（本地口不变）。
     *
     * 为什么必须重放：`stopClientPeer` 是连接级的，会把挂在这条连接上的所有端口
     * listener 一起销毁。只补当前这一条 → 其余端口（DSH 23912 / RDP / 对账 25911）
     * 静默失效，页面打开瞬间 ERR_CONNECTION_REFUSED（2026-11-12 RED 实测）。
     *
     * @return 重建后的 client peer_id（u32 位型，可能为负）；重放一条都没成功则 **null**。
     */
    private static Integer rebuildDevice(String device, String targetDevice, String relay,
                                         String secret, String reason) {
        Integer old = DEVICE_CLIENT.remove(targetDevice);
        if (old != null) { try { VnetClient.stopClientPeer(old); } catch (Throwable ignored) { } }
        // 清活表（端口已随连接销毁），**不清 DESIRED**——期望面跨重建存活
        java.util.Iterator<Map.Entry<String, Integer>> it = FORWARDS.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Integer> e = it.next();
            if (e.getKey().startsWith(targetDevice + "|")) {
                ALIVE_OK_AT.remove(e.getValue());
                PORT_OWNER.remove(e.getValue());
                it.remove();
            }
        }
        rebuilds++;
        lastRebuildAtMs = System.currentTimeMillis();
        lastRebuildReason = reason;
        REBUILD_AT.put(targetDevice, lastRebuildAtMs);

        Integer cp = startClientFor(device, targetDevice, relay, secret);
        if (cp == null) {
            android.util.Log.w("P2pDeviceTunnel", "rebuild failed: " + reason + " — " + lastErr);
            return null;
        }
        int armed = 0;
        int lost = 0;
        StringBuilder replay = new StringBuilder();
        Map<Integer, Integer> want = DESIRED.get(targetDevice);
        lastTrace = lastTrace + " | rebuild cp=" + cp + " want=" + (want == null ? "null" : want.toString())
                + " live=" + FORWARDS.size() + " owner=" + PORT_OWNER.size();
        if (want != null) {
            for (Map.Entry<Integer, Integer> w : new LinkedHashMap<>(want).entrySet()) {
                if (armPort(cp, targetDevice, w.getKey(), w.getValue())) armed++;
                else lost++;
                if (replay.length() > 0) replay.append(",");
                replay.append(armDetail);
            }
        }
        lastReplay = replay.toString();
        android.util.Log.w("P2pDeviceTunnel", String.format(
                "rebuild(0x%08X) reason=%s replay=%d lost=%d [%s]",
                cp, reason, armed, lost, lastReplay));
        return (armed > 0 || lost == 0) ? cp : null;
    }

    private static String okJson(int localPort, int targetPort, boolean created) throws Exception {
        lastOkAtMs = System.currentTimeMillis();
        lastLocalPort = localPort;
        lastTargetPort = targetPort;
        return new JSONObject()
                .put("ok", true).put("localPort", localPort)
                .put("targetPort", targetPort).put("multi", true)
                .put("created", created).toString();
    }

    /**
     * 确保「本机 → targetDevice:targetPort」有一条本地回环口。
     *
     * json：{targetDevice:对端设备did, device:本机设备did, targetPort:9100,
     *        localPort:0（可选，0=自动分配）}
     * 返回：{"ok":true,"localPort":n,"targetPort":n,"multi":true,"created":bool}
     *      /{"ok":false,"err":"…","why":"…"}
     *
     * 幂等：同 (device,targetPort) 重复调用直接返回已分配的口，不重建连接。
     * 单次尝试不重试（失败交给调用方下一拍；不要把对账拖成 20s）。
     */
    public static synchronized String ensure(String json) {
        try {
            JSONObject o = new JSONObject(json == null ? "" : json);
            String targetDevice = o.optString("targetDevice", "").trim();
            String device = o.optString("device", "").trim();
            if (targetDevice.isEmpty() || device.isEmpty()) {
                return err("缺少 targetDevice/device");
            }
            if (!device.isEmpty()) myDeviceDid = device;
            int targetPort = o.optInt("targetPort", DEFAULT_TARGET_PORT);
            int wantLocal = o.optInt("localPort", 0);
            if (targetPort <= 0 || targetPort > 65535) {
                return err("targetPort 非法 " + targetPort);
            }
            if (wantLocal < 0 || wantLocal > 65535) {
                return err("localPort 非法 " + wantLocal);
            }

            String relay = o.optString("relay", "").trim();
            if (relay.isEmpty()) relay = VnetTransport.DEFAULT_RELAY;
            String secret = o.optString("secret", "");
            if (secret.isEmpty()) secret = VnetTransport.DEFAULT_SECRET;

            // 已 armed 且端口仍在占用表里 → **两级验活**再幂等返回：
            // ① probeLocal（回环 accept）抓「连接销毁后映射残留」；
            // ② dataPlaneAlive（端到端 HTTP 拉网关 manifest）抓「listener 活着但隧道已死」。
            // 任一失败 → rebuildDevice：停机重建后按 DESIRED 重放该设备**全部**端口，
            // 绝不能只补当前这一条（否则别的端口被连坐，见类注释）。
            Integer hit = FORWARDS.get(key(targetDevice, targetPort));
            if (hit != null && PORT_OWNER.containsKey(hit)) {
                if (probeLocal(hit) && aliveCached(hit)) {
                    lastDevice = targetDevice;
                    lastTargetPort = targetPort;
                    lastLocalPort = hit;
                    return okJson(hit, targetPort, false);
                }
                boolean listener = probeLocal(hit);
                lastTrace = "hitdead port=" + hit + " listener=" + listener + " alive=false";
                Long rebuiltAt = REBUILD_AT.get(targetDevice);
                if (listener && rebuiltAt != null
                        && System.currentTimeMillis() - rebuiltAt < REBUILD_GRACE_MS) {
                    // 冷静期内不二次重建（防重建风暴）：listener 在就交回调用方，
                    // 数据面是否真通由它这次真实请求说了算（见 REBUILD_GRACE_MS）。
                    lastDevice = targetDevice;
                    lastTargetPort = targetPort;
                    lastLocalPort = hit;
                    lastTrace = lastTrace + " grace-skip rebuild";
                    return okJson(hit, targetPort, false);
                }
                rebuildDevice(device, targetDevice, relay, secret,
                        "probe-fail:" + hit + "->" + targetPort + " listener=" + listener);
                Integer again = FORWARDS.get(key(targetDevice, targetPort));
                if (again != null && PORT_OWNER.containsKey(again)) {
                    lastDevice = targetDevice;
                    return okJson(again, targetPort, true);
                }
                return err("重建后仍无可用口（" + lastErr + "）");
            }

            if (!VnetClient.ensureInit()) {
                return err("vnet 初始化失败");
            }
            // 身份必须先注入：对端启用 peer identity 时，未认证流一律被拒
            // （表现为"口能建、请求发出去没下文"）。幂等，重复调用无害。
            ensureIdentity();

            Integer clientPeer = DEVICE_CLIENT.get(targetDevice);
            lastTrace = "nohit target=" + targetDevice + " port=" + targetPort
                    + " wantLocal=" + wantLocal + " cp=" + clientPeer;
            boolean created = false;
            if (clientPeer == null) {
                Integer started = startClientFor(device, targetDevice, relay, secret);
                lastTrace = lastTrace + " start cp=" + started + " err=" + lastErr;
                if (started == null) {
                    return err("设备隧道建立失败 " + lastErr);
                }
                clientPeer = started;
                created = true;
            }

            int localPort = wantLocal > 0 ? wantLocal : allocPort();
            if (localPort <= 0) return err("本地口耗尽（" + PORT_BASE + "-" + PORT_MAX + " 全被占）");
            String owner = PORT_OWNER.get(localPort);
            if (owner != null && !owner.equals(key(targetDevice, targetPort))) {
                // 2026-11-13 陈旧期望淘汰（真机 RED：DESIRED 持久化把旧 15200→23912
                // 重放回来，占住固定口，新路由 24011→23912 被「自己人」挡路 →
                // ensure 报 unreachable 而隧道本身是活的）。同设备的旧目标占着
                // 本条要用的固定口 = 期望面已演进（老网关→新路由）→ 从 DESIRED
                // 删旧条目并整设备重建（连接级释放全部口，按新期望面重放），
                // 然后重挂本条。跨设备占用仍如实报错（不抢别人的口）。
                if (owner.startsWith(targetDevice + "|")) {
                    int staleTarget = -1;
                    try { staleTarget = Integer.parseInt(owner.substring(owner.indexOf('|') + 1)); } catch (Throwable ignored) { }
                    Map<Integer, Integer> want = DESIRED.get(targetDevice);
                    if (want != null && staleTarget > 0 && want.containsKey(staleTarget)) {
                        want.remove(staleTarget);
                        persistDesired();
                    }
                    android.util.Log.w("P2pDeviceTunnel",
                            "stale-port-owner " + owner + " 占 " + localPort + " → 淘汰并重建 " + targetDevice);
                    rebuildDevice(device, targetDevice, relay, secret, "stale-port-owner:" + owner);
                    Integer cpRe = DEVICE_CLIENT.get(targetDevice);
                    if (cpRe == null) {
                        return err("淘汰陈旧映射后重建失败 " + lastErr);
                    }
                    if (!armPort(cpRe, targetDevice, targetPort, localPort)) {
                        return err("淘汰后重挂失败 " + lastErr);
                    }
                    lastErr = "";
                    lastDevice = targetDevice;
                    lastTargetPort = targetPort;
                    lastLocalPort = localPort;
                    return okJson(localPort, targetPort, true);
                }
                return err("本地口 " + localPort + " 已被 " + owner + " 占用");
            }
            if (!armPort(clientPeer, targetDevice, targetPort, localPort)) {
                // 连接是本轮新建的且这条转发失败 → 没有可用转发就回收连接
                if (created && !FORWARDS.containsKey(key(targetDevice, targetPort))) {
                    try { VnetClient.stopClientPeer(clientPeer); } catch (Throwable ignored) { }
                    DEVICE_CLIENT.remove(targetDevice);
                }
                return err("转发口建立失败 " + lastErr);
            }
            lastErr = "";
            lastDevice = targetDevice;
            lastTargetPort = targetPort;
            lastLocalPort = localPort;
            android.util.Log.i("P2pDeviceTunnel", String.format(
                    "armed :%d -> %s:%d (peer 0x%08X, created=%s)",
                    localPort, targetDevice, targetPort, clientPeer, created));
            return okJson(localPort, targetPort, created);
        } catch (Exception e) {
            lastErr = String.valueOf(e);
            return err("参数错误：" + e.getMessage());
        }
    }

    /**
     * 身份自检（不负责注入）。
     *
     * 注入由 SPA 的 `vnet-identity.ts` 在启动时 + 每次 ensure 前调
     * `MycoShell.vnetSetLocalIdentity(did, seedB64)` 完成（seed 来自
     * `youling.vault.keyB64`，Java 侧没有也不该有第二份私钥）。这里只做提示：
     * 对端启用 peer identity 时，未注入身份的表现是"口能建、请求发出去没下文"，
     * 排障时一眼要能看到这一层。
     */
    private static void ensureIdentity() {
        try {
            if (!VnetClient.hasLocalIdentity()) {
                android.util.Log.w("P2pDeviceTunnel",
                        "vnet 设备身份尚未注入（SPA vnet-identity.ts 未跑？）——对端启用 peer identity 时会拒流");
            }
        } catch (Throwable ignored) { }
    }

    /** 状态快照（诊断）。多设备多端口全列出来（含期望面与重建计数）。 */
    public static synchronized String state() {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", !FORWARDS.isEmpty());
            o.put("forwards", new JSONObject(new HashMap<>(FORWARDS)));
            o.put("devices", DEVICE_CLIENT.size());
            o.put("rebuilds", rebuilds);
            o.put("lastRebuildReason", lastRebuildReason);
            o.put("lastRebuildAtMs", lastRebuildAtMs);
            o.put("lastReplay", lastReplay);
            o.put("lastTrace", lastTrace);
            JSONObject want = new JSONObject();
            for (Map.Entry<String, Map<Integer, Integer>> e : DESIRED.entrySet()) {
                JSONObject ports = new JSONObject();
                for (Map.Entry<Integer, Integer> p : e.getValue().entrySet()) {
                    ports.put(String.valueOf(p.getKey()), p.getValue());
                }
                want.put(e.getKey(), ports);
            }
            o.put("desired", want);
            o.put("lastDevice", lastDevice.isEmpty() ? "" : NativeRdpTunnel.shortDid(lastDevice));
            o.put("lastTargetPort", lastTargetPort);
            o.put("lastLocalPort", lastLocalPort);
            o.put("lastOkAtMs", lastOkAtMs);
            if (!lastErr.isEmpty()) o.put("lastErr", lastErr);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"err\":\"" + ForwardListener.esc(String.valueOf(e)) + "\"}";
        }
    }

    private static String err(String msg) {
        try {
            return new JSONObject().put("ok", false).put("err", msg).toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }
}
