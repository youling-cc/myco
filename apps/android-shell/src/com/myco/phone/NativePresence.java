package com.myco.phone;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * NativePresence — :tunnel 进程自己的在线心跳。
 *
 * 旧链路的 presence 由 WebView JS 周期上报；手机退后台/锁屏后 JS 停摆，
 * 云名册就把手机判离线，哪怕原生 RDP/DSH listener 仍在。这里复用 arm 注入的
 * **成员设备 seed** 做 Ed25519 签名，不读、不导出、不接触账号根种子。
 *
 * 协议与 phone/src/identity.ts registerPresence 一致：
 *   POST /presence/register
 *   X-Myco-Auth: <deviceDid>.<tsMs>.<base64(Ed25519(deviceDid\nts\nbody))>
 * 仅 loopback 成员设备 arm 成功后启动；disarmAll/退出/服务销毁即停止。
 */
public final class NativePresence {
    private static final String ENDPOINT = "https://myco.youling.cc/myco-id/presence/register";
    private static final long PERIOD_MS = 20_000;
    private static final long OK_LOG_MS = 5 * 60_000;
    private static final long ERR_LOG_MS = 60_000;

    private static final Object LOCK = new Object();
    private static long epoch = 0;
    private static Thread worker;
    private static String account = "";
    private static String device = "";
    private static byte[] seed;
    private static long lastOkLogAt = 0;
    private static long lastErrLogAt = 0;

    private NativePresence() { }

    /** arm/restore 成功后调用；同账号同设备幂等，换身份时旧循环自动退出。 */
    public static void ensureFromJson(String armJson) {
        if (armJson == null || armJson.isEmpty()) return;
        try {
            org.json.JSONObject o = new org.json.JSONObject(armJson);
            String acc = o.optString("account", "");
            String dev = o.optString("device", "");
            String seedB64 = o.optString("seedB64", "");
            if (seedB64.isEmpty()) seedB64 = o.optString("seed", "");
            if (acc.isEmpty() || dev.isEmpty() || seedB64.isEmpty()) return;
            byte[] s = TunnelCrypto.unb64(seedB64);
            if (s.length != 32) return;
            synchronized (LOCK) {
                if (worker != null && worker.isAlive()
                        && acc.equals(account) && dev.equals(device)) return;
                epoch++;
                final long myEpoch = epoch;
                account = acc;
                device = dev;
                seed = s;
                Thread t = new Thread(new Runnable() {
                    @Override public void run() { loop(myEpoch); }
                }, "myco-native-presence");
                t.setDaemon(true);
                worker = t;
                t.start();
            }
        } catch (Throwable e) {
            GwLog.note(null, "native-presence arm 配置无效（不启动）: " + e.getClass().getSimpleName());
        }
    }

    /** 全部 disarm / 注销 / 服务销毁时调用；不发送旧身份的新心跳。 */
    public static void stop() {
        synchronized (LOCK) {
            epoch++;
            account = "";
            device = "";
            seed = null;
            if (worker != null) worker.interrupt();
            worker = null;
        }
    }

    private static void loop(long myEpoch) {
        while (true) {
            String acc;
            String dev;
            byte[] s;
            synchronized (LOCK) {
                if (myEpoch != epoch) return;
                acc = account;
                dev = device;
                s = seed == null ? null : seed.clone();
            }
            if (acc.isEmpty() || dev.isEmpty() || s == null) return;
            try {
                int status = postOnce(acc, dev, s);
                long now = System.currentTimeMillis();
                if (status >= 200 && status < 300) {
                    if (now - lastOkLogAt > OK_LOG_MS) {
                        lastOkLogAt = now;
                        GwLog.note(null, "native-presence 在线心跳成功（成员设备）");
                    }
                } else if (now - lastErrLogAt > ERR_LOG_MS) {
                    lastErrLogAt = now;
                    GwLog.note(null, "native-presence 心跳 HTTP " + status);
                }
            } catch (Throwable e) {
                long now = System.currentTimeMillis();
                if (now - lastErrLogAt > ERR_LOG_MS) {
                    lastErrLogAt = now;
                    GwLog.note(null, "native-presence 心跳失败（下拍自动重试）: " + e.getClass().getSimpleName());
                }
            }
            long until = System.currentTimeMillis() + PERIOD_MS;
            while (System.currentTimeMillis() < until) {
                synchronized (LOCK) {
                    if (myEpoch != epoch) return;
                }
                try { Thread.sleep(250); } catch (InterruptedException e) { return; }
            }
        }
    }

    private static int postOnce(String acc, String dev, byte[] s) throws Exception {
        byte[] pub = Ed25519.publicKey(s);
        StringBuilder node = new StringBuilder(pub.length * 2);
        for (byte b : pub) node.append(String.format("%02x", b & 0xff));
        String body = "{"
                + "\"nodeId\":" + TunnelCrypto.jsonStr(node.toString())
                + ",\"name\":\"myco-phone\""
                + ",\"rootDid\":" + TunnelCrypto.jsonStr(acc)
                + ",\"role\":\"appendage\",\"kind\":\"phone\",\"state\":\"active\""
                + "}";
        long ts = System.currentTimeMillis();
        byte[] msg = (dev + "\n" + ts + "\n" + body).getBytes(StandardCharsets.UTF_8);
        String auth = dev + "." + ts + "." + TunnelCrypto.b64(Ed25519.sign(s, msg));
        HttpURLConnection c = (HttpURLConnection) new URL(ENDPOINT).openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("X-Myco-Auth", auth);
        byte[] raw = body.getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(raw.length);
        OutputStream os = c.getOutputStream();
        os.write(raw);
        os.flush();
        os.close();
        int status = c.getResponseCode();
        try { c.getInputStream().close(); } catch (Throwable ignored) { }
        c.disconnect();
        return status;
    }
}
