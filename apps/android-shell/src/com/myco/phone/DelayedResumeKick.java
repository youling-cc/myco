package com.myco.phone;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

/**
 * 回前台恢复的延迟二次踢（2026-10-23）。
 *
 * 为什么要独立顶层类：本仓的 d8 对「匿名/内部 Runnable」会报 internal error
 * （同一坑最早踩在 WebViewClient 匿名类上）——所以一律用独立文件。
 *
 * 行为：延迟 delayMs 后向页面注入一次 window.__mycoHostResume()（幂等恢复钩子：
 * 刷新 presence / 重武装 vnet 转发 / 广播 online）。部分机型 onResume 时 WebView
 * 网络栈还没恢复，立即踢一次可能假失败，所以再补这一脚。
 */
final class DelayedResumeKick implements Runnable {

    private final WebView web;
    private final Handler handler = new Handler(Looper.getMainLooper());

    DelayedResumeKick(WebView web) {
        this.web = web;
    }

    void schedule(long delayMs) {
        try {
            handler.postDelayed(this, delayMs);
        } catch (Throwable ignored) { }
    }

    @Override
    public void run() {
        try {
            if (web != null) {
                web.evaluateJavascript(
                        "try{if(window.__mycoHostResume){window.__mycoHostResume();}}catch(e){}", null);
            }
        } catch (Throwable ignored) { }
    }
}
