package com.myco.phone;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * RelayProvider — 手机在云中继注册 provider（2026-10-12「继续修复已知问题」：
 * PC→手机方向的聊天投递兜底）。
 *
 * 背景：手机异地（跨 v6 段）时直推/对账全断；手机→对端方向已由 TS 层的
 * wireChatRelayFallback 打通（手机当 consumer），反向 PC→手机需要手机在
 * 云中继注册 provider——裸 TCP 长连+心跳，浏览器 JS 做不了，落在这层。
 *
 * 协议（权威来源 services/identity-svc/relay.mjs）：
 *   → REGISTER &lt;deviceDid&gt;\n          ← OK\n（同 did 重注册踢旧连，last-wins）
 *   ← SESSION &lt;sessionId&gt;\n           （consumer 到访——在**新连接**上接单）
 *   → ACCEPT &lt;deviceDid&gt; &lt;sessionId&gt;\n（新连接发出后即纯字节管道）
 *   心跳：控制连每 30s 一个空行（中继 60s 无数据即断）。
 *
 * 接单后的管道去向：**泵到本机 TunnelProxyServer 端口**——PC 侧的隧道协议
 * 客户端（WS 升级 GET /p2p/tunnel + 加密握手）由现有 TS `acceptTunnel`
 * （p2p-tunnel.ts）应答，本层只搬字节（与 PC 侧隧道泵到 127.0.0.1:9100 同构）。
 *
 * 顶层类（R8 对内嵌类炸）；纯 Java 线程（KeepAliveService 已保进程优先级，
 * 前台服务在，本线程随进程活）。
 */
public class RelayProvider {
    // 2026-10-15 真案：30s 心跳在移动网被运营商 NAT ~15s 掐（服务器日志实测手机
    // did 每 ~16s 重注册一次=永远活不过一个心跳周期）。10s：远低于掐断线，对服务器
    // （60s 空闲阈值）也足够；流量 1 字节/10s 可忽略。
    private static final int HEARTBEAT_MS = 10_000;
    private static final int DIAL_TIMEOUT_MS = 8_000;
    /**
     * **定期换新注册**（2026-10-16 真案：PC→手机消息断了 14 分钟）。
     *
     * 为什么必须"到点换一个"，而不是"发现掉线再重连"：TCP 可能是**半开**的——
     * 运营商 NAT 悄悄丢掉映射后，本端读永远超时（被当成心跳拍）、写永远成功（进黑洞），
     * 客户端**没有任何办法知道自己已经掉线**。真机取证（中继侧 90 分钟轨迹）：
     *   · 手机 HTTP 轮询全程正常（进程活着、网络通）；
     *   · 而 provider 控制连平均只活几十秒~几分钟，且 16:22:40→16:36:53 **整整 14 分钟
     *     一次注册都没有**，期间 PC 想连手机一律 NOT_FOUND；
     *   · 那 14 分钟里手机侧一行日志都没有 = 它以为自己还连着。
     * 所以不做"猜活死"：到点主动换一条新注册（中继 last-wins，替换旧连），
     * 最坏黑洞窗口从"无限"收敛到 REREGISTER_MS。
     */
    private static final int REREGISTER_MS = 50_000;
    /** 「多久没进展就算卡住」——原生 tick（KeepAliveService，4s 一拍，不受冻结影响）
     *  据此强拆控制连，把卡在 read 上的线程叫醒重连。 */
    private static final int STALE_MS = 60_000;
    private static volatile Thread thread = null;
    // 2026-10-20 C 方案：原生侧“待处理字节 + JS 活性”信号（不依赖 WebView 回调）。
    // 入站中继字节到达但 JS 已停摆 > JS_STALL_MS 时，原生层直接发系统通知（冻结期间不静默）。
    private static volatile Context appCtx = null;
    private static volatile long lastJsAliveAt = 0;
    private static volatile long pendingTunnelBytes = 0;
    private static volatile long lastTunnelBytesAt = 0;
    private static volatile long lastNotifyAt = 0;
    private static final long JS_STALL_MS = 20_000;
    private static final long NOTIFY_THROTTLE_MS = 90_000;
    private static final String CHAT_CHANNEL = "myco_chat";
    private static int notifyId = 2000;
    private static volatile Socket ctrlSock = null;
    /** 最近一次"会话开始/注册成功"的时间（进展心跳，给原生 tick 判卡死用）。 */
    private static volatile long lastProgressAt = 0;
    /** 最近一次 **REGISTER 成功** 的时间——判"控制连半开"必须只看它（接单/会话活动不算注册活）。
     *  2026-10-20 R10 真案：手机日志 "relay-provider 卡住 663s" 才强拆；期间 PC 一直
     *  NOT_FOUND（relay 侧 provider 已掉）。原因就是 watchdog 读 lastProgressAt，
     *  被 inbound 会话活动刷新，永远不判卡。 */
    private static volatile long lastRegOkAt = 0;
    private static String host = RelayTunnel.DEFAULT_HOST;
    private static int port = RelayTunnel.DEFAULT_PORT;
    private static String deviceDid = "";
    private static int localPort = 0;

