package com.myco.phone;

import org.json.JSONObject;

/**
 * VnetTransport — 手机端 vnet 传输层的数据面接管（2026-11-05，目标②「本地回环模式」）。
 *
 * 设计（与 PC 侧 myco 完全同构）：
 *  - PC 上 myco 已为 13911/3389 各跑一个 vnet server（`MYCO_TUNNEL_TRANSPORT=vnet`）。
 *  - 手机这边只要 {@link VnetClient#startClient} 把 **同一个本地口** 交给 libvnet，
 *    RDP/DSH 客户端照旧连 127.0.0.1:23389 —— 字节直接进 .so，经 UDP（P2P 优先/中继兜底）
 *    到 PC，不再走 JS→WS 或 NativeRdpTunnel 的 Java 加密泵。
 *  - 默认关：不开 {@link #setEnabled} 或 arm JSON 不带 vnetTransport:true 时，行为与现在
 *    完全一致（ForwardListener + NativeRdpTunnel）。开了以后失败也回落老路径，绝不白屏。
 *
 * peer_id 必须与 PC 侧 Rust 同源（vnet_forward.rs）：
 *   server = SHA256("vnet-peer"||targetDid||":server:"||targetPort) 前 4 字节大端 u32
 *   client = SHA256("vnet-peer"||localDid||"#client#"||targetDid||":port:"||localPort) 前 4 字节大端
 * （2026-11-05 起 slot 语义废弃：中继默认不校验派生，归属表防抢占。）
 */
public final class VnetTransport {
    private static final String TAG = "VnetTransport";

    /** 默认中继（与 PC 侧 MYCO_VNET_RELAY 一致；arm JSON 可用 vnetRelay 覆盖）。 */
    public static final String DEFAULT_RELAY = "myco.youling.cc:28322";
    /** 默认 PSK（与 PC 侧 MYCO_VNET_SECRET 一致）。 */
    public static final String DEFAULT_SECRET = "acc-test";

    /**
     * 默认开（2026-11-05 用户定调：默认都走 vnet，legacy 只做失败回落——
     * "用老模式跑没有测试意义"）。失败路径已内置：vnet 起不来/`.so` 缺失时
     * handleArm 自动回落 ForwardListener+NativeRdpTunnel，用户无感。
     */
    private static volatile boolean enabled = true;
    private static volatile boolean available = true;
    private static volatile String lastArm = null;

    // ── 开关 ──────────────────────────────────────────────

    public static boolean isEnabled() {
        return enabled && available;
    }

    /** 运行时开关（EnvServer "vnet" 动作调用；开关不触碰隧道，arm/disarm 才碰）。 */
    public static void setEnabled(boolean on) {
        enabled = on;
        android.util.Log.i(TAG, "transport " + (on ? "vnet" : "legacy"));
        if (!on) disarm();
    }

    // ── peer_id（与 myco apps/home vnet_forward.rs 同源）────

    static int peerIdFor(String seed) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(seed.getBytes("UTF-8"));
            return ((d[0] & 0xFF) << 24) | ((d[1] & 0xFF) << 16) | ((d[2] & 0xFF) << 8) | (d[3] & 0xFF);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    /** PC 侧被连端口的 vnet server peer_id。 */
    public static int serverPeerId(String targetDid, int targetPort) {
        return peerIdFor("vnet-peer" + targetDid + ":server:" + targetPort);
    }

    /**
     * 设备级 multi-forward server 的 peer_id（与 PC `vnet_forward.rs::multi_server_peer_id_for`
     * 同式）。2026-11-11 真机定界：myco 现役 `MYCO_VNET_MULTI_FORWARD=1` 配置下对端**只**
     * 起这一条 server，逐端口 server（`:server:9100`）根本不启动——用逐端口 id 连过去会
     * `[A_lookup_peer] no_answer`，静默预算耗尽后流被关（手机上表现为 10s 读超时或
     * "unexpected end of stream"）。所以凡是对端设备，一律走这个设备级 id + add_forward。
     */
    public static int multiServerPeerId(String targetDid) {
        return peerIdFor("vnet-peer" + targetDid + ":server:multi-forward-v1");
    }

