package com.myco.phone;

import android.content.Intent;
import android.app.Activity;

/** 相机启动(UI 线程——JS 桥线程 startActivity 不前台):拉起取景页 ScanCamActivity
 *  (全屏预览+系统风格快门/相册缩略图,拍照与图库选图一体)。顶层类。 */
public class SnapCamLaunch implements Runnable {
    private final Activity act;
    private final int requestCode;
    public SnapCamLaunch(Activity act, int requestCode) { this.act = act; this.requestCode = requestCode; }
    @Override public void run() {
        try {
            Intent i = new Intent(act, ScanCamActivity.class);
            act.startActivityForResult(i, requestCode);
            CamLog.note(act, "scancam launched @ " + System.currentTimeMillis());
        } catch (Exception e) {
            CamLog.note(act, "scancam FAIL: " + e.getClass().getName() + ": " + e.getMessage());
        }
    }
}
