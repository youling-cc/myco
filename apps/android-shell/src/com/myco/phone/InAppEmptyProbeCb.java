package com.myco.phone;

import android.webkit.WebView;

/**
 * 空态探针的结果回调（2026-10-31 状态契约 driftSignals）。
 *
 * 顶层类而不是匿名 ValueCallback——同 {@link InAppEmptyStateCheck} 的理由：
 * 本仓 d8 对 InAppBrowserActivity 的嵌套/匿名类报 internal error。
 * ⚠️ 裸类型 ValueCallback（不带泛型）：d8 8.2.2-dev 对泛型签名报 NPE——
 * 与 {@link JsNoOpCb} / InAppReconnectCheck 同款处理。
 * 结果判定与恢复动作都在宿主侧（单一决策点），本类只做转交。
 */
final class InAppEmptyProbeCb implements android.webkit.ValueCallback {

    private final InAppBrowserActivity host;
    private final WebView view;

    InAppEmptyProbeCb(InAppBrowserActivity host, WebView view) {
        this.host = host;
        this.view = view;
    }

    @Override
    public void onReceiveValue(Object value) {
        try {
            host.onEmptyStateProbe(view, value instanceof String ? (String) value : null);
        } catch (Throwable ignored) { }
    }
}
