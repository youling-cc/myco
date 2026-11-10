package com.myco.phone;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Build;
import java.io.ByteArrayOutputStream;

/** 拍照/图库选图(顶层类)。
 *  拍照:系统相机 ACTION_IMAGE_CAPTURE 缩略图(不声明 CAMERA 权限——声明而未
 *  授予会 SecurityException,Android 文档行为)。
 *  图库:ACTION_GET_CONTENT → PhotoPicker,content URI 临时授权,无需存储权限。
 *  两者统一 base64 dataURL 经 _myco_cam_result 回 PWA 识别。
 *  图库大图处理在后台线程(2026-09-04 用户实测 UI 线程同步处理大照片
 *  ANR——选完码图黑屏卡死)。 */
public class SnapCam {
    public static final int REQ_CAPTURE = 0xCA01;
    public static final int REQ_PICK = 0xCA02;
    private final Activity act;
    private String lastErr = "";

    public SnapCam(Activity act, String bridgeName) {
        this.act = act;
    }

    /** 拉起系统相机。必须在 UI 线程 startActivity(JS 桥线程启动不前台)。 */
    public String capture() {
        try {
            act.runOnUiThread(new SnapCamLaunch(act, REQ_CAPTURE));
            return "open";
        } catch (Exception e) {
            lastErr = e.getMessage();
            return "ERR: " + e.getMessage();
        }
    }

    /** 图库选图(扫对方发来的邀请码截图):系统选择器 → URI 临时授权 → 后台
     *  downscale ≤1080 → JPEG base64 → 与拍照同一回执通道。 */
    public String pick() {
        try {
            act.runOnUiThread(new PickImgLaunch(act, REQ_PICK));
            return "open";
        } catch (Exception e) {
            lastErr = e.getMessage();
            return "ERR: " + e.getMessage();
        }
    }

    public String lastErr() { return lastErr; }

    /** onActivityResult 回执:图 → base64 dataURL → bridge 喂 PWA。 */
    public void onResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK) { onPickResult(resultCode, data); return; }
        if (requestCode != REQ_CAPTURE) return;
        // 取景页 ScanCamActivity 直接带回 dataURL(拍照/图库一体)
        if (data != null) {
            String url = data.getStringExtra("dataURL");
            if (url != null) {
                CamLog.note(act, "scancam urlLen=" + url.length());
                bridge(url);
                return;
            }
        }
        CamLog.note(act, "onResult code=" + resultCode + " data=" + (data == null ? "null"
            : "uri=" + data.getData() + " clip=" + (data.getClipData() == null ? "null" : data.getClipData().getItemCount() + "items")
            + " hasDataExtra=" + (Build.VERSION.SDK_INT >= 33 ? data.getParcelableExtra("data", Bitmap.class) != null : data.getParcelableExtra("data") != null)
            + " type=" + data.getType()));
        if (resultCode != Activity.RESULT_OK || data == null) { bridge(null); return; }
        try {
            Bitmap bmp = (Bitmap) (Build.VERSION.SDK_INT >= 33 ? data.getParcelableExtra("data", Bitmap.class) : data.getParcelableExtra("data"));
            if (bmp == null) {
                CamLog.note(act, "no in-memory data extra");
                bridge(null); return;
            }
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 100, b);
            String b64 = android.util.Base64.encodeToString(b.toByteArray(), android.util.Base64.NO_WRAP);
            bridge("data:image/png;base64," + b64);
        } catch (Exception e) { bridge(null); }
    }

    private void onPickResult(int resultCode, Intent data) {
        CamLog.note(act, "pickResult code=" + resultCode + " uri=" + (data == null ? "null" : String.valueOf(data.getData())));
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) { bridge(null); return; }
        Thread t = new Thread(new PickProcess(this, act, data.getData()));
        t.setDaemon(true);
        t.start();
    }

    /** 取景页 ScanProcess 直投(2026-09-04 竞态修复:结果不依赖 activity 的
     *  setResult——activity finish/被杀后 setResult 无效,结果静默丢失=用户
     *  "上传图没反应"的根因。后台压码完直接走桥,进程活着就到)。 */
    public void onExternalDataUrl(String dataUrl) {
        CamLog.note(act, "external urlLen=" + (dataUrl == null ? 0 : dataUrl.length()));
        bridge(dataUrl);
    }

    /** 后台处理完成回接(UI 线程 bridge)。 */
    void onPickDataUrl(String dataUrl) {
        CamLog.note(act, "pick processed urlLen=" + (dataUrl == null ? 0 : dataUrl.length()));
        bridge(dataUrl);
    }

    private void bridge(String dataUrl) {
        String js = "window._myco_cam_result(" + (dataUrl == null ? "null" : "'" + dataUrl.replace("'", "\\'") + "'") + ");";
        act.runOnUiThread(new SnapCamBridge(act, js));
    }
}
