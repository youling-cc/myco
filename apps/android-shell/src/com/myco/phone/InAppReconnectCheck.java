package com.myco.phone;

/**
 * InAppReconnectCheck —— 看门狗探测回调（2026-10-25）。
 *
 * evaluateJavascript 的结果带 JSON 引号（\"1\"/\"0\"）；命中 → reload + 计数。
 * 2026-10-27 起原生 watchdog 保持 dormant（Client 不 arm）；此回调仅保留给未来显式启用。
 *
 * ⚠️ 裸类型 ValueCallback（不带泛型）：d8 8.2.2-dev 对 `ValueCallback&lt;String&gt;` 的
 * 泛型签名报 NPE（"String.length() because <parameter1> is null"——2026-10-25 实测），
 * 仓里 ShareNetProbe 的裸类型写法从没出过问题 ⇒ 同款。
 */
public class InAppReconnectCheck implements android.webkit.ValueCallback {
    private final InAppBrowserActivity act;

    public InAppReconnectCheck(InAppBrowserActivity a) {
        this.act = a;
    }

    @Override
    public void onReceiveValue(Object value) {
        try {
            if (act == null || act.isFinishing() || act.web == null) {
                return;
            }
            boolean stuck = value != null && String.valueOf(value).contains("1");
            if (!stuck) {
                return;
            }
            act.reconnectReloads++;
            GwLog.note(null, "inapp-reconnect-watchdog: page stuck at reconnecting, reload #"
                    + act.reconnectReloads);
            act.web.reload();
            // dormant 模式：reload 后不会自动 re-arm，需未来调用方显式 arm()
        } catch (Exception ignored) {
        }
    }
}
