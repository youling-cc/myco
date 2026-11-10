package com.myco.phone;

import android.content.Context;
import java.io.File;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * GwLog — 分享链路留证（2026-10-12，"白屏数分钟"那一轮的取证通道）。
 *
 * 为什么写文件而不是 logcat：honor 锁三方 logcat（HKS），app 内留证写
 * getExternalFilesDir 再 adb pull（承 CamLog 同款纪律）。
 *
 * 接住四类信息（都汇到同一个 gw-net.log，按前缀区分）：
 *   · app  console[…]   —— MainActivity 的 myco 前端日志（[dsh-open] 重试/自愈轨迹）
 *   · gw   console[…]   —— 分享页（DSH Web）自己的日志
 *   · gw   http <code> MAIN|sub <url> —— 反代上游非 2xx（onReceivedHttpError）
 *   · gw   net <code> <desc> MAIN|sub <url> —— 网络层失败（DNS/拒连/超时）
 *   · gw   page start|finish <url>；body=<n> —— 页面生命周期 + **正文可见字符数**
 *
 * body≈0 就是白屏的铁证签名（壳到了、SPA 没渲染）——之前只能靠截图事后猜。
 *
 * 体量纪律：单文件 400KB 封顶，超了滚动成 .old（再超覆盖）——长期运行不吃穿存储。
 * 线程安全：synchronized（WebViewClient 回调在 IO 线程、console 回调在 UI 线程）。
 */
public class GwLog {
    private static final String NAME = "gw-net.log";
    private static final long CAP = 2 * 1024 * 1024;  // 2026-10-20：400KB→2MB（R8b 冻结窗口要更长日志覆盖）
    private static final SimpleDateFormat TS =
            new SimpleDateFormat("HH:mm:ss.SSS", Locale.US);
    /** 目录缓存（2026-10-12：RelayProvider 等无线程 Context 的调用方传 null——
     *  首次拿到非空 Context 后缓存，此后 null 直接用缓存）。 */
    private static volatile java.io.File cachedDir = null;

    /** 追加一行（context 可为 null——用缓存目录；任何失败静默——留证不能反噬主流程）。 */
    public static synchronized void note(Context c, String line) {
        try {
            if (c != null) cachedDir = c.getExternalFilesDir(null);
            java.io.File dir = cachedDir;
            if (dir == null) return;
            File f = new File(dir, NAME);
            if (f.length() > CAP) {
                // 2026-10-20：两代轮转（.old / .old2），单代在 R8b 长窗口里会丢冻结前一段
                File old2 = new File(dir, NAME + ".old2");
                File old1 = new File(dir, NAME + ".old");
                if (old2.exists()) old2.delete();
                if (old1.exists()) old1.renameTo(old2);
                f.renameTo(old1);
            }
            FileWriter w = new FileWriter(f, true);
            w.write(TS.format(new Date()) + " " + line + "\n");
            w.close();
        } catch (Exception ignored) { }
    }

    /** URL 收敛到日志友好长度（query 里的 mt 票据很长，截掉不影响定位）。 */
    public static String shortUrl(Object u) {
        String s = String.valueOf(u);
        return s.length() > 140 ? s.substring(0, 140) + "…" : s;
    }
}
