package com.myco.phone;

/**
 * vnet 传输层 JNI 包装——生命周期管理 only（数据面走本地 TCP 回环）。
 *
 * 设计（vnet 会话 × DSH协议应用 2026-11-05 定版）：
 *   FFI 只管 init/start/stop/status；数据面不经过 JNI——
 *   WebView/RDP 客户端直接连 127.0.0.1:localPort，与 PC 同构。
 *
 * .so: jniLibs/arm64-v8a/libvnet.so（vnet 会话 aarch64-linux-android 构建）
 * FFI 签名: include/vnet_ffi.h（7 个 C 函数）
 */
public final class VnetClient {
    static {
        // 两个库都要装（APK 的 lib/arm64-v8a/ 下）：
        //  · libvnet.so     —— vnet 出的纯 C FFI（只导出 vnet_* C 符号）
        //  · libvnetjni.so  —— 宿主侧 JNI 垫片（导出 Java_com_myco_phone_VnetClient_*）
        // 2026-11-05 真机教训：vnet 的 .so 没有 JNI 名也没有 JNI_OnLoad，
        // 只 load libvnet 会 UnsatisfiedLinkError("No implementation found")。
        System.loadLibrary("vnet");
        System.loadLibrary("vnetjni");
    }

    // ── FFI 返回码（与 vnet_ffi.h 一致）──
    public static final int VNET_OK = 0;
    public static final int VNET_ERR_ARG = 1;
    public static final int VNET_ERR_RUNNING = 2;
    public static final int VNET_ERR_NOT_RUNNING = 3;
    public static final int VNET_ERR_INTERNAL = 4;
    public static final int VNET_ERR_BUFSMALL = 5;

    // ── Native 方法（签名与 C 完全对应）──
    public static native int vnet_init();
    public static native int vnet_client_start(
        String relay, int peerId, int targetPeerId, short localPort, String secret);
    public static native int vnet_client_stop();
    public static native int vnet_client_status(byte[] buf, int bufLen, int[] needed);
    public static native int vnet_client_stop_peer(int peerId);
    public static native int vnet_client_status_peer(int peerId, byte[] buf, int bufLen, int[] needed);
    public static native int vnet_server_start(
        String relay, int peerId, short targetPort, String secret);
    public static native int vnet_server_stop();
    public static native int vnet_set_peer_candidates(int peerId, String cand);

    // ── 便捷方法 ──

    private static boolean initialized = false;

    /** 幂等初始化（vnet_init 内部也是幂等的） */
    public static synchronized boolean ensureInit() {
        if (!initialized) {
            int rc = vnet_init();
            initialized = (rc == VNET_OK);
            if (!initialized) {
                android.util.Log.e("VnetClient", "vnet_init failed: " + rc);
            }
        }
        return initialized;
    }

    /**
     * 带重试+随机抖动的启动（2026-11-06 journal 判定：REGISTER 丢包为载波秒级瞬态窗，
     * 固定间隔重试会与运营商 QoS 周期相位锁定 → :tunnel 整晚 20+ 连败。jitter 破锁定，
     * RFC 8085 §5.1 同款思路）。最多 4 次，间隔 2-7s 随机。
     */
    public static int startClientRetry(String relay, int peerId, int targetPeerId, int localPort, String secret) {
        int rc = VNET_ERR_INTERNAL;
        java.util.Random rnd = new java.util.Random();
        for (int i = 1; i <= 4; i++) {
            rc = startClient(relay, peerId, targetPeerId, localPort, secret);
            if (rc == VNET_OK || rc == VNET_ERR_RUNNING) return rc;
            android.util.Log.w("VnetClient", "start retry " + i + "/4 rc=" + rc);
            if (i < 4) try { Thread.sleep(2000 + rnd.nextInt(5000)); } catch (InterruptedException ignored) { return rc; }
        }
        return rc;
    }

    /** 停指定实例（多实例 FFI：手机同时挂 RDP+DSH 时按 peerId 停单条）。 */
    public static int stopClientPeer(int peerId) {
        try {
            return vnet_client_stop_peer(peerId);
        } catch (Throwable t) {
            android.util.Log.e("VnetClient", "stop_peer: " + t);
            return VNET_ERR_INTERNAL;
        }
    }

    /** 查指定实例状态 JSON。 */
    public static String getStatusPeer(int peerId) {
        try {
            int[] needed = new int[1];
            vnet_client_status_peer(peerId, null, 0, needed);
            if (needed[0] <= 0 || needed[0] > 65536) return "{}";
            byte[] buf = new byte[needed[0]];
            int rc = vnet_client_status_peer(peerId, buf, buf.length, needed);
            if (rc == VNET_OK) return new String(buf, 0, buf.length - 1);
        } catch (Throwable t) {
            android.util.Log.e("VnetClient", "status_peer: " + t);
        }
        return "{}";
    }

    /**
     * 启动 vnet 客户端：本地代理监听 localPort。
     * 上层（WebView/RDP）直接连 127.0.0.1:localPort 即可。
     *
     * @param relay       中继地址（如 "myco.youling.cc:28322"）
     * @param peerId      本端 peer_id（DID 映射：SHA256("vnet-peer"||DID) 前28位 << 4 | slot）
     * @param targetPeerId 对端 peer_id
     * @param localPort   本地代理监听口（如 25390）
     * @param secret      PSK（空串 = 不加密）
     * @return 0=成功 | 2=已在运行 | 4=内部错误（含注册失败——看 logcat）
     */
    public static int startClient(String relay, int peerId, int targetPeerId, int localPort, String secret) {
        if (!ensureInit()) return VNET_ERR_INTERNAL;
        int rc = vnet_client_start(relay, peerId, targetPeerId, (short) localPort, secret);
        if (rc == VNET_OK) {
            android.util.Log.i("VnetClient",
                String.format("client started :%d → peer 0x%08X (relay=%s)", localPort, targetPeerId, relay));
        } else {
            android.util.Log.e("VnetClient",
                String.format("client start failed rc=%d (relay=%s peer=0x%08X)", rc, relay, targetPeerId));
        }
        return rc;
    }

    public static int stopClient() {
        int rc = vnet_client_stop();
        android.util.Log.i("VnetClient", "client stopped rc=" + rc);
        return rc;
    }

    /** 获取状态 JSON（path/p2p_peer/path_switches 等） */
    public static String getStatus() {
        // 先探测长度
        int[] needed = new int[1];
        vnet_client_status(null, 0, needed);
        if (needed[0] <= 0 || needed[0] > 65536) return "{}";
        byte[] buf = new byte[needed[0]];
        int rc = vnet_client_status(buf, buf.length, needed);
        if (rc == VNET_OK) {
            return new String(buf, 0, buf.length - 1); // strip NUL
        }
        return "{}";
    }

    /** 当前是否在运行（简化判断：status 返回非空即活着） */
    public static boolean isRunning() {
        String status = getStatus();
        return status != null && status.length() > 2 && status.contains("\"");
    }

    private VnetClient() {} // 工具类，不可实例化
}