    /** 手机自己作为客户端的 peer_id（掺入目标与本地口，保证不与任何服务端 id 撞）。 */
    public static int clientPeerId(String localDid, String targetDid, int localPort) {
        return peerIdFor("vnet-peer" + localDid + "#client#" + targetDid + ":port:" + localPort);
    }

    // ── arm / disarm ─────────────────────────────────────

    /**
     * 用 arm JSON（与 NativeRdpTunnel.arm 同一份）启动 vnet 数据面。
     * 成功后本地口归 libvnet 所有，调用方应跳过 ForwardListener.start。
     * 返回 JSON：{"ok":true,"transport":"vnet",...} / {"ok":false,"err":"..."}（此时回落 legacy）。
     */
    public static String arm(String armJson, android.content.Context ctx) {
        if (!isEnabled()) return "{\"ok\":false,\"err\":\"disabled\"}";
        try {
            JSONObject o = new JSONObject(armJson);
            int localPort = o.optInt("localPort", 0);
            int targetPort = o.optInt("targetPort", 0);
            String targetDevice = o.optString("targetDevice", "").trim();
            String device = o.optString("device", "").trim();
            if (localPort <= 0 || targetPort <= 0 || targetDevice.isEmpty() || device.isEmpty()) {
                return "{\"ok\":false,\"err\":\"arm JSON 缺 localPort/targetPort/device\"}";
            }
            String relay = o.optString("vnetRelay", DEFAULT_RELAY).trim();
            if (relay.isEmpty()) relay = DEFAULT_RELAY;
            String secret = o.optString("vnetSecret", DEFAULT_SECRET);

            int serverPeer = serverPeerId(targetDevice, targetPort);
            int clientPeer = clientPeerId(device, targetDevice, localPort);

            // 2026-11-06 灭屏真案：vnet 客户端在灭屏期间死掉（keepalive 断/冻结）后
            // **对象仍在**（rc=2 已在运行），re-arm 时被当成"还活着"跳过——死连接
            // 永不重建（唤醒后 RDP 仍断）。修：显式 arm 一律先清旧实例，宁可重建
            // 一次注册（~百 ms），不留僵尸。
            try {
                int src = VnetClient.stopClientPeer(clientPeer);
                if (src == VnetClient.VNET_OK) {
                    android.util.Log.i(TAG, "arm: cleared stale client 0x" + Integer.toHexString(clientPeer));
                }
            } catch (Throwable ignored) {
            }

            int rc = VnetClient.startClientRetry(relay, clientPeer, serverPeer, localPort, secret);
            if (rc == VnetClient.VNET_OK || rc == VnetClient.VNET_ERR_RUNNING) {
                lastArm = armJson;
                holdWakeLock(ctx, localPort);
                android.util.Log.i(TAG, String.format(
                        "arm :%d → %s:%d server=0x%08X client=0x%08X relay=%s",
                        localPort, targetDevice, targetPort, serverPeer, clientPeer, relay));
                return new JSONObject()
                        .put("ok", true)
                        .put("transport", "vnet")
                        .put("localPort", localPort)
                        .put("targetPort", targetPort)
                        .put("serverPeer", String.format("0x%08X", serverPeer))
                        .toString();
            }
            return new JSONObject().put("ok", false)
                    .put("err", "vnet_client_start rc=" + rc).toString();
        } catch (Throwable t) {
            // .so 缺失 / JNI 签名不匹配等：标不可用，永久回落 legacy（不再反复炸）。
            available = false;
            android.util.Log.e(TAG, "arm 失败并标记不可用: " + t);
            return "{\"ok\":false,\"err\":\"" + ForwardListener.esc(String.valueOf(t)) + "\"}";
        }
    }

