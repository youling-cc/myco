package com.myco.phone;

import android.content.Context;
import android.webkit.WebView;

/**
 * FreezeWakeTask — 2026-10-20 B1：FreezeWakeReceiver 唤醒后的 WebView 注入任务。
 *
 * 独立顶层类：本工程的 D8(8.2.2) 对"匿名 Runnable 内再嵌套/捕获"的 class 文件会内部错误
 * （FreezeWakeReceiver$1 触发 NPE），故把 Runnable 做成独立类，避免生成 $1.class。
 */
public class FreezeWakeTask implements Runnable {
    private final Context ctx;
    private final WebView w;
    /** true = 8s 后回执检查（未回执则 reload）；false = 注入唤醒 JS。 */
    private final boolean checkAck;

    public FreezeWakeTask(Context ctx, WebView w, boolean checkAck) {
        this.ctx = ctx;
        this.w = w;
        this.checkAck = checkAck;
    }

    @Override public void run() {
        if (checkAck) {
            if (!MainActivity.sAlarmWakeAck) {
                GwLog.note(ctx, "alarm-wake jsRan=0（8s 无回执，尝试 reload）");
                try { w.reload(); } catch (Throwable ignored) { }
            }
            return;
        }
        try {
            w.evaluateJavascript(
                    "try{window.__mycoAlarmWake&&window.__mycoAlarmWake();MycoShell.alarmWakeJsRan()}catch(e){}",
                    null);
        } catch (Throwable t) {
            GwLog.note(ctx, "alarm-wake eval 失败: " + t);
        }
    }
}
