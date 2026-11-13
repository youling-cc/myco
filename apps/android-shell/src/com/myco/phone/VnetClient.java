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
        // 2026-11-12 RDP 缓解（vnet 域定案）：ARQ 重传预算耗尽会连坐关整条
        // Connection（per-stream 预算是架构级 follow-up）。手机侧是 client 端——
        // 发数据收不到 ACK 的正是我们，所以预算必须在本进程上调。libvnet 在
        // 首次取预算时读 env，这里必须在任何 vnet_* 调用前设好（static 块即最早点）。
        // 60s：瞬时抖动（<60s）不再杀流，真断连仍会显式失败（诚实）。
        try {
            if (System.getenv("VNET_RETRY_BUDGET_MS") == null) {
                android.system.Os.setenv("VNET_RETRY_BUDGET_MS", "60000", false);
            }
        } catch (Throwable ignored) { }
        // 2026-11-12 连接秒死案诊断旋钮（vnet 域方案 ①②）——都可用文件开关热切，
        // 不用重编：MainActivity.onCreate 在本类加载前调用 applyEnvToggles(ctx)。
        //  · VNET_STATUS_DIR → libvnet 状态文件落 app files dir（默认 temp_dir 在
        //    Android 无处可读=观测盲区）
        //  · VNET_NO_P2P=1 → 强制 relay，隔离「WiFi 省电拆 IPv6」假设
        //  · VNET_DEBUG_TRACE=1 → vnet 侧 verbose（.so 支持时）
        // 两个库都要装（APK 的 lib/arm64-v8a/ 下）：
        //  · libvnet.so     —— vnet 出的纯 C FFI（只导出 vnet_* C 符号）
        //  · libvnetjni.so  —— 宿主侧 JNI 垫片（导出 Java_com_myco_phone_VnetClient_*）
        // 2026-11-05 真机教训：vnet 的 .so 没有 JNI 名也没有 JNI_OnLoad，
        // 只 load libvnet 会 UnsatisfiedLinkError("No implementation found")。
        System.loadLibrary("vnet");
        System.loadLibrary("vnetjni");
    }

    /** 诊断旋钮（文件开关热切，须在任何 vnet_* 调用前调用——MainActivity.onCreate）：
     *  files/vnet-no-p2p 存在 → VNET_NO_P2P=1（强制 relay）
     *  files/vnet-debug 存在 → VNET_DEBUG_TRACE=1
     *  VNET_STATUS_DIR 恒指 files/vnet-status/（vnet .so 支持该 env 时生效）。 */
    public static void applyEnvToggles(android.content.Context ctx) {
        try {
            java.io.File files = ctx.getFilesDir();
            // VNET_STATUS_DIR 指外部 files 目录（adb 可直接 cat——内部 /data/data
            // 非 debuggable 包读不了，14:2x 实测盲区没解除就是这个）。
            java.io.File ext = ctx.getExternalFilesDir(null);
            java.io.File statusDir = new java.io.File(ext != null ? ext : files, "vnet-status");
            if (!statusDir.exists()) { statusDir.mkdirs(); }
            android.system.Os.setenv("VNET_STATUS_DIR", statusDir.getAbsolutePath(), false);
            if (new java.io.File(files, "vnet-no-p2p").exists()) {
                android.system.Os.setenv("VNET_NO_P2P", "1", false);
                android.util.Log.w("VnetClient", "诊断模式：VNET_NO_P2P=1（强制 relay）");
            }
            if (new java.io.File(files, "vnet-debug").exists()) {
                android.system.Os.setenv("VNET_DEBUG_TRACE", "1", false);
            }
        } catch (Throwable ignored) { }
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
    /** 2026-11-11：最近一次 start 失败原因（NUL 结尾 UTF-8 写入 buf；0=OK）。 */
    public static native int vnet_last_error(byte[] buf, int bufLen);
    /** 2026-11-11：注入本机设备身份（seed 为 32 字节 hex），此后每条流带 AUTH。 */
    public static native int vnet_set_local_identity(String did, String seedHex);
    /** 1=身份已注入。 */
    public static native int vnet_has_local_identity();
    /** 2026-11-11：multi-forward 客户端（对端是设备级 server，一条连接多个 target）。 */
    public static native int vnet_client_start_multi(
        String relay, int peerId, int targetPeerId, String secret);
    /** 给 multi 客户端追加转发（本地口 → 对端 target 口）。 */
    public static native int vnet_client_add_forward(int peerId, short localPort, short targetPort);
    /** 2026-11-12（vnet e99e2158）：server 闸门降级为 PSK-only 网络准入（AUTH 变
     * advisory 不验签）。给无 set_peer_resolver 的 JNI 宿主（AdbShareServer）用；
     * 默认严格模式不变，仅显式 opt-in。 */
    public static native int vnet_set_gate_psk_only();

    // ── 便捷方法 ──

    /**
     * 注入设备身份（seed 传 **base64**，与 `youling.vault.keyB64` 同形）。
     *
     * 为什么必须有：PC 侧 `MYCO_PEER_IDENTITY=1` 后，入站未认证的 vnet 流一律
     * `AUTH_REQUIRED` 拒绝。手机只起 client 不注身份时——本地回环口能建、握手能
     * 成、请求字节发出去就再无下文（宿主看到的只是 10s 读超时或
     * "unexpected end of stream"），这是「手机→PC 数据面不通」的最后一层。
     *
     * 边界：私钥只在内存里交给 libvnet，不落盘、不打日志。
     */
    public static int setLocalIdentityB64(String did, String seedB64) {
        if (did == null || did.isEmpty() || seedB64 == null || seedB64.isEmpty()) {
            return VNET_ERR_ARG;
        }
        if (!ensureInit()) return VNET_ERR_INTERNAL;
        try {
            byte[] seed = android.util.Base64.decode(seedB64, android.util.Base64.DEFAULT);
            if (seed == null || seed.length != 32) {
                android.util.Log.e("VnetClient", "device seed 长度不是 32B: " + (seed == null ? -1 : seed.length));
                return VNET_ERR_ARG;
            }
            StringBuilder hex = new StringBuilder(64);
            for (byte b : seed) hex.append(String.format("%02x", b));
            int rc = vnet_set_local_identity(did, hex.toString());
            android.util.Log.i("VnetClient", "local identity rc=" + rc + " did=…" + NativeRdpTunnel.shortDid(did));
            return rc;
        } catch (Throwable t) {
            android.util.Log.e("VnetClient", "setLocalIdentityB64 failed: " + t);
            return VNET_ERR_INTERNAL;
        }
    }

    public static boolean hasLocalIdentity() {
        try {
            return vnet_has_local_identity() == 1;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 最近一次 vnet start 失败的人读原因。
     * 2026-11-11 真案：Android 上 Rust 的 eprintln 进 /dev/null，宿主只看到裸
     * rc=4（VNET_ERR_INTERNAL），"隧道建立失败 rc=4"查了一整晚才定位到 peer_id
     * 泄漏与 relay 注册退避。排障必须能拿到这句原因。
     */
    public static String lastError() {
        try {
            byte[] buf = new byte[1024];
            int rc = vnet_last_error(buf, buf.length);
            if (rc != VNET_OK) return "";
            int n = 0;
            while (n < buf.length && buf[n] != 0) n++;
            return new String(buf, 0, n, "UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

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
            // 2026-11-11：裸 rc 码在 Android 上没法排障（Rust eprintln 被丢弃），
            // 必须把 native 侧记下的原因一起打出来。
            android.util.Log.e("VnetClient",
                String.format("client start failed rc=%d (relay=%s peer=0x%08X) why=%s",
                    rc, relay, targetPeerId, lastError()));
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
