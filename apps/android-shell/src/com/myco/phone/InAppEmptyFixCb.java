package com.myco.phone;

import android.webkit.WebView;

/**
 * 空态兜底第二步的回调：清完陈旧会话指针后触发重载（2026-10-31）。
 *
 * 顶层类而不是匿名 ValueCallback——本仓 d8 对 InAppBrowserActivity 的嵌套/匿名类
 * 报 internal error；⚠️ 裸类型 ValueCallback：d8 8.2.2-dev 对泛型签名报 NPE
 * （与 JsNoOpCb / InAppEmptyProbeCb 同款处理）。
 */
final class InAppEmptyFixCb implements android.webkit.ValueCallback {

    private final InAppBrowserActivity host;
    private final WebView view;

    InAppEmptyFixCb(InAppBrowserActivity host, WebView view) {
        this.host = host;
        this.view = view;
    }

    @Override
    public void onReceiveValue(Object value) {
        try {
            host.reloadAfterEmptyFix(view);
        } catch (Throwable ignored) { }
    }
}
