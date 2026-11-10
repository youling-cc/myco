package com.myco.phone;

/**
 * 回前台探针的结果回调（2026-10-12 切会话断连修复）。
 *
 * **raw `ValueCallback`**（不写泛型参数）+ `onReceiveValue(Object)`：d8 8.2.2-dev
 * 对泛型父接口的 Signature 属性解析有 NPE 旧疾（写 `ValueCallback&lt;String&gt;`
 * 会 "Compilation failed with an internal error"）——承 `ShareBodyLen` 的既有纪律。
 *
 * 语义：探针异步跑完把结果（"1"=通 / "0"=断）写进 window，Activity 延时读回；
 * 读回 "0" → 整页 reload（隧道本地口已持久化，reload 即恢复连接）。
 */
public class ShareProbeCallback implements android.webkit.ValueCallback {
    private final ShareWebActivity act;

    public ShareProbeCallback(ShareWebActivity a) { this.act = a; }

    @Override
    public void onReceiveValue(Object value) {
        act.onProbeValue(value == null ? null : String.valueOf(value));
    }
}
