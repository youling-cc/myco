package com.myco.phone;

import android.content.Context;
import java.io.File;
import java.io.FileWriter;

/** 相机链路留证(honor 锁三方 logcat,写文件 adb 可读)。顶层类——R8 对内嵌类炸。 */
public class CamLog {
    public static void note(Context c, String msg) {
        try {
            File f = new File(c.getExternalFilesDir(null), "cam.log");
            FileWriter w = new FileWriter(f, true);
            w.write(msg + "\n");
            w.close();
        } catch (Exception ignored) { }
    }
}
