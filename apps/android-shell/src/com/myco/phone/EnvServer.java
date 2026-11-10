package com.myco.phone;

import java.io.IOException;
import java.net.ServerSocket;
import java.util.concurrent.atomic.AtomicReference;

/**
 * EnvServer — app 的环境交互面(aop 思路:状态可感知+可执行,调试不再靠改代码重装)。
 *  感知 GET  /api/state  → 当前视图/选中会话/节点/错误/连接状态
 *  执行 POST /api/intent  → {act:"tap_xy"|"inject"|"reload"|"snap"|"eval", ...}
 *  CLI  POST /api/cli     → {cmd:"identity did"}——三端一致命令词表(2026-09-23,
 *        对齐 myco-ubuntu/PC cli.rs):identity/sign/device/delegation,无 UI 全功能。
 *  常驻线程服务;主线程只做 UI。端口 :8210。
 */
public class EnvServer {
    private static final int PORT = 8210;
    private final MainActivity act;
    private ServerSocket ss;
    private Thread th;
    /** 最近一次外部 intent 的回执(调试循环里一看便知效果)。 */
    private final AtomicReference<String> lastResult = new AtomicReference<>("");

    public EnvServer(MainActivity a) { act = a; }

    public void start() {
        try {
            // 绑回环（2026-09-10 D70 安全根修：曾绑默认 :: 全网卡——同 WiFi 任何设备
            // 可 POST tap_xy/inject/reload 控制手机（局域网直连+注入执行四步实锤）。
            // 回环=仅本机可达，PC 调试走 adb forward tcp:8210 不受影响。
            ss = new ServerSocket(PORT, 8, java.net.InetAddress.getByName("127.0.0.1"));
            th = new Thread(new EnvLoop(this, ss), "myco-env-http");
            th.setDaemon(true);
            th.start();
        } catch (IOException ignored) { }
    }

    /** 感知快照(不含密钥——状态面只读状态,不读身份)。
     *  2026-09-04 修:原先 runOnUiThread+等 2s——UI 线程一忙(页面切换/JS 重活)
     *  /api/state 全挂,调试面整晚反复失联。WebView.getUrl/getTitle 实测线程安全
     *  (MycoShell.selfReport 同款),直接读不再依赖 UI 线程。 */
    /** 2026-10-22 手机侧日志通道：JS 经 POST /api/intent {act:"note"} 写入，
     *  /api/state 的 notes 字段读回。荣耀等设备 logcat 是加密的（HKS），
     *  WebView console 根本读不到——这是唯一可靠的远程排障通道。 */
    private static final java.util.ArrayDeque<String> NOTES = new java.util.ArrayDeque<>();
    private static final int NOTES_MAX = 40;

    static void note(String t) {
        // 2026-10-23 修复（发版阻塞项，jsNote 卡死）：时间戳在锁外构造——
        // 原 SimpleDateFormat 每次 new 且放在 NOTES 锁内，HTTP 读线程(stateJson)与
        // UI/桥线程(note)长时间争锁，存在卡死窗口。现用 String.format（线程安全、无共享
        // 状态），临界区只剩 addLast/trim（微秒级）。JS 写入通道见 /api/intent act=note。
        String line = "[" + String.format(java.util.Locale.US, "%tT", new java.util.Date()) + "] " + t;
        synchronized (NOTES) {
            NOTES.addLast(line);
            while (NOTES.size() > NOTES_MAX) NOTES.removeFirst();
        }
    }

