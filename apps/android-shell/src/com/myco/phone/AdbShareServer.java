package com.myco.phone;

import org.json.JSONObject;

/**
 * AdbShareServer — 手机「ADB 调试」分享的 vnet server（2026-11-11）。
 *
 * 需求：youling-myco apps/vnet/docs/ADB-SHARE-TASK.md——手机当 <b>server</b>，
 * libvnet 的 vnet_server_start 把隧道来的连接转发到 127.0.0.1:5555（Android
 * ADB TCP，开发者选项开启）。调试者（PC）零改动消费：POST /api/vnet/forward
 * {device:手机did, port:5555} 起的 vnet client 按同一 peer_id 公式找到本机
 * server → adb connect 127.0.0.1:&lt;本地口&gt;。
 *
 * peer_id 契约（与 PC vnet_forward.rs / 本工程 {@link VnetTransport#serverPeerId}
 * 同源）：SHA256("vnet-peer"||设备did||":server:"||5555) 低 32 位——公式错了
 * PC 的 client 就找不到这台 server，所以必须在同一处实现里取。
 *
 * 安全（需求文档 §安全模型，四层防护）：vnet 传输 PSK（AES-256-GCM）+ vnet
 * 身份闸门（Ed25519 AUTH + DID 验证，libvnet 内置）+ ADB 自身 RSA 认证 +
 * 分享卡 TTL/撤销（关 server = 闸门随进程消亡立即断开）。
 *
 * 进程模型：跑在主进程（KeepAliveService 前台服务保进程；与 :tunnel 进程里的
 * client 实例互不干扰——libvnet 状态按进程隔离）。会话期持 PARTIAL_WAKE_LOCK
 *（2026-11-06 灭屏真案同款：Doze 会掐 keepalive/UDP 收发），stop 释放。
 */
public final class AdbShareServer {

    /** Android ADB TCP 端口（adbd 监听口；需求文档 §与现有分享系统的关系）。 */
    public static final int DEFAULT_TARGET_PORT = 5555;

    private static volatile boolean running = false;
    private static volatile int targetPort = 0;
    private static volatile long startedAtMs = 0;
    private static volatile String deviceDid = "";
    private static volatile String lastErr = "";
    private static volatile android.os.PowerManager.WakeLock wakeLock;

    private AdbShareServer() {}

