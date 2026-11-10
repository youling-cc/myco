package com.myco.phone;

import android.webkit.ConsoleMessage;

/**
 * 控制台留证（2026-10-12）：把 WebView 的 console 输出落到 GwLog。
 *
 * 两个挂点、一个类族：
 *   · MainActivity 用 {@link ShellChrome}（extends PermChrome——摄像头权限应答和
 *     input[type=file] 选择器都在 PermChrome 里，继承即保留，一个不丢）；
 *   · ShareWebActivity 用 {@link ShareChrome}（普通 WebChromeClient + console，
 *     不带媒体授权——分享页不该拿摄像头）。
 * 顶层类（R8 对内嵌类炸，仓里既有纪律）。
 */
class ShellChrome extends PermChrome {
    private final android.app.Activity act;

    ShellChrome(android.app.Activity a) { act = a; }

    @Override
    public boolean onConsoleMessage(ConsoleMessage m) {
        try {
            String msg = m.message() == null ? "" : m.message();
            if (msg.length() > 300) msg = msg.substring(0, 300) + "…";
            GwLog.note(act, "app console[" + m.messageLevel() + "] " + msg
                    + " @" + GwLog.shortUrl(m.sourceId()) + ":" + m.lineNumber());
        } catch (Exception ignored) { }
        return super.onConsoleMessage(m);
    }
}

/** 分享页（DSH Web）的控制台留证——白屏现场的第一手日志。 */
public class ShareChrome extends android.webkit.WebChromeClient {
    private final android.app.Activity act;

    public ShareChrome(android.app.Activity a) { act = a; }

    @Override
    public boolean onConsoleMessage(ConsoleMessage m) {
        try {
            String msg = m.message() == null ? "" : m.message();
            if (msg.length() > 300) msg = msg.substring(0, 300) + "…";
            GwLog.note(act, "gw console[" + m.messageLevel() + "] " + msg
                    + " @" + GwLog.shortUrl(m.sourceId()) + ":" + m.lineNumber());
        } catch (Exception ignored) { }
        return super.onConsoleMessage(m);
    }
}
