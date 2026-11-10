package com.myco.phone;

import android.webkit.WebView;

/**
 * 空态兜底的延迟探针（2026-10-31 状态契约 driftSignals）。
 *
 * 顶层类而不是 InAppBrowserActivity 里的匿名 Runnable——本仓 d8 对该 Activity 的
 * 嵌套/匿名类一律报 internal error（见 InAppBrowserClient 头注释的同款教训）。
 * 职责只有一件事：到点后把（宿主, 视图）交给宿主执行探针；一致性校验在宿主侧。
 */
final class InAppEmptyStateCheck implements Runnable {

    private final InAppBrowserActivity host;
    private final WebView view;

    InAppEmptyStateCheck(InAppBrowserActivity host, WebView view) {
        this.host = host;
        this.view = view;
    }

    @Override
    public void run() {
        try {
            host.runEmptyStateProbe(view);
        } catch (Throwable ignored) { }
    }
}
