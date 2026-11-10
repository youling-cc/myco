package com.myco.phone;

import android.webkit.WebView;

/** 注入 JS 网络重置钩子（顶层类，规避 D8 对嵌套匿名类的问题）。 */
public class NetWatchJsTask implements Runnable {
    private final WebView web;
    public NetWatchJsTask(WebView w) { this.web = w; }
    @Override public void run() {
        try {
            web.evaluateJavascript(
                "try{window.__mycoNetChanged&&window.__mycoNetChanged()}catch(e){}",
                null);
        } catch (Throwable ignored) { }
    }
}