    public String stateJson() {
        MainActivity a = act;
        // 读 PageSeen 维护的字段(WebView getter 非主线程返回 null——实测回归)
        String url = a.lastUrl == null ? "" : a.lastUrl;
        String title = a.lastTitle == null ? "" : a.lastTitle;
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"data\":{");
        sb.append("\"url\":\"").append(esc(url)).append("\",");
        sb.append("\"title\":\"").append(esc(title)).append("\",");
        sb.append("\"activity\":\"").append(a.getClass().getSimpleName()).append("\",");
        sb.append("\"keepAlive\":\"").append(a.keepAliveState()).append("\",");
        sb.append("\"lastResult\":\"").append(esc(lastResult.get())).append("\",");
        sb.append("\"version\":\"").append(esc(a.versionName())).append("\",");
        sb.append("\"notes\":[");
        synchronized (NOTES) {
            boolean first = true;
            for (String n : NOTES) {
                if (!first) sb.append(',');
                first = false;
                sb.append('"').append(esc(n)).append('"');
            }
        }
        sb.append("]");
        sb.append("}}");
        return sb.toString();
    }

    /** 执行意图(POST JSON {act, ...})。 */
    public String intent(String body) {
        String actType = jstr(body, "act");
        if (actType == null) return "{\"ok\":false,\"err\":\"need act\"}";
        MainActivity a = act;
        if ("vnet".equals(actType)) {
            // 2026-11-05 目标②调试口：运行时切换 vnet/legacy 数据面（默认 legacy）。
            // {"act":"vnet"} → 只读状态；{"act":"vnet","on":true} → 开并把已保存的
            // RDP/DSH arm 记录重放一遍（handleArm 会按当前开关选 vnet 或 legacy）。
            // {"act":"vnet","probe":true,"target":"did:myco:…","targetPort":3389,"localPort":25390}
            //   → 不动全局开关，直接起一条 vnet 客户端（验收数据面用）。
            Boolean on = jbool(body, "on");
            if (on != null) {
                VnetTransport.setEnabled(on);
                if (on) {
                    try {
                        java.util.Map<Integer, String> saved = TunnelArmStore.loadAll(act);
                        for (java.util.Map.Entry<Integer, String> e : saved.entrySet()) {
                            android.content.Intent it = new android.content.Intent(act, TunnelProcessService.class);
                            it.setAction(TunnelProcessService.ACTION_ARM);
                            it.putExtra(TunnelProcessService.EXTRA_ARM_JSON, e.getValue());
                            act.startService(it);
                        }
                        lastResult.set("vnet on, re-arm " + saved.size());
                    } catch (Throwable t) {
                        lastResult.set("vnet re-arm err " + t);
                    }
                }
            }
            if (jbool(body, "probe") != null && jbool(body, "probe")) {
                String target = jstr(body, "target");
                int tport = jint(body, "targetPort", 3389);
                int lport = jint(body, "localPort", 25390);
                if (target == null) return "{\"ok\":false,\"err\":\"probe need target\"}";
                String pr = VnetTransport.probe(target, tport, lport, jstr(body, "device"));
                lastResult.set("vnet probe " + pr);
                return pr;
            }
            String status = VnetTransport.status();
            lastResult.set("vnet " + status);
            return status;
        }
        if ("tap_xy".equals(actType)) {
            final int x = jint(body, "x", 0), y = jint(body, "y", 0);
            a.runOnUiThread(new UiRun(a, 0, x, y, null, null));
            lastResult.set("tap_xy " + x + "," + y);
            return "{\"ok\":true}";
        }
        if ("note".equals(actType)) {
            String t = jstr(body, "text");
            if (t == null) return "{\"ok\":false,\"err\":\"need text\"}";
            note(t);
            return "{\"ok\":true}";
        }
        if ("inject".equals(actType)) {
            final String js = jstr(body, "js");
            if (js == null) return "{\"ok\":false,\"err\":\"need js\"}";
            a.runOnUiThread(new UiRun(a, 1, 0, 0, js, null));
            lastResult.set("inject " + js.substring(0, Math.min(80, js.length())));
            return "{\"ok\":true}";
        }
        if ("reload".equals(actType)) {
            a.runOnUiThread(new UiRun(a, 2, 0, 0, null, null));
            lastResult.set("reload");
            return "{\"ok\":true}";
        }
        if ("snap".equals(actType)) {
            final String[] p = { null };
            a.runOnUiThread(new UiRun(a, 3, 0, 0, null, p));
            for (int i = 0; i < 100 && p[0] == null; i++) try { Thread.sleep(20); } catch (InterruptedException ignored) { }
            lastResult.set("snap " + p[0]);
            return "{\"ok\":true,\"path\":" + (p[0] == null ? "null" : "\"" + esc(p[0]) + "\"") + "}";
        }
        if ("eval".equals(actType)) {
            final String js = jstr(body, "js");
            if (js == null) return "{\"ok\":false,\"err\":\"need js\"}";
            // 结果内联回传(callback 槽,同 snap 模式阻塞等 2.5s)。旧 title 通道已废
            // (PageSeen 只在 onPageFinished 刷 lastTitle——JS 写 title 永不回传)。
            final String[] p = { null };
            a.runOnUiThread(new UiRun(a, 4, 0, 0, js, p));
            for (int i = 0; i < 125 && p[0] == null; i++) try { Thread.sleep(20); } catch (InterruptedException ignored) { }
            if (p[0] == null) return "{\"ok\":false,\"err\":\"eval timeout\"}";
            // callback 值是 JSON 编码(String 完成值→带引号),剥引号+反转义常用项
            String v = p[0];
            if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
                v = v.substring(1, v.length() - 1)
                        .replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
                        .replace("\\\"", "\"").replace("\\\\", "\\");
            }
            lastResult.set("eval " + v.substring(0, Math.min(180, v.length())));
            return "{\"ok\":true,\"result\":" + "\"" + esc(v) + "\"}";
        }
        return "{\"ok\":false,\"err\":\"unknown act\"}";
    }

    // ── CLI 通道(2026-09-23 三端一致:POST /api/cli {cmd} ──
    //  与 myco-ubuntu / PC cli.rs 同一套命令词表(identity/sign/device/delegation)。
    //  两段式:eval 提交 MycoCli.submit(异步跑,网络命令可数十秒) → 轮询 pollResult
    //  取 JSON 文本。eval 单次 2.5s 上限只约束"读值",不约束 CLI 任务本身。──
    private int cliSeq = 0;

    public String cli(String body) {
        String cmd = jstr(body, "cmd");
        if (cmd == null || cmd.trim().isEmpty()) return "{\"ok\":false,\"err\":\"need cmd\"}";
        cmd = cmd.replace("\r", " "); // esc 不覆盖 \r(严格 JSON 字面量禁裸 \r)
        MainActivity a = act;
        String id = "c" + (++cliSeq);
        String s = evalSync(a, "window.MycoCli?window.MycoCli.submit('" + id + "',\"" + esc(cmd) + "\"):'ERR:no-cli'");
        if (s == null) return "{\"ok\":false,\"err\":\"eval timeout（WebView 无响应）\"}";
        if (s.indexOf("ERR:no-cli") >= 0) return "{\"ok\":false,\"err\":\"MycoCli 未就绪（WebView 未加载完成/前端版本过旧）\"}";
        // 轮询最长 45s：device register/delegation issue --deliver 走云 attest+投递，慢链路也要够
        for (int i = 0; i < 180; i++) {
            try { Thread.sleep(250); } catch (InterruptedException e) { break; }
            String r = evalSync(a, "window.MycoCli?window.MycoCli.pollResult('" + id + "'):'ERR:no-cli'");
            if (r == null || "__PENDING__".equals(r)) continue; // null=偶发 eval 超时,重试
            lastResult.set("cli " + cmd.substring(0, Math.min(80, cmd.length())) + " -> " + r.substring(0, Math.min(120, r.length())));
            return r; // MycoCli.exec 的 JSON 输出({ok,data}/{ok:false,err})
        }
        return "{\"ok\":false,\"err\":\"cli timeout(45s)\"}";
    }

    /** UI 线程 eval 同步等结果(同 intent.eval 的剥引号+反转义)。null=超时。 */
    private String evalSync(MainActivity a, String js) {
        final String[] p = { null };
        a.runOnUiThread(new UiRun(a, 4, 0, 0, js, p));
        for (int i = 0; i < 125 && p[0] == null; i++) try { Thread.sleep(20); } catch (InterruptedException ignored) { }
        if (p[0] == null) return null;
        String v = p[0];
        if (v.length() >= 2 && v.startsWith("\"") && v.endsWith("\"")) {
            v = v.substring(1, v.length() - 1)
                    .replace("\\n", "\n").replace("\\t", "\t").replace("\\r", "\r")
                    .replace("\\\"", "\"").replace("\\\\", "\\");
        }
        return v;
    }

    // ── 极简 JSON 取值(不引库,够用) ──────────────────────────────────────
    /** 取布尔字段；缺失返回 null（调用方区分"没传"与"false"）。 */
    private static Boolean jbool(String json, String key) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + key + "\"\\s*:\\s*(true|false)").matcher(json);
        return m.find() ? Boolean.parseBoolean(m.group(1)) : null;
    }

    private static String jstr(String json, String key) {
        // 支持 \\" 转义。2026-10-22 二次修：旧式 `(?:[^"]|\\.)*` 在 `\"` 处会**截断**——
        // 正则先让 `[^"]` 吃掉反斜杠，再让收尾的 `"` 吃掉被转义的引号，于是
        // `{"js":"window.f(\"x\")"}` 取出来是 `window.f(\`（残缺 JS → 注入必挂）。
        // 新式 `[^"\\]` 先把反斜杠排掉，转义序列整体走 `\\.`，再统一 unescape。
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + key + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json);
        if (!m.find()) return null;
        String raw = m.group(1);
        StringBuilder sb = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch != '\\' || i + 1 >= raw.length()) { sb.append(ch); continue; }
            char nx = raw.charAt(++i);
            switch (nx) {
                case 'n': sb.append('\n'); break;
                case 't': sb.append('\t'); break;
                case 'r': sb.append('\r'); break;
                case '"': sb.append('"'); break;
                case '\\': sb.append('\\'); break;
                case '/': sb.append('/'); break;
                case 'u':
                    // U+XXXX 转义（PowerShell ConvertTo-Json 把单引号写成 U+0027——
                    // 不还原的话 JS 里是语法错误，注入永远"看起来没执行"）
                    if (i + 4 < raw.length()) {
                        try {
                            sb.append((char) Integer.parseInt(raw.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException e) {
                            sb.append("\\u");
                        }
                    } else {
                        sb.append("\\u");
                    }
                    break;
                default: sb.append('\\').append(nx);
            }
        }
        return sb.toString();
    }
    private static int jint(String json, String key, int def) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"" + key + "\"\\s*:\\s*(-?\\d+)").matcher(json);
        return m.find() ? Integer.parseInt(m.group(1)) : def;
    }
    public static String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n");
    }
}