    /** 停 vnet 数据面（本地口释放，ForwardListener 可重新接管）。
     *  2026-11-06 issue005：probe 起的实例没有 lastArm，旧 disarm 停不掉它——
     *  probe 会持续占口干扰 :tunnel 的真实 arm。现在 off 时全部停（vnet_client_stop
     *  语义=停全部实例），arm 管的实例靠下次 arm 重建。 */
    public static void disarm() {
        try {
            VnetClient.stopClient();
            android.util.Log.i(TAG, "disarm ok (all instances)");
        } catch (Throwable t) {
            android.util.Log.e(TAG, "disarm: " + t);
        } finally {
            lastArm = null;
            releaseWakeLock();
        }
    }

    // ── WakeLock：灭屏保活 ──────────────────────────────────────
    // 2026-11-06 灭屏真案：arm 后 40s 还能通、3 分钟死——不是进程被杀（:tunnel
    // 前台服务活着），是 CPU 深睡/Doze 掐断了 keepalive 与 UDP 收发。vnet 会话
    // 存续期间持 PARTIAL_WAKE_LOCK（只保 CPU，不点亮屏幕），disarm 释放。
    private static android.os.PowerManager.WakeLock wakeLock;

    private static void holdWakeLock(android.content.Context ctx, int localPort) {
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;
            if (ctx == null) return;
            android.os.PowerManager pm =
                    (android.os.PowerManager) ctx.getSystemService(android.content.Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK,
                    "myco:vnet:" + localPort);
            wakeLock.acquire();
            android.util.Log.i(TAG, "wake lock held (vnet session : " + localPort + ")");
        } catch (Throwable t) {
            android.util.Log.e(TAG, "wake lock: " + t);
        }
    }

    private static void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                android.util.Log.i(TAG, "wake lock released");
            }
        } catch (Throwable ignored) {
        } finally {
            wakeLock = null;
        }
    }

    /** vnet 状态（path=p2p-v4/v6 / relay 等），验收直连用。 */
    public static String status() {
        String s;
        try {
            s = VnetClient.getStatus();
        } catch (Throwable t) {
            s = "{\"ok\":false,\"err\":\"" + ForwardListener.esc(String.valueOf(t)) + "\"}";
        }
        return "{\"enabled\":" + isEnabled() + ",\"vnet\":" + s + "}";
    }

    /**
     * 调试探开（不开全局开关）：直接按 (target,targetPort,localPort) 起 vnet 客户端。
     * 验收用 —— PC 侧可 `adb forward tcp:localPort tcp:localPort` 后对 127.0.0.1:localPort
     * 发 RDP X.224 / HTTP，整条数据面（手机 libvnet → PC vnet server → PC 真实端口）可测。
     */
    public static String probe(String targetDid, int targetPort, int localPort, String localDidHint) {
        try {
            String localDid = (localDidHint == null || localDidHint.isEmpty())
                    ? "phone-probe" : localDidHint;
            int serverPeer = serverPeerId(targetDid, targetPort);
            int clientPeer = clientPeerId(localDid, targetDid, localPort);
            // probe 同样先清旧实例（灭屏死亡后的僵尸客户端会让 rc=2 假成功）
            try { VnetClient.stopClientPeer(clientPeer); } catch (Throwable ignored) { }
            int rc = VnetClient.startClientRetry(DEFAULT_RELAY, clientPeer, serverPeer, localPort, DEFAULT_SECRET);
            android.util.Log.i(TAG, String.format(
                    "probe :%d → %s:%d server=0x%08X client=0x%08X rc=%d",
                    localPort, targetDid, targetPort, serverPeer, clientPeer, rc));
            return new JSONObject()
                    .put("ok", rc == VnetClient.VNET_OK || rc == VnetClient.VNET_ERR_RUNNING)
                    .put("rc", rc)
                    .put("serverPeer", String.format("0x%08X", serverPeer))
                    .put("clientPeer", String.format("0x%08X", clientPeer))
                    .put("localPort", localPort)
                    .put("status", VnetClient.getStatusPeer(clientPeer))
                    .toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"err\":\"" + ForwardListener.esc(String.valueOf(t)) + "\"}";
        }
    }

    private VnetTransport() {}
}
