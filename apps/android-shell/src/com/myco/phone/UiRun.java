package com.myco.phone;

/** UI 线程 Runnable 包装(顶层类)。 */
public class UiRun implements Runnable {
    private final MainActivity act;
    private final int kind; // 0=tap_xy 1=inject 2=reload 3=snap 4=eval
    private final int x, y;
    private final String js;
    private final String[] result;
    public UiRun(MainActivity act, int kind, int x, int y, String js, String[] result) {
        this.act = act; this.kind = kind; this.x = x; this.y = y; this.js = js; this.result = result;
    }

    @Override public void run() {
        if (kind == 0) {
            // 物理坐标→CSS 坐标(elementFromPoint 用 CSS 像素;WebView 实际渲染区
            // 从状态栏下开始)。按 WebView 尺寸等比换算,分辨率无关。
            int[] loc = new int[2];
            act.web.getLocationOnScreen(loc);
            float scaleX = act.web.getWidth() > 0 ? (float) x / act.web.getWidth() : 0;
            float scaleY = act.web.getHeight() > 0 ? (float) (y - loc[1]) / act.web.getHeight() : 0;
            String j = "(function(){var W=window.innerWidth||1,H=window.innerHeight||1,"
                + "cx=" + scaleX + "*W,cy=" + scaleY + "*H,"
                + "el=document.elementFromPoint(cx,cy);"
                + "if(!el){var els=document.elementsFromPoint?document.elementsFromPoint(cx,cy):[];el=els.length?els[els.length-1]:null;}"
                + "if(el){var r=el.getBoundingClientRect();el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2}));"
                + "window.__tapHit=(el.tagName+'|'+(el.textContent||'').slice(0,30));}else{window.__tapHit='miss';}})()";
            // 2026-09-28 修：evaluateJavascript + null callback 在本机 WebView 静默不执行
            // （D73 在 kind1 抓过的同款病；kind4 用 JsCallback 实证可跑）——tap_xy 从未
            // 真正生效（__tapHit 永不更新即铁证）。改带 callback（结果丢弃）。
            act.web.evaluateJavascript(j, new JsCallback(new String[1]));
        } else if (kind == 1) {
            // 修复（2026-09-10 D73）：evaluateJavascript + null callback 在
            // 部分 WebView 上静默不执行——改 loadUrl("javascript:...") 协议
            // （deprecated 但兼容性最好；R8 匿名类 NPE 排除了 callback 方案）
            // 超长拒绝（2026-09-20）：loadUrl URL 总长约 280 字符封顶——超长的 js 被
            // 静默截断，残缺代码进 try{ 后括号不闭合 → 页面级 SyntaxError 弹 ERR 条
            // （用户实测手机顶部成串红字，hash 里残留 #R=OPEN 等回执即此来源）。
            if (js == null || js.length() > 240) {
                android.util.Log.w("EnvServer", "inject refused: js length=" + (js == null ? 0 : js.length()));
                return;
            }
            String wrapped = "javascript:(function(){try{" + js + "}catch(e){document.title='JSERR:'+e}})()";
            act.web.loadUrl(wrapped);
        } else if (kind == 2) {
            act.web.reload();
        } else if (kind == 3) {
            result[0] = SelfSnap.snap(act, act.web);
        } else if (kind == 4) {
            // 结果走 evaluateJavascript callback(JsCallback 顶层类写 result 槽,
            // EnvServer 阻塞等 2.5s 内联回传)。旧 title 通道已废:PageSeen 的
            // lastTitle 只在 onPageFinished 刷新,JS 写 document.title 永不回传
            // (2026-09-10 定案——"inject 不执行"是误诊,断的是回执不是执行)。
            // 2026-10-23 修（0.3.158 现场误诊源头）：旧包装 `v=(<js>)` 把**语句脚本**
            // 全部变成语法错误——`a;b`、`try{...}catch{...}` 在括号里非法
            // （"Unexpected token ';'" / "'try'"，gw-net.log 有 6 条实证），凡带分号的
            // eval 一律 completion=null，被当成"JS 无响应/卡死"。改为 eval(JSON 字符串)：
            // 语句/表达式都能跑，结果取 completion value；转义用 org.json（ProxyPostTask
            // 同款），不手拼双引号。
            String expr = "(function(){var v;try{v=(function(){return eval("
                + org.json.JSONObject.quote(js) + ")})()}catch(e){v='ERR:'+e}"
                + "try{if(v&&typeof v==='object')v=JSON.stringify(v)}catch(e2){v=String(v)}"
                + "return String(v)})()";
            act.web.evaluateJavascript(expr, result == null ? null : new JsCallback(result));
        }
    }
}
