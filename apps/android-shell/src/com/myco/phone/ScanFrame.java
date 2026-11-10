package com.myco.phone;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;

/** 扫码取景框:中央方形四角细括号(白,半透明)。顶层类。 */
public class ScanFrame extends View {
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    public ScanFrame(Context c) {
        super(c);
        line.setColor(0xB3FFFFFF);
        line.setStyle(Paint.Style.STROKE);
        line.setStrokeWidth(4f);
        setWillNotDraw(false);
    }
    @Override protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        int size = (int) (Math.min(w, h) * 0.60f);
        int l = (w - size) / 2, t = (int) (h * 0.28f), r = l + size, b = t + size;
        int c = size / 7;
        float[][] seg = {
            {l, t + c, l, t, l + c, t}, {r - c, t, r, t, r, t + c},
            {r, b - c, r, b, r - c, b}, {l + c, b, l, b, l, b - c},
        };
        for (float[] s : seg) {
            cv.drawLine(s[0], s[1], s[2], s[3], line);
            cv.drawLine(s[2], s[3], s[4], s[5], line);
        }
    }
}
