package com.myco.phone;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.View;

/** 标准快门(自绘,无文字):白色细外环 + 白色内圆,系统相机通用样式。顶层类。 */
public class ShutterView extends View {
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint core = new Paint(Paint.ANTI_ALIAS_FLAG);
    public ShutterView(Context c) {
        super(c);
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeWidth(8f);
        ring.setColor(0xFFFFFFFF);
        core.setStyle(Paint.Style.FILL);
        core.setColor(0xFFFFFFFF);
        setContentDescription("shutter");
    }
    @Override protected void onDraw(Canvas cv) {
        int w = getWidth(), h = getHeight();
        float cx = w / 2f, cy = h / 2f;
        float outer = Math.min(cx, cy) - 5f;
        float inner = outer * 0.76f;
        cv.drawCircle(cx, cy, outer, ring);
        cv.drawCircle(cx, cy, inner, core);
    }
}
