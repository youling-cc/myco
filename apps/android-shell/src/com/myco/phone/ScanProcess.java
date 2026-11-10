package com.myco.phone;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.net.Uri;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/** 拍照/图库图片后台压码(顶层类):→ downscale ≤1080 → JPEG80 → base64 dataURL。
 *  绝不在 UI 线程做——2026-09-04 用户实测同步处理大图 ANR 黑屏。 */
public class ScanProcess implements Runnable {
    private final ScanCamActivity act;   // 仅 CamLog/finish 用
    private final SnapCam snap;          // 结果直投(不依赖 activity 存活)
    private final Uri uri;      // 二选一
    private final byte[] jpeg;  // 二选一(拍照字节)
    public ScanProcess(ScanCamActivity act, SnapCam snap, Uri uri, byte[] jpeg) { this.act = act; this.snap = snap; this.uri = uri; this.jpeg = jpeg; }
    @Override public void run() {
        String out = null;
        try {
            byte[] bytes;
            if (uri != null) {
                InputStream in = act.getContentResolver().openInputStream(uri);
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] bf = new byte[16384]; int n;
                while ((n = in.read(bf)) > 0) bo.write(bf, 0, n);
                in.close();
                bytes = bo.toByteArray();
            } else {
                bytes = jpeg;
            }
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(bytes, 0, bytes.length, probe);
            int sample = 1;
            while (probe.outWidth / (sample * 2) >= 1080 || probe.outHeight / (sample * 2) >= 1080) sample *= 2;
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inSampleSize = sample;
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
            if (bmp != null) {
                if (uri == null) { // 相机竖屏:传感器 90°,JPEG 已设 JPEG_ORIENTATION,多数机型已转好;
                    // 方向不一致时 jsQR 对 90° 旋转仍鲁棒(finder pattern 检测),不再二次旋转——
                    // 避免某些机型双重旋转把图转坏(2026-09-04 实测 JPEG_ORIENTATION=90 输出已正)。
                }
                ByteArrayOutputStream b2 = new ByteArrayOutputStream();
                bmp.compress(Bitmap.CompressFormat.JPEG, 80, b2);
                String b64 = android.util.Base64.encodeToString(b2.toByteArray(), android.util.Base64.NO_WRAP);
                out = "data:image/jpeg;base64," + b64;
            }
        } catch (Exception e) {
            CamLog.note(act, "scanProcess FAIL: " + e);
        }
        // 直投桥(UI 线程 bridge 内部处理);activity 仅收尾——竞态全消
        snap.onExternalDataUrl(out);
        act.postUi(new ScanDone(act, out != null));
    }
}
