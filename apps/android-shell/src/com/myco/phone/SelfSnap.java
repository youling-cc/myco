package com.myco.phone;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import android.webkit.WebView;
import java.io.File;
import java.io.FileOutputStream;

/** 自截屏助手(顶层类——R8 8.2.2-dev 对 JBR javac 内嵌类字节码 NPE,嵌套/匿名都炸)。
 *  外部私有目录落盘(/sdcard/Android/data/<pkg>/files/),adb 可直接 pull。 */
public class SelfSnap {
    public static String snap(Activity act, WebView web) {
        try {
            Bitmap bmp = Bitmap.createBitmap(web.getWidth(), web.getHeight(), Bitmap.Config.ARGB_8888);
            web.draw(new Canvas(bmp));
            File dir = act.getExternalFilesDir(null);
            if (dir == null) dir = act.getFilesDir();
            File f = new File(dir, "self-shot.png");
            FileOutputStream out = new FileOutputStream(f);
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out);
            out.close();
            return f.getAbsolutePath();
        } catch (Exception e) { return "ERR: " + e.getMessage(); }
    }
}