    /** 装配（JS 侧 main.tsx 启动时调）：MycoShell.relayProviderStart(json)。幂等。 */
    public static void configure(String h, int p, String did, int lp) {
        host = h; port = p; deviceDid = did; localPort = lp;
    }

    /** 最近装配的本机设备 did（2026-11-11：MycoShell.myDeviceDid() 的数据源——
     *  JS 身份 vault 没有 rootDid 字段，手机 DID 以 Java 侧装配记录为准）。 */
    public static String deviceDid() {
        return deviceDid == null ? "" : deviceDid;
    }

    /** 启动常驻注册循环（幂等；线程若已死会重开）。设备 did / 本地口未就绪时静默返回。 */
    public static void setContext(Context c) { appCtx = c == null ? null : c.getApplicationContext(); }

    /** KeepAliveService 的 evaluateJavascript 回执调用：JS 真的执行了。 */
    public static void markJsAlive() { lastJsAliveAt = System.currentTimeMillis(); }

    public static long jsIdleMs() {
        long t = lastJsAliveAt;
        return t <= 0 ? 0 : System.currentTimeMillis() - t;
    }
    public static long pendingTunnelBytes() { return pendingTunnelBytes; }
    public static long lastTunnelBytesAt() { return lastTunnelBytesAt; }

    public static void start() {
        if (deviceDid == null || deviceDid.length() < 8 || localPort <= 0) return;
        Thread cur = thread;
        if (cur != null && cur.isAlive()) return;
        if (lastJsAliveAt == 0) lastJsAliveAt = System.currentTimeMillis();
        Thread t = new Thread(new Runnable() { @Override public void run() { loop(); } }, "myco-relay-provider");
        t.setDaemon(true);
        thread = t;
        t.start();
    }

    /**
     * 原生 tick（KeepAliveService 每 4s 一次；**不依赖 WebView/JS**）调的保护网：
     *   ① 线程死了（异常逃逸/被回收）→ 重开；
     *   ② 90s 没有任何进展（卡在半开 read 上）→ 强拆控制连叫醒它，立刻重连。
     * 这是"后台冻结也不掉线"的兜底腿——与 2026-10-15 隧道 tick 同一条实测有效的通道。
     */
    public static void ensureAlive() {
        if (deviceDid == null || deviceDid.length() < 8 || localPort <= 0) return;
        Thread cur = thread;
        if (cur == null || !cur.isAlive()) { start(); return; }
        long last = lastRegOkAt > 0 ? lastRegOkAt : lastProgressAt;
        if (last > 0 && System.currentTimeMillis() - last > STALE_MS) {
            forceReconnect("stale-" + ((System.currentTimeMillis() - last) / 1000) + "s");
        }
    }

