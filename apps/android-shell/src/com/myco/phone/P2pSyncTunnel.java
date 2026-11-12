package com.myco.phone;

import org.json.JSONObject;

import java.util.HashMap;
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
 *   · 每个要用的对端端口（9100 对账 / 13911 分享网关 / 3389 RDP）用
 *     `vnet_client_add_forward` 追加一条本地回环口。
 *
 * ## 为什么不再"单隧道、换目标先停旧实例"
 * 旧实现（同日早些时候）为省端口把隧道做成单实例，换目标就停旧的。实测两个后果：
 *   ① 两台设备（PC + 笔记本）交替对账时互相拆台，两边的 ensure 都失败；
 *   ② 承接 DSH/RDP 的第二个端口无处可放。
 * 现在按 **device** 一条连接、按 **(device,targetPort)** 一条转发，本地口由本类
 * 从 {@link #PORT_BASE} 起自动分配，调用方不需要自己算。
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

    /** deviceDid → 该设备的 multi-forward client peer_id。 */
    private static final Map<String, Integer> DEVICE_CLIENT = new HashMap<>();
    /** "deviceDid|targetPort" → 本地回环口（已 armed）。 */
    private static final Map<String, Integer> FORWARDS = new HashMap<>();
    /** 本地回环口 → "deviceDid|targetPort"（反向占用表，防两个组合抢同一口）。 */
    private static final Map<Integer, String> PORT_OWNER = new HashMap<>();

    private static volatile String lastErr = "";
    private static volatile long lastOkAtMs = 0;
    private static volatile String lastDevice = "";
    private static volatile int lastTargetPort = 0;
    private static volatile int lastLocalPort = 0;

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

    /** 清掉该设备的全部转发映射与客户端连接（探活失败时用；其他端口的转发
     *  挂在同一条客户端连接上——连接死则全死，各自在下次 ensure 时懒重建）。 */
    private static void evictDevice(String device) {
        Integer cp = DEVICE_CLIENT.remove(device);
        if (cp != null) {
            try { VnetClient.stopClientPeer(cp); } catch (Throwable ignored) { }
        }
        java.util.Iterator<Map.Entry<String, Integer>> it = FORWARDS.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Integer> e = it.next();
            if (e.getKey().startsWith(device + "|")) {
                PORT_OWNER.remove(e.getValue());
                it.remove();
            }
        }
    }

    /** 分配一个没被占用的本地口（从 PORT_BASE 起顺序找）。 */
    private static int allocPort() {
        for (int p = PORT_BASE; p <= PORT_MAX; p++) {
            if (!PORT_OWNER.containsKey(p)) return p;
        }
        return 0;
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

            // 已 armed 且端口仍在占用表里 → **先验活**再幂等返回（2026-11-12 白屏实案：
            // vnet 客户端连接死亡后 FORWARDS/PORT_OWNER 仍留旧口，上层拿到死口开分享页
            // = WebView 白屏。探活失败 → 清掉该设备全部映射并走重建，绝不返回死口。）
            Integer hit = FORWARDS.get(key(targetDevice, targetPort));
            if (hit != null && PORT_OWNER.containsKey(hit)) {
                if (probeLocal(hit)) {
                    lastDevice = targetDevice;
                    lastTargetPort = targetPort;
                    lastLocalPort = hit;
                    return new JSONObject()
                            .put("ok", true).put("localPort", hit)
                            .put("targetPort", targetPort).put("multi", true)
                            .put("created", false).toString();
                }
                android.util.Log.w("P2pDeviceTunnel",
                        "stale forward :" + hit + " -> " + targetDevice + ":" + targetPort
                                + " (listener dead) — evicting device maps, re-arming");
                evictDevice(targetDevice);
                // 不 return：落到下方重建路径
            }

            if (!VnetClient.ensureInit()) {
                return err("vnet 初始化失败");
            }
            // 身份必须先注入：对端启用 peer identity 时，未认证流一律被拒
            // （表现为"口能建、请求发出去没下文"）。幂等，重复调用无害。
            ensureIdentity();

            Integer clientPeer = DEVICE_CLIENT.get(targetDevice);
            boolean created = false;
            if (clientPeer == null) {
                int cp = VnetTransport.clientPeerId(device, targetDevice, 0);
                int multiServer = VnetTransport.multiServerPeerId(targetDevice);
                try { VnetClient.stopClientPeer(cp); } catch (Throwable ignored) { }
                int rc = VnetClient.vnet_client_start_multi(relay, cp, multiServer, secret);
                if (rc != VnetClient.VNET_OK && rc != VnetClient.VNET_ERR_RUNNING) {
                    String why = VnetClient.lastError();
                    lastErr = "vnet_client_start_multi rc=" + rc + " why=" + why;
                    return err("设备隧道建立失败 rc=" + rc + " why=" + why);
                }
                DEVICE_CLIENT.put(targetDevice, cp);
                clientPeer = cp;
                created = true;
            }

            int localPort = wantLocal > 0 ? wantLocal : allocPort();
            if (localPort <= 0) return err("本地口耗尽（25910-25999 全被占）");
            String owner = PORT_OWNER.get(localPort);
            if (owner != null && !owner.equals(key(targetDevice, targetPort))) {
                return err("本地口 " + localPort + " 已被 " + owner + " 占用");
            }
            int rcFwd = VnetClient.vnet_client_add_forward(clientPeer, (short) localPort, (short) targetPort);
            if (rcFwd != VnetClient.VNET_OK) {
                String why = VnetClient.lastError();
                lastErr = "add_forward rc=" + rcFwd + " why=" + why;
                // 连接是本轮新建的且这条转发失败 → 没有可用转发就回收连接
                if (created && !FORWARDS.containsKey(key(targetDevice, targetPort))) {
                    try { VnetClient.stopClientPeer(clientPeer); } catch (Throwable ignored) { }
                    DEVICE_CLIENT.remove(targetDevice);
                }
                return err("转发口建立失败 rc=" + rcFwd + " why=" + why);
            }
            FORWARDS.put(key(targetDevice, targetPort), localPort);
            PORT_OWNER.put(localPort, key(targetDevice, targetPort));
            lastErr = "";
            lastOkAtMs = System.currentTimeMillis();
            lastDevice = targetDevice;
            lastTargetPort = targetPort;
            lastLocalPort = localPort;
            android.util.Log.i("P2pDeviceTunnel", String.format(
                    "armed :%d -> %s:%d (peer 0x%08X, created=%s)",
                    localPort, targetDevice, targetPort, clientPeer, created));
            return new JSONObject()
                    .put("ok", true).put("localPort", localPort)
                    .put("targetPort", targetPort).put("multi", true)
                    .put("created", created).toString();
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

    /** 状态快照（诊断）。多设备多端口全列出来。 */
    public static synchronized String state() {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", !FORWARDS.isEmpty());
            o.put("forwards", new JSONObject(new HashMap<>(FORWARDS)));
            o.put("devices", DEVICE_CLIENT.size());
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
