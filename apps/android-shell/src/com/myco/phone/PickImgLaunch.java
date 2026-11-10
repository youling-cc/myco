package com.myco.phone;

import android.app.Activity;
import android.content.Intent;

/** 图库选图启动(UI 线程——与相机同理:JS 桥线程启动不前台)。顶层类——R8。 */
public class PickImgLaunch implements Runnable {
    private final Activity act;
    private final int requestCode;
    public PickImgLaunch(Activity act, int requestCode) { this.act = act; this.requestCode = requestCode; }
    @Override public void run() {
        try {
            Intent i = new Intent(Intent.ACTION_GET_CONTENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("image/*");
            // GET_CONTENT 走系统选择器,返回 content URI 自带临时授权——不需要存储权限
            act.startActivityForResult(i, requestCode);
            CamLog.note(act, "pick launched ok @ " + System.currentTimeMillis());
        } catch (Exception e) {
            CamLog.note(act, "pick FAIL: " + e.getClass().getName() + ": " + e.getMessage());
        }
    }
}