    /**
     * 网络切换/系统回调强制重连（2026-10-30 外部 WiFi 真案）。
     * 旧控制连在旧网络上可能半开；主动 close 唤醒 read，循环立刻重新 REGISTER。
     */
    public static void forceReconnect(String reason) {
        lastProgressAt = System.currentTimeMillis();
        Socket s = ctrlSock;
        GwLog.note(null, "relay-provider network-changed force-reconnect (" + reason + ")");
        if (s != null) {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    /** 永续循环：会话结束就重连（指数退避；活过 RESET_AFTER_MS 就重置退避）。 */
    private static void loop() {
        long backoff = 1000;
        while (true) {
            long t0 = System.currentTimeMillis();
            try {
                session();
                GwLog.note(null, "relay-provider 控制连结束，重连"); // ctx 可空：note 只用目录
            } catch (Exception e) {
                GwLog.note(null, "relay-provider 会话失败: " + e + "，" + backoff + "ms 后重试");
            }
            // 2026-10-16：重置门槛 60s→20s、退避上限 30s→15s。真机实测控制连频繁只活
            // 几十秒（网络/前缀在动），30s 退避意味着"每次抖动后 PC→手机有半分钟送不到"。
            if (System.currentTimeMillis() - t0 > 20_000) backoff = 1000;
            try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
            backoff = Math.min(backoff * 2, 15_000);
        }
    }

    /** 一条控制连的生命周期：REGISTER → OK → （心跳 ∥ 监听 SESSION 行）。 */
    private static void session() throws IOException {
        lastProgressAt = System.currentTimeMillis();
        Socket ctrl = dial();
        OutputStream os = ctrl.getOutputStream();
        InputStream is = ctrl.getInputStream();
        os.write(("REGISTER " + deviceDid + "\n").getBytes("UTF-8"));
        os.flush();
        String line = readLine(is);
        if (!"OK".equals(line)) {
            try { ctrl.close(); } catch (IOException ignored) { }
            throw new IOException("注册被拒: " + line);
        }
        ctrlSock = ctrl;
        long regAt = System.currentTimeMillis();
        lastProgressAt = regAt;
        lastRegOkAt = regAt;
        GwLog.note(null, "relay-provider 已注册（…" + tail4() + " @" + host + ":" + port + "）");
        try {
            ctrl.setSoTimeout(HEARTBEAT_MS); // 读超时≈心跳节拍：到点发心跳、有行即事件
            while (true) {
                String ev;
                try {
                    ev = readLine(is);
                } catch (java.net.SocketTimeoutException ste) {
                    ev = ""; // 心跳拍：空行
                }
                if (ev == null) throw new IOException("控制连被中继关闭");
                if (ev.isEmpty()) {
                    // 到点换新注册（半开黑洞的唯一解法；见 REREGISTER_MS 注释）
                    if (System.currentTimeMillis() - regAt > REREGISTER_MS) {
                        // 2026-10-18 零窗口换注册（task-7）：**先**在一条新连接上
                        // REGISTER 成功，**再**关旧连。中继是 last-wins——新注册一落，
                        // 服务端 entries[did] 立刻指向新连，旧连被服务端 destroy；
                        // 反过来（先关旧再重连，原实现）会留下 0.3-1s 的「无 provider」
                        // 窗口，落在这窗口里的 PC CONNECT 全拿 NOT_FOUND → 消息退回
                        // 离线队列等下一拍，P95 直接被这窗口抬到秒级。
                        Socket fresh = dial();
                        try {
                            fresh.setSoTimeout(30_000); // 防换注册黑洞时 readLine 永久阻塞（2026-10-20 R10）
                            OutputStream fos = fresh.getOutputStream();
                            InputStream fis = fresh.getInputStream();
                            fos.write(("REGISTER " + deviceDid + "\n").getBytes("UTF-8"));
                            fos.flush();
                            String l = readLine(fis);
                            if (!"OK".equals(l)) throw new IOException("换注册被拒: " + l);
                            Socket old = ctrl;
                            ctrl = fresh;
                            os = fos;
                            is = fis;
                            ctrlSock = fresh;
                            regAt = System.currentTimeMillis();
                            lastProgressAt = regAt;
                            lastRegOkAt = regAt;
                            fresh.setSoTimeout(HEARTBEAT_MS);
                            try { old.close(); } catch (IOException ignored) { }
                            GwLog.note(null, "relay-provider 已换新注册（…" + tail4() + "），旧连已关（零 NOT_FOUND 窗口）");
                            continue;
                        } catch (IOException e) {
                            try { fresh.close(); } catch (IOException ignored) { }
                            throw new IOException("定期换新注册失败（防 TCP 半开黑洞，已活 "
                                    + ((System.currentTimeMillis() - regAt) / 1000) + "s）：" + e.getMessage());
                        }
                    }
                    os.write("\n".getBytes("UTF-8")); os.flush(); continue;
                }
                if (ev.startsWith("SESSION ")) {
                    String sid = ev.substring("SESSION ".length()).trim();
                    acceptOrder(sid); // 新连接接单（慢操作——不占控制连）
                }
                // 其他行：忽略（协议演进余量）
            }
        } finally {
            if (ctrlSock == ctrl) ctrlSock = null;
            try { ctrl.close(); } catch (IOException ignored) { }
        }
    }

    /** 设备 did 尾 4 位（日志用）。 */
    private static String tail4() {
        String d = deviceDid == null ? "" : deviceDid;
        return d.length() <= 4 ? d : d.substring(d.length() - 4);
    }

    /**
     * 接一单：新连中继 → ACCEPT → **立即**纯字节管道 → 泵到本机 TunnelProxyServer。
     *
     * 2026-10-18 根修（任务 task-7「PC→手机没有任何可用投递腿」）：ACCEPT 之后
     * **中继不回任何应答行**——`services/identity-svc/relay.mjs` 的 ACCEPT 分支只给
     * consumer 写 `OK\n`，provider 这条连接在 ACCEPT 行之后**立刻成为纯字节管道**
     * （协议权威注释：「发完即成纯字节管道」）。原实现多读了一行「OK」，吃掉的正是
     * consumer 在收到配对 OK 后立刻发来的隧道首包 `GET /p2p/tunnel?v=2` →
     * 永远 `ACCEPT 被拒` → 关连接 → consumer（PC）侧只能看到
     * `WebSocket protocol error: Handshake not finished`，PC→手机每条消息都退化成
     * 等手机对账轮询（真机 M3 P50=16s/P95=20s）。
     * 现在：发完 ACCEPT 直接 pump，一个字节都不预读（与 PC 侧 provider
     * `p2p_tunnel::relay_provider_accept` 的「发完 ACCEPT 即 copy_bidirectional」同构）。
     * 中继在无对应等待会话时会直接 destroy 这条连接——pump 的本地口连接随后
     * 自然断开，flush 失败即收工（不需要提前探活）。
     */
    private static void acceptOrder(final String sid) {
        Thread t = new Thread(new Runnable() {
            @Override public void run() {
                try {
                    final Socket s = dial();
                    try {
                        OutputStream os = s.getOutputStream();
                        os.write(("ACCEPT " + deviceDid + " " + sid + "\n").getBytes("UTF-8"));
                        os.flush();
                        GwLog.note(null, "relay-provider 接单泵起（" + sid + " → 本地 :" + localPort + "）");
                        pump(s);
                    } finally {
                        try { s.close(); } catch (IOException ignored) { }
                    }
                } catch (Exception e) {
                    GwLog.note(null, "relay-provider 接单失败: " + e);
                }
            }
        }, "myco-relay-accept");
        t.setDaemon(true);
        t.start();
    }

    /** 双向泵：中继管道 ↔ 本机 TunnelProxyServer（一方断即双双收工）。 */
    private static void pump(Socket pipe) {
        Socket up = null;
        try {
            up = new Socket();
            up.setTcpNoDelay(true);
            up.connect(new InetSocketAddress("127.0.0.1", localPort), 3000);
        } catch (Exception e) {
            GwLog.note(null, "relay-provider 本地口不可达：" + e);
            try { pipe.close(); } catch (IOException ignored) { }
            return;
        }
        final Socket p = pipe, u = up;
        Thread a = new Thread(new Runnable() { @Override public void run() { copyThenClose(p, u, true); } }, "rp-pump-a");
        Thread b = new Thread(new Runnable() { @Override public void run() { copyThenClose(u, p, false); } }, "rp-pump-b");
        a.setDaemon(true); b.setDaemon(true);
        a.start(); b.start();
        // 2026-10-18 根修（task-7 真机）：**必须等两个泵线程收工再返回**。
        // pump 原本 fire-and-forget，`acceptOrder` 的 finally 会紧接着 close(pipe)
        // ——刚配好对的中继连接被本端立刻关掉，consumer（PC）只能看到
        // `WebSocket protocol error: Handshake not finished`，手机 bridge 连
        // 一次入站都收不到（真机现象：日志全是「接单泵起」但 bridge 计数全 0）。
        try { a.join(); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
        try { b.join(); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
    }

    private static void copyThenClose(Socket from, Socket to, boolean inbound) {
        try {
            byte[] buf = new byte[8192];
            InputStream is = from.getInputStream();
            OutputStream os = to.getOutputStream();
            int n;
            while ((n = is.read(buf)) > 0) {
                os.write(buf, 0, n);
                if (inbound && n > 0) noteInboundBytes(n);
            }
        } catch (Exception ignored) {
        } finally {
            try { from.close(); } catch (IOException ignored) { }
            try { to.close(); } catch (IOException ignored) { }
        }
    }

    /** 入站字节计数 + 冻结停摆判定（C 方案核心）：JS 停摆超过阈值 → 原生发系统通知。 */
    private static void noteInboundBytes(int n) {
        pendingTunnelBytes += n;
        lastTunnelBytesAt = System.currentTimeMillis();
        if (jsIdleMs() > JS_STALL_MS) notifyPendingIfNeeded();
    }

    private static void notifyPendingIfNeeded() {
        long now = System.currentTimeMillis();
        if (now - lastNotifyAt < NOTIFY_THROTTLE_MS) return;
        lastNotifyAt = now;
        GwLog.note(null, "relay-pending bytes=" + pendingTunnelBytes + " jsIdleMs=" + jsIdleMs()
                + " lastTunnelBytesAtMs=" + lastTunnelBytesAt);
        Context ctx = appCtx;
        if (ctx == null) return;
        try {
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHAT_CHANNEL) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHAT_CHANNEL, "聊天消息", NotificationManager.IMPORTANCE_HIGH));
            }
            Intent it = new Intent(ctx, MainActivity.class);
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) piFlags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(ctx, 0, it, piFlags);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(ctx, CHAT_CHANNEL)
                    : new Notification.Builder(ctx);
            b.setContentTitle("myco 有新消息")
                    .setContentText("App 在后台被冻结期间收到消息，点开查看")
                    .setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setAutoCancel(true)
                    .setContentIntent(pi);
            nm.notify(notifyId++, b.build());
            GwLog.note(null, "relay-pending-notify shown（原生层，未依赖 WebView）");
        } catch (Throwable e) {
            GwLog.note(null, "relay-pending-notify 失败: " + e);
        }
    }

    private static Socket dial() throws IOException {
        Socket s = new Socket();
        s.setTcpNoDelay(true);
        s.connect(new InetSocketAddress(host, port), DIAL_TIMEOUT_MS);
        return s;
    }

    /** 读一行（字节级——绝不消费 '\n' 之后的数据；ASCII 短行）。 */
    private static String readLine(InputStream is) throws IOException {
        StringBuilder sb = new StringBuilder();
        while (true) {
            int b = is.read();
            if (b < 0) return null;
            if (b == '\n') return sb.toString().trim();
            sb.append((char) b);
            if (sb.length() > 128) throw new IOException("中继行超长");
        }
    }
}
