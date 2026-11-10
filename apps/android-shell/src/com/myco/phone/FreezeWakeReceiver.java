package com.myco.phone;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.webkit.WebView;

/**
 * FreezeWakeReceiver — 2026-10-20 B1 方案（AlarmManager 周期唤醒 + 主动拉取）。
 *
 * 背景（R8b 真机数据）：Honor 深睡/投递挂起时，native 线程活着、WebView JS 停摆，
 * relay 入站字节也被压制（delivery_suspended）→ C 的原生通知触发不了。
 * 本接收器用 setExactAndAllowWhileIdle（Doze 允许）/ setAndAllowWhileIdle 兜底，
 * 每 9 分钟把进程叫醒一次：取 wake lock → 拉起 KeepAliveService → 注入
 * window.__mycoAlarmWake()（JS 侧强制 chatPoll + syncOfficialPending）→ 回执走桥
 * MycoShell.alarmWakeJsRan()；8s 无回执记 jsRan=0 并尝试 reload。
 *
 * 日志字段（给 DSH R8b / C 覆盖断言）：
 *   alarm-wake fired
 *   alarm-wake attempt jsIdleMsBefore=<ms>
 *   alarm-wake jsRan=1            ← JS 真执行了（桥回执）
 *   alarm-wake jsRan=0（8s 无回执，尝试 reload）
 *   alarm-wake 已排下一次 interval=<s>s
 */
public class FreezeWakeReceiver extends BroadcastReceiver {
    public static final String ACTION = "com.myco.phone.FREEZE_WAKE";
    /** Doze 下 allow-while-idle 的最小间隔约 9 分钟；先用 9 分钟一档。 */
    public static final long INTERVAL_MS = 9 * 60_000L;

    @Override
    public void onReceive(final Context ctx, Intent intent) {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "myco:alarm-wake");
                wl.setReferenceCounted(false);
                wl.acquire(30_000);
            }
            // 前台服务保活（已有则 no-op）
            try { ctx.startForegroundService(new Intent(ctx, KeepAliveService.class)); }
            catch (Throwable t) {
                try { ctx.startService(new Intent(ctx, KeepAliveService.class)); } catch (Throwable ignored) { }
            }
            GwLog.note(ctx, "alarm-wake fired");
            GwLog.note(ctx, "alarm-wake attempt jsIdleMsBefore=" + RelayProvider.jsIdleMs());
            MainActivity.sAlarmWakeAck = false;
            WebView w = MainActivity.sWeb;
            if (w == null) {
                GwLog.note(ctx, "alarm-wake jsRan=0（no webview）");
            } else {
                // 独立顶层 Runnable（本工程 D8 对匿名 Runnable 会内部错误）
                w.post(new FreezeWakeTask(ctx, w, false));
                w.postDelayed(new FreezeWakeTask(ctx, w, true), 8_000);
            }
            scheduleNext(ctx);
        } catch (Throwable t) {
            try { GwLog.note(ctx, "alarm-wake 异常: " + t); } catch (Throwable ignored) { }
        }
    }

    /** 排下一次（自我续排；setRepeating 在 Doze 下不精确）。 */
    public static void scheduleNext(Context ctx) {
        scheduleIn(ctx, INTERVAL_MS, 100);
    }

    /** 测试用：N 秒后触发一次（MycoShell.scheduleTestAlarm 暴露给 eval）。 */
    public static void scheduleTest(Context ctx, int seconds) {
        scheduleIn(ctx, Math.max(1, seconds) * 1000L, 200);
    }

    private static void scheduleIn(Context ctx, long delayMs, int reqCode) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(ctx, FreezeWakeReceiver.class);
            i.setAction(ACTION);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getBroadcast(ctx, reqCode, i, flags);
            long at = SystemClock.elapsedRealtime() + delayMs;
            try {
                if (Build.VERSION.SDK_INT >= 23) {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
                } else {
                    am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi);
                }
                GwLog.note(ctx, "alarm-wake 已排下一次 interval=" + (delayMs / 1000) + "s");
            } catch (Throwable se) {
                // Android 12+ 未授予 SCHEDULE_EXACT_ALARM / 厂商限制 → 退化不精确但允许 Doze
                GwLog.note(ctx, "alarm-wake exact 失败，退化 setAndAllowWhileIdle: " + se);
                try { am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, pi); } catch (Throwable ignored) { }
            }
        } catch (Throwable t) {
            try { GwLog.note(ctx, "alarm-wake 排程失败: " + t); } catch (Throwable ignored) { }
        }
    }
}
