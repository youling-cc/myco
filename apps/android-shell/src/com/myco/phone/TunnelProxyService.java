package com.myco.phone;

import java.util.concurrent.ConcurrentHashMap;

/**
 * TunnelProxyService — 手机侧「点卡就进」的**原生长驻面**（单例）。
 *
 * 三块能力，对应 JS 侧 `native-proxy.ts` 的三个桥方法组：
 *   ① 本地监听（`TunnelProxyServer`）：给 WebView 一个 `127.0.0.1:<随机端口>`
 *      的入口，端口随用随开、关页面即释放；
 *   ② 带自定义头的 WS（`TunnelWs`）：浏览器 WebSocket 不能设 `x-myco-tunnel` /
 *      `x-myco-auth`，只能原生代开；二进制 payload 原样过桥；
 *   ③ 新 WebView（`ShareWebActivity`）：分享页在**独立 Activity** 里打开，
 *      myco 主界面（持有隧道客户端的那个 WebView）保持存活——
 *      否则一导航就把 JS 隧道客户端连同隧道一起销毁了。
 *
 * 线程：桥方法在 WebView 的 JavaBridge 线程上被调；本类内部只做 map 操作 + socket
 * 读写，不碰 UI（UI 相关的调用都经 `TunnelJs` 转到 UI 线程）。
 */
public class TunnelProxyService implements TunnelWs.Sink {
    private static volatile TunnelProxyService INSTANCE;
    /** 2026-10-12：app context 静态持有（TunnelProxyServer 的端口记忆文件需要，
     *  而它拿不到 Activity——这是进程级文件路径，不含 UI 引用，无泄漏）。 */
    private static volatile android.content.Context APP_CTX;

    private final MainActivity act;
    private final TunnelJs js;
    private final TunnelProxyServer proxy;
    private final ConcurrentHashMap<String, TunnelWs> wss = new ConcurrentHashMap<String, TunnelWs>();
    /** 2026-10-22 入向 vnet 隧道：隧道明文 ↔ 127.0.0.1:<port>（WebView JS 开不了 socket）。 */
    private final TcpDialer dialer;

    private TunnelProxyService(MainActivity a) {
        this.act = a;
        APP_CTX = a.getApplicationContext();
        // 2026-10-12：预置 GwLog 目录缓存——否则 native 侧首条 note(null,…)（端口
        // 复用失败告警）因缓存空被静默丢弃（真机排障实测吃了这个亏）。
        GwLog.note(APP_CTX, "tunnel-proxy 服务就绪（日志目录已就位）");
        this.js = new TunnelJs(a);
        this.proxy = new TunnelProxyServer(js);
        this.dialer = new TcpDialer(js);
    }

    /** 端口记忆文件用的进程级 context（未初始化 → null，调用方静默跳过）。 */
    static android.content.Context appContext() { return APP_CTX; }

    public static TunnelProxyService get(MainActivity a) {
        TunnelProxyService s = INSTANCE;
        if (s == null) {
            synchronized (TunnelProxyService.class) {
                s = INSTANCE;
                if (s == null) {
                    s = new TunnelProxyService(a);
                    INSTANCE = s;
                }
            }
        }
        return s;
    }

    // ══════════════ ① 本地监听 ══════════════

    /** `MycoShell.tunnelStart()`：起本地监听，返回 `{"ok":true,"port":N}` / `{"ok":false,"err":"人话"}`。 */
    public String start() {
        try {
            int p = proxy.start();
            return "{\"ok\":true,\"port\":" + p + "}";
        } catch (Exception e) {
            return "{\"ok\":false,\"err\":\"" + EnvServer.esc(human(e)) + "\"}";
        }
    }

    /** `MycoShell.tunnelStop()`。 */
    public void stop() {
        proxy.stop();
        for (String id : new java.util.ArrayList<String>(wss.keySet())) {
            TunnelWs ws = wss.remove(id);
            if (ws != null) ws.close(1000, "app-stop");
        }
    }

    /** `MycoShell.tunnelSend(connId, b64)`：把对端明文写回浏览器。 */
    public void sendLocal(int connId, String b64) {
        try {
            proxy.write(connId, android.util.Base64.decode(b64, android.util.Base64.DEFAULT));
        } catch (Exception ignored) { }
    }

    /** `MycoShell.tunnelClose(connId, why)`。 */
    public void closeLocal(int connId, String why) {
        proxy.closeConn(connId, why == null ? "" : why);
    }

    // ══════════════ ② 带自定义头的 WS ══════════════

    /**
     * `MycoShell.tunnelOpenWs(wsId, url, headersJson)`。
     * 连接是**异步**的（不能阻塞 bridge 线程）：立即返回 ""，结果经
     * `js.wsOpened(wsId, err)` 回；失败时 err 是人话。
     */
    public String openWs(final String wsId, final String url, final String headersJson) {
        if (wsId == null || wsId.isEmpty() || url == null || url.isEmpty()) return "ERR:连接参数不对";
        Thread t = new Thread(new TunnelWsOpen(this, wsId, url, headersJson), "myco-tunnel-open-" + wsId);
        t.setDaemon(true);
        t.start();
        return "";
    }