    /**
     * 启动 vnet server。json：{device:本机设备did, targetPort:5555,
     * relay?:host:port, secret?:PSK}（relay/secret 缺省用 {@link VnetTransport}
     * 的默认值——与 PC 侧 MYCO_VNET_RELAY/MYCO_VNET_SECRET 一致）。
     * 返回 {"ok":bool,"running":bool,"peerId":"0x…","targetPort":n,"err":"人话"}。
     *
     * ⚠️ vnet_server_start 是**阻塞** FFI（vnet_ffi.h：「宿主须自行 spawn 线程
     * 调用」；注册/主循环在函数体内）——绝不能在 JS bridge 线程直接调（0.3.200
     * 真机事故：桥线程被卡死，EnvServer eval 全部超时）。这里起专用守护线程，
     * 桥线程最多等 1.2s：线程仍活 = 注册/服务进行中（按 ok 返回，state 里
     * starting=true）；rc 及时返回则按结果回。
     */
    public static synchronized String start(String json, android.content.Context ctx) {
        try {
            JSONObject o = new JSONObject(json == null ? "" : json);
            final String did = o.optString("device", "").trim();
            if (did.isEmpty()) {
                return err("缺少本机设备 did（身份未就绪？稍后再试）");
            }
            final int port = o.optInt("targetPort", DEFAULT_TARGET_PORT);
            if (port <= 0 || port > 65535) {
                return err("targetPort 非法 " + port);
            }
            String relayStr = o.optString("relay", "").trim();
            if (relayStr.isEmpty()) relayStr = VnetTransport.DEFAULT_RELAY;
            String secretStr = o.optString("secret", "");
            if (secretStr.isEmpty()) secretStr = VnetTransport.DEFAULT_SECRET;
            final String relay = relayStr;
            final String secret = secretStr;

            if (!VnetClient.ensureInit()) {
                return err("vnet 初始化失败（libvnet.so 加载异常）");
            }
            // 2026-11-12 vnet e99e2158：手机 JNI 宿主没有 set_peer_resolver，身份闸门
            // fail-closed 会把所有带 AUTH 的对端流按 UnknownKey 拒掉（AUTH_REQUIRED
            // 优雅关流——真机 03:5x ADB 黑洞根因）。本 server 显式降级为 PSK-only
            // 网络准入（AUTH 变 advisory 不验签）；PSK 是账号设备群共享密钥，网络层
            // 仍非公开。默认严格模式不变，仅本 server opt-in。
            try {
                int grc = VnetClient.vnet_set_gate_psk_only();
                if (grc != VnetClient.VNET_OK) {
                    return err("vnet PSK-only 闸门设置失败 rc=" + grc);
                }
            } catch (Throwable tr) {
                return err("vnet_set_gate_psk_only 异常: " + tr);
            }
            final int peerId = VnetTransport.serverPeerId(did, port);

            // 灭屏死亡后的僵尸对象防御（2026-11-06 VnetTransport.arm 同款真案）：
            // 先停旧线程/旧实例再重建（run 标志 + server_stop 双保险）。
            stopServerThreadLocked(ctx);

            final long startedAt = System.currentTimeMillis();
            startedAtMs = startedAt;
            targetPort = port;
            deviceDid = did;
            lastErr = "";
            final Object done = new Object();
            final int[] rcBox = new int[]{-1};
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    int rc;
                    try {
                        rc = VnetClient.vnet_server_start(relay, peerId, (short) port, secret);
                    } catch (Throwable tr) {
                        lastErr = "vnet_server_start 异常 why=" + tr + " / " + VnetClient.lastError();
                        rc = -2;
                    }
                    synchronized (done) {
                        rcBox[0] = rc;
                        if (rc != VnetClient.VNET_OK) {
                            // 函数返回且非 0 = server 已退出（注册失败/被停）。
                            running = false;
                        }
                        done.notifyAll();
                    }
                }
            }, "myco-adb-vnet-server");
            t.setDaemon(true);
            serverThread = t;
            t.start();
            synchronized (done) {
                try {
                    done.wait(1200);
                } catch (InterruptedException ignored) {
                }
            }
            if (rcBox[0] == -1) {
                // 1.2s 内没返回 = server 在跑（注册/服务循环在专用线程里）。
                running = true;
                holdWakeLock(ctx);
                GwLog.note(ctx, "adb-share server 启动中(线程存活) :5555 peer=0x"
                        + Integer.toHexString(peerId) + " relay=" + relay);
                return new JSONObject()
                        .put("ok", true)
                        .put("running", true)
                        .put("starting", true)
                        .put("peerId", String.format("0x%08X", peerId))
                        .put("targetPort", port)
                        .toString();
            }
            int rc = rcBox[0];
            if (rc == VnetClient.VNET_OK || rc == VnetClient.VNET_ERR_RUNNING) {
                running = true;
                holdWakeLock(ctx);
                GwLog.note(ctx, "adb-share server 就绪 :5555 peer=0x"
                        + Integer.toHexString(peerId) + " rc=" + rc);
                return new JSONObject()
                        .put("ok", true)
                        .put("running", true)
                        .put("peerId", String.format("0x%08X", peerId))
                        .put("targetPort", port)
                        .toString();
            }
            lastErr = "vnet_server_start rc=" + rc + " why=" + VnetClient.lastError();
            running = false;
            return err("ADB 服务启动失败（rc=" + rc + " why=" + VnetClient.lastError() + "）");
        } catch (Exception e) {
            lastErr = String.valueOf(e);
            return err("参数错误：" + e.getMessage());
        }
    }

    /** server 专用线程句柄（stop 用：run 标志由 vnet_server_stop 置位）。 */
    private static volatile Thread serverThread;

    /** 停旧 server 线程/实例（持锁调用）。
     *  ⚠️ 纪律：**不 join**——vnet_server_start 是阻塞 FFI，旧线程可能正卡在
     *  relay 注册退避（最长 ~30s），join 会把调用方（bridge 线程）一起拖死。
     *  这里只置停止标志（vnet_server_stop：run=false，瞬时）+ interrupt 兜底，
     *  线程残骸自行退出，绝不等待。与 P2pSyncTunnel"单次尝试不重试"同款纪律。 */
    private static void stopServerThreadLocked(android.content.Context ctx) {
        try {
            VnetClient.vnet_server_stop();
        } catch (Throwable ignored) {
        }
        Thread t = serverThread;
        serverThread = null;
        if (t != null) {
            try { t.interrupt(); } catch (Throwable ignored) { }
        }
        running = false;
    }

    /** 停止 vnet server（撤销分享：闸门随 server 消亡立即断开所有 ADB 连接）。 */
    public static synchronized String stop(android.content.Context ctx) {
        try {
            VnetClient.vnet_server_stop();
        } catch (Throwable ignored) {
        }
        boolean was = running;
        running = false;
        releaseWakeLock();
        if (was) GwLog.note(ctx, "adb-share server 已停止（ADB 授权随断）");
        return "{\"ok\":true,\"running\":false}";
    }

    /** 状态快照（AdbShareCard 5s 轮询）。 */
    public static String state() {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", running);
            o.put("running", running);
            o.put("targetPort", targetPort);
            o.put("startedAtMs", startedAtMs);
            if (!deviceDid.isEmpty()) o.put("device", NativeRdpTunnel.shortDid(deviceDid));
            if (!lastErr.isEmpty()) o.put("lastErr", lastErr);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"err\":\"" + ForwardListener.esc(String.valueOf(e)) + "\"}";
        }
    }

    public static boolean isRunning() {
        return running;
    }

    private static String err(String msg) {
        try {
            return new JSONObject().put("ok", false).put("err", msg).toString();
        } catch (Exception e) {
            return "{\"ok\":false}";
        }
    }

    // ── WakeLock：vnet 会话期保 CPU（2026-11-06 灭屏真案：深睡掐 keepalive/UDP）──

    private static void holdWakeLock(android.content.Context ctx) {
        try {
            if (wakeLock != null && wakeLock.isHeld()) return;
            if (ctx == null) return;
            android.os.PowerManager pm =
                    (android.os.PowerManager) ctx.getSystemService(android.content.Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "myco:vnet:adb5555");
            wakeLock.acquire();
            android.util.Log.i("AdbShareServer", "wake lock held (adb vnet server)");
        } catch (Throwable t) {
            android.util.Log.e("AdbShareServer", "wake lock: " + t);
        }
    }

    private static void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                android.util.Log.i("AdbShareServer", "wake lock released");
            }
        } catch (Throwable ignored) {
        } finally {
            wakeLock = null;
        }
    }
}
