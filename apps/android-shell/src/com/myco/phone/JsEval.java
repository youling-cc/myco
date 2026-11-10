package com.myco.phone;

import android.webkit.WebView;

/**
 * JsEval — 顶层 Runnable（d8/R8 纪律：匿名/内嵌类会 NPE）。
 * 在 UI 线程执行一段 JS（evaluateJavascript）。
 */
public class JsEval implements Runnable {
    private final WebView web;
    private final String code;

    public JsEval(WebView w, String c) {
        this.web = w;
        this.code = c;
    }

    @Override
    public void run() {
        try {
            // 2026-10-23：必须带非 null callback——本机 WebView（Honor MBH-AN10）上
            // evaluateJavascript(js, null) 存在"静默不执行"的实证（UiRun kind0 2026-09-28
            // 同款病，那边已修）。本类是隧道 wsData/wsClosed 等**下行数据投递**的唯一通道，
            // 回程丢帧排障期对齐同一修法：带一个丢弃结果的 JsCallback。
            if (web != null) web.evaluateJavascript(code, new JsCallback(new String[1]));
        } catch (Throwable ignored) {
        }
    }
}
