package com.myco.phone;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** 图库选图后台处理(顶层类):读 URI → downscale ≤1080 → JPEG80 → base64。
 *  onActivityResult 在 UI 线程——同步处理大照片会 ANR(选完码图黑屏卡死,
 *  2026-09-04 用户实测),全部挪本线程;完成经 PickDone 回 UI 线程。 */
public class PickProcess implements Runnable {
    private final SnapCam cam;
    private final Activity act;
    private final Uri uri;
    public PickProcess(SnapCam cam, Activity act, Uri uri) { this.cam = cam; this.act = act; this.uri = uri; }
    @Override public void run() {
        String out = null;
        try {
            InputStream in = act.getContentResolver().openInputStream(uri);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] bf = new byte[16384]; int n;
            while ((n = in.read(bf)) > 0) bo.write(bf, 0, n);
            in.close();
            byte[] bytes = bo.toByteArray();
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, probe);
            int sample = 1;
            while (probe.outWidth / (sample * 2) >= 1080 || probe.outHeight / (sample * 2) >= 1080) sample *= 2;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
            if (bmp != null) {
                ByteArrayOutputStream b2 = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 80, b2);
                String b64 = android.util.Base64.encodeToString(b2.toByteArray(), android.util.Base64.NO_WRAP);
                out = "data:image/jpeg;base64," + b64;
            }
        } catch (Exception e) {
            CamLog.note(act, "pickProcess FAIL: " + e);
        }
        act.runOnUiThread(new PickDone(cam, out));
    }
}
