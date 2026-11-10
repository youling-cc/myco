package com.myco.phone;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 2026-10-24：亮屏/解锁广播接收器（顶层类——d8 对匿名/内部类会内部报错）。
 * Honor 息屏休眠会冻结 WebView/进程：醒来后 JS 收不到事件、vnet 转发全挂、
 * EnvServer 也会超时（实测 20s 不恢复）。收到 SCREEN_ON/USER_PRESENT 后
 * 通知 Activity 主动注入 window.__mycoHostResume 并补 kick。
 */
final class ScreenOnReceiver extends BroadcastReceiver {
    private final MainActivity act;

    ScreenOnReceiver(MainActivity a) {
        this.act = a;
    }

    @Override
    public void onReceive(Context ctx, Intent it) {
        if (act != null) act.onScreenWake();
    }
}
