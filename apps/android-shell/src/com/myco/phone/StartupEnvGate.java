package com.myco.phone;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * StartupEnvGate — 2026-10-26 新装机环境闸门。
 *
 * 背景：
 *  - Honor/Huawei 的「启动管理」在首次安装后默认把
 *    自启动 / 关联启动 / 后台活动 全关。
 *  - 这些开关是厂商私有限制，Android 没有公开 API 能替用户静默打开。
 *  - 如果不引导用户先放开，myco 退后台就会被整进程冻结，
 *    远程桌面/SSH/DSH 等长连接会全部断掉。
 *
 * 本类的职责：
 *  1. 只在首次安装后弹一次本机对话框，说明为什么需要这三项；
 *  2. 点「去开启」直接深链到荣耀系统「启动管理」页；
 *  3. 用户点「去开启」后本闸门不再打扰；
 *  4. 若点「暂不」，下次启动仍会提醒（环境没就绪就不该静默放过）。
 */
public final class StartupEnvGate {
    private static final String PREFS_NAME = "myco_startup_env";
    private static final String KEY_DONE = "done_v1";
    private static final String VENDOR_PKG = "com.hihonor.systemmanager";
    private static final String VENDOR_ACTIVITY = "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity";

    private StartupEnvGate() {
    }

    /** 入口：Activity 启动后调用（内部自行判断是否需要弹、是否能弹）。 */
    public static void showIfNeeded(Activity act) {
        if (act == null) return;
        if (!startupManagerExists(act)) return;
        SharedPreferences prefs = act.getSharedPreferences(PREFS_NAME, Activity.MODE_PRIVATE);
        if (prefs.getBoolean(KEY_DONE, false)) return;

        AlertDialog.Builder b = new AlertDialog.Builder(act);
        b.setTitle("开启后台运行");
        b.setMessage(
            "为了让你切到其他应用时，远程桌面、SSH、DSH 等长连接不中断，"
                + "请在系统「启动管理」里把 myco 改成手动管理，并开启：\n\n"
                + "· 允许自启动\n"
                + "· 允许关联启动\n"
                + "· 允许后台活动\n\n"
                + "这些是手机厂商的省电限制，App 无法替你直接修改。"
        );
        b.setPositiveButton("去开启", new GoListener(act, prefs));
        b.setNegativeButton("暂不", null);
        b.setCancelable(false);
        b.show();
    }

    private static boolean startupManagerExists(Activity act) {
        try {
            Intent i = new Intent();
            i.setClassName(VENDOR_PKG, VENDOR_ACTIVITY);
            return act.getPackageManager().resolveActivity(i, 0) != null;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 「去开启」：深链到荣耀启动管理页，并记住本次引导已完成。 */
    private static final class GoListener implements DialogInterface.OnClickListener {
        private final Activity act;
        private final SharedPreferences prefs;

        GoListener(Activity act, SharedPreferences prefs) {
            this.act = act;
            this.prefs = prefs;
        }

        @Override
        public void onClick(DialogInterface dialog, int which) {
            prefs.edit().putBoolean(KEY_DONE, true).apply();
            try {
                Intent i = new Intent();
                i.setClassName(VENDOR_PKG, VENDOR_ACTIVITY);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(i);
            } catch (Throwable ignored) {
                // 极少数 ROM 禁止跨应用深链：退回应用详情页，用户手动进「启动管理」
                try {
                    Intent fallback = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    fallback.setData(android.net.Uri.fromParts("package", act.getPackageName(), null));
                    act.startActivity(fallback);
                } catch (Throwable ignored2) {
                    // 连应用详情都打不开时，只能留在本页；下次启动仍会提醒
                }
            }
        }
    }
}
