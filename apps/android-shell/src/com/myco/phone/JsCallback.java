package com.myco.phone;

/** evaluateJavascript 结果回执(顶层类——R8/d8 对匿名内部类 NPE)。
 *  raw type:泛型超接口的 Signature 属性同样触发 d8 8.2.2-dev NPE(实测),
 *  去 <String> 后无 Signature 属性即编译通过。 */
@SuppressWarnings({"rawtypes", "deprecation"})
public class JsCallback implements android.webkit.ValueCallback {
    private final String[] slot;
    public JsCallback(String[] slot) { this.slot = slot; }
    @Override public void onReceiveValue(Object v) { slot[0] = v == null ? "null" : String.valueOf(v); }
}
