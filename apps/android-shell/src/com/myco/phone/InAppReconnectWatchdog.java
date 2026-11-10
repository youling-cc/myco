package com.myco.phone;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

/**
 * InAppReconnectWatchdog —— 应用内浏览器「重新连接中」卡死自愈（2026-10-25）。
 *
 * 真案（00:50 现场截图）：网关重启窗口/隧道陈旧时，DSH 分享页壳已渲染、账号在，
 * 但 mux WS 一直起不来 → 页面停在「重新连接中 · 暂无会话」，用户只能手动刷新。
 * 网关侧审计实锤：该次加载有 entry/doc/list（HTTP 全通）但零 ws-upgrade。
 *
 * 修法（不猜根因、页面级自愈）：onPageFinished 后 12s 探一次 body 文本，命中
 * 「重新连接中」且 remote.mux 尚未打开 / 已关闭 / 超过 30s 无消息时才 reload，
 * 最多 2 次。2026-10-27 真案：大 DSH 分享 control baseline 3.5MB + follow 6.1MB，
 * 6s 时正文仍显示“重新连接中”但 mux 已开且持续下行；旧“只看文案” watchdog 会
 * 把正常首载打断，造成 R10 反复 reload。
 *
 * 顶层类纪律：d8 8.2.2-dev 对匿名/内嵌 Runnable NPE——与 TunnelJsRun 同款处理。
 */
public class InAppReconnectWatchdog implements Runnable {
    private static final long PROBE_DELAY_MS = 12000;
    private static final int MAX_RELOADS = 2;

    private final InAppBrowserActivity act;
    private final android.os.Handler handler = new Handler(Looper.getMainLooper());

    public InAppReconnectWatchdog(InAppBrowserActivity a) {
        this.act = a;
    }

    /** 页面加载完成后调用：延迟探一次。 */
    public void arm() {
        handler.removeCallbacks(this);
        handler.postDelayed(this, PROBE_DELAY_MS);
    }

    /** Activity 销毁时调用，防泄漏。 */
    public void dispose() {
        handler.removeCallbacks(this);
    }

    @Override
    public void run() {
        try {
            WebView w = act.web;
            if (w == null || act.isFinishing()) {
                return;
            }
            if (act.reconnectReloads >= MAX_RELOADS) {
                return;
            }
            // 探测脚本：正文重连 + remote.mux 未开/已关/30s 无消息 才判卡死。
            // gateway 页面脚本暴露 window.__mux / __muxLastMsg（remote.mux WebSocket）。
            String js = "(function(){var t=document.body?document.body.innerText:'';"
                    + "if(t.indexOf('\\u91cd\\u65b0\\u8fde\\u63a5')<0)return '0';"
                    + "var m=window.__mux||null;if(!m||m.readyState===0||m.readyState===2||m.readyState===3)return '1';"
                    + "var last=Number(window.__muxLastMsg||0);"
                    + "if(!last)return '0';"
                    + "return (Date.now()-last>30000)?'1':'0';})()";
            w.evaluateJavascript(js, new InAppReconnectCheck(act));
        } catch (Exception ignored) {
        }
    }
}
