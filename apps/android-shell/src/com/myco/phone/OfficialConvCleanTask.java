package com.myco.phone;

import android.webkit.WebView;

/**
 * OfficialConvCleanTask — 2026-10-20 运维：清理本机「小灵（官方 did 尾巴 z6MkuH5FN）」会话的
 * localStorage 键（conv/convmeta/seen 等），然后刷新页面。
 *
 * 独立顶层类：本工程 D8 8.2.2 对匿名 Runnable 会内部错误（MainActivity$MycoShell$1 触发 NPE）。
 */
public class OfficialConvCleanTask implements Runnable {
    private final WebView w;

    public OfficialConvCleanTask(WebView w) {
        this.w = w;
    }

    @Override public void run() {
        if (w == null) return;
        try {
            w.evaluateJavascript(
                    "(function(){var tail='z6MkuH5FN';var n=0;Object.keys(localStorage).forEach(function(k){if(k.indexOf(tail)>=0){localStorage.removeItem(k);n++}});if(window.location&&window.location.reload)setTimeout(function(){location.reload()},300);return n})()",
                    null);
        } catch (Throwable ignored) { }
    }
}