    /** 连接线程体（由 TunnelWsOpen 调）。 */
    void openWsBlocking(String wsId, String url, String headersJson) {
        try {
            GwLog.note(null, "ws-open begin id=" + wsId + " url=" + url);
            java.util.Map<String, String> headers = parseHeaders(headersJson);
            TunnelWs ws = TunnelWs.connect(wsId, url, headers, this);
            wss.put(wsId, ws);
            ws.start();
            GwLog.note(null, "ws-open upgraded id=" + wsId);
            js.wsOpened(wsId, "");
        } catch (Exception e) {
            GwLog.note(null, "ws-open error id=" + wsId + " " + human(e));
            js.wsOpened(wsId, human(e));
        }
    }

    /** `MycoShell.tunnelWsSend(wsId, b64)`。 */
    public void wsSend(String wsId, String b64) {
        TunnelWs ws = wss.get(wsId);
        if (ws == null) return;
        try {
            ws.sendBinary(android.util.Base64.decode(b64, android.util.Base64.DEFAULT));
        } catch (Exception e) {
            ws.hardClose(1006, human(e));
        }
    }

    /** `MycoShell.tunnelWsClose(wsId, code, reason)`。 */
    public void wsClose(String wsId, int code, String reason) {
        TunnelWs ws = wss.remove(wsId);
        if (ws != null) ws.close(code <= 0 ? 1000 : code, reason);
    }

    // ══════════════ ④ 入向 vnet 隧道拨号（2026-10-22）══════════════

    /** `MycoShell.tcpDial(port)`：拨 127.0.0.1:<port>（白名单内），返回 `{"ok":true,"connId":N}`。 */
    public String dialTcp(int port) { return dialer.dial(port); }

    /** `MycoShell.tcpSend(connId, b64)`：隧道明文 → 本地 socket。 */
    public void dialSend(int connId, String b64) { dialer.send(connId, b64); }

    /** `MycoShell.tcpClose(connId)`：关本地 socket。 */
    public void dialClose(int connId) { dialer.close(connId); }

    // ══════════════ ②' 云端中继（relay:// 腿的后端） ══════════════

    /**
     * `MycoShell.relayPredial(addr)`：中继 TCP 预连池补池（深 2 / TTL 8s，见
     * RelayTunnel）。开卡前 JS 先热池——真要用 CONNECT 时从池里拎一条现成的，
     * 省 1×公网 RTT。addr 形如 "myco.youling.cc:8321"；空串用默认。
     */
    public String relayPredial(String addr) {
        try {
            String[] hp = RelayTunnel.parseAddr(addr);
            RelayTunnel.refill(hp[0], Integer.parseInt(hp[1]));
            return "OK";
        } catch (Exception e) {
            return "ERR:" + human(e);
        }
    }

    // ══════════════ ③ 新 WebView 打开分享页 ══════════════

    /** `MycoShell.openShareWeb(url, title)`：在独立 Activity 里打开（不影响主 WebView）。 */
    public String openShareWeb(String url, String title) {
        try {
            android.content.Intent i = new android.content.Intent(act, ShareWebActivity.class);
            i.putExtra("url", url);
            i.putExtra("title", title == null ? "任务" : title);
            act.startActivity(i);
            return "OK";
        } catch (Exception e) {
            return "ERR:" + human(e);
        }
    }

    // ══════════════ TunnelWs.Sink ══════════════

    @Override public void onOpen(TunnelWs ws) { /* 由 openWsBlocking 直接回调 JS */ }

    @Override public void onBinary(TunnelWs ws, byte[] payload) {
        js.wsData(ws.id, payload);
    }

    @Override public void onClosed(TunnelWs ws, int code, String reason) {
        wss.remove(ws.id);
        js.wsClosed(ws.id, code, reason);
    }

    // ══════════════ 诊断 ══════════════

    public String snapshot() {
        return proxy.snapshot() + " wss=" + wss.size()
                + " relayPool=" + RelayTunnel.poolAlive() + "/" + RelayTunnel.poolDepth();
    }

    // ══════════════ 工具 ══════════════

    /** 极简 JSON 对象 → Map（只支持 `{"k":"v",...}`；桥上的头值都是字符串）。 */
    static java.util.Map<String, String> parseHeaders(String json) {
        java.util.HashMap<String, String> out = new java.util.HashMap<String, String>();
        if (json == null || json.isEmpty()) return out;
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"((?:[^\"\\\\]|\\\\.)*)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        while (m.find()) {
            out.put(unesc(m.group(1)), unesc(m.group(2)));
        }
        return out;
    }

    private static String unesc(String s) {
        return s.replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
                .replace("\\\"", "\"").replace("\\\\", "\\");
    }

    /** 异常 → 人话（**不吐 socket/TCP/端口/隧道**这类词给用户看）。 */
    static String human(Exception e) {
        String m = e == null ? "" : String.valueOf(e.getMessage());
        if (m.contains("Connection refused") || m.contains("ECONNREFUSED")) {
            return "对方设备没有响应（可能刚离线）";
        }
        if (m.contains("timeout") || m.contains("超时")) return "连接对方设备超时";
        if (m.contains("Unable to resolve host") || m.contains("UnknownHost")) {
            return "找不到对方设备的地址";
        }
        if (m.contains("Network is unreachable") || m.contains("No route")) {
            return "当前网络到不了对方设备";
        }
        if (m.isEmpty()) return "连接对方设备失败";
        return m;
    }
}
