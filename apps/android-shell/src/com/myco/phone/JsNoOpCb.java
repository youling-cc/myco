package com.myco.phone;

/**
 * JsNoOpCb —— evaluateJavascript 的非 null 空回调（2026-10-25）。
 *
 * 为什么必须非 null：本机（荣耀/WebView 当前版）`evaluateJavascript(js, null)`
 * 会**静默不执行**（TunnelJs 头注释的实证；InAppBrowserClient 的焦点守卫注入
 * 踩的就是这个坑——注入代码写了却从没跑过）。
 *
 * ⚠️ 裸类型 ValueCallback（不带泛型）：d8 8.2.2-dev 对泛型签名报 NPE——与
 * InAppReconnectCheck 同款处理（ShareNetProbe 先例）。
 */
public class JsNoOpCb implements android.webkit.ValueCallback {
    public static final JsNoOpCb IT = new JsNoOpCb();

    @Override
    public void onReceiveValue(Object value) {
        // 故意空：只为满足「非 null 回调」的执行前提
    }
}
