package com.myco.phone;

import android.webkit.WebView;

/**
 * ShareFocusGuard — 分享页「不请自来的键盘」守卫（2026-10-11 初版，2026-10-12 v2）。
 *
 * 现象：分享页（DSH Web GUI）里点别的会话切换，加载完输入法自己弹出来盖住半屏。
 * 根因是 DSH Web 前端切会话时**自动聚焦**输入框，而 Android WebView 里"聚焦可编辑
 * 元素"= 系统直接弹 IME；`SOFT_INPUT_STATE_*` 只管窗口首次获焦，网页 blur() 一枪
 * 只挡装载期那一次（详见初版提交 57e016a 的说明）。
 *
 * 解法：在页面里装一道**焦点闸**——手指真点在输入区才放行之后的聚焦，其余自动聚焦
 * 一律 blur。
 *
 * ── v2（2026-10-12，用户报"切到单列表模式后再点不同会话仍会弹"）────────────────
 * 初版有三处会漏（用户手机上命中，本机 adb 合成点击复现不稳定）：
 *   ① **几何判定太松**：初版用"离输入框 120px 以内"判"在输入区"，候选还来自粗糙
 *      选择器 `[contenteditable]`——`contenteditable="false"` 的大块区域（DSH 用来
 *      把某块标成不可编辑）也被当成"输入框"，于是**侧栏里的会话行**可能被判成"紧邻
 *      输入框"→ 误放行。改为 **DOM 归属判定**：触点在输入框里 / 在"含真输入框的
 *      小容器"里（发送键、工具栏、回车键位就在这条里）；几何兜底收紧到 **20px**
 *      且只认"真输入框"（语义判定 + 真在屏幕上、尺寸正常）。
 *   ② **`input` 事件无差别续期**：SPA 切会话时把草稿写回输入框会派发 input，等于
 *      替页面自己把闸门又打开了。改为**只续期不放行**：已经在放行窗口内、且事件
 *      目标确实在输入区，才续期。
 *   ③ **兜底闸是全局计数**（初版：3s 内拦超 6 次就整体放行）——连续切会话容易把
 *      预算耗光，之后每次自动聚焦都放行 = "刚进 dsh 好、切几次就开始弹"。改为
 *      **逐元素打架检测**：同一个元素 1s 内被拦 4 次才放行它自己（真 focus/blur
 *      打架才触发；人切会话间隔 ≥1s，永远碰不到）。
 *
 * 另外：点输入区以外的地方 → **立刻** blur 收键盘（切会话时旧输入框还聚焦着，
 * 这条负责让键盘马上退场），并在 0/180ms 补两枪（补枪只在闸门关着时开火）。
 *
 * 只在分享页那个独立 WebView 上装；主界面（配对/密码输入）一个字不碰。幂等。
 */
public class ShareFocusGuard {

    /** 在指定 WebView 上装守卫（幂等；任何异常都吞掉——守卫失败不能影响页面本身）。 */
    public static void install(WebView v) {
        if (v == null) return;
        try {
            v.evaluateJavascript(JS, null);
        } catch (Throwable ignored) {
        }
    }

    /**
     * 守卫脚本（经典脚本语法 + 字符串拼接：`-source 8` 无文本块、d8 8.2.2-dev 不吃
     * 匿名/内嵌类；单/双引号按 JS 需要混用，避免 Java 侧转义地狱）。
     */
    static final String JS =
        "(function(){try{"
      + "if(window.__mycoFocusGuard)return;window.__mycoFocusGuard=1;"
      + "var SEL='input,textarea,[contenteditable=\"\"],[contenteditable=\"true\"],[contenteditable=\"plaintext-only\"],[role=\"textbox\"]';"
      + "var ARMED=1500,armed=0;"
      + "var fights=new WeakMap();"
      // 语义判定：这个节点是不是"用户能打字的输入框"
      + "function editable(el){"
      +   "if(!el||el.nodeType!==1)return false;"
      +   "if(el.isContentEditable)return true;"
      +   "var t=el.tagName;"
      +   "if(t==='TEXTAREA')return true;"
      +   "if(t==='INPUT'){"
      +     "var ty=String(el.getAttribute('type')||'text').toLowerCase();"
      +     "return ty===''||ty==='text'||ty==='search'||ty==='url'||ty==='email'||ty==='password'||ty==='tel'||ty==='number';"
      +   "}"
      +   "if(String(el.getAttribute('role')||'').toLowerCase()==='textbox')return true;"
      +   "return false;"
      + "}"
      // 真在屏幕上、尺寸正常（挡掉隐藏替身输入框——它们 rect 是 0 或挂在视口外）
      + "function live(el){"
      +   "if(!el||!el.getBoundingClientRect)return false;"
      +   "var r=el.getBoundingClientRect();"
      +   "return r.width>=20&&r.height>=14&&r.right>0&&r.bottom>0&&r.left<window.innerWidth&&r.top<window.innerHeight;"
      + "}"
      // el 自身/内部有没有"真输入框"
      + "function owns(el){"
      +   "if(!el||el.nodeType!==1)return false;"
      +   "if(editable(el)&&live(el))return true;"
      +   "try{"
      +     "var ns=el.querySelectorAll?el.querySelectorAll(SEL):[];"
      +     "for(var i=0;i<ns.length;i++){if(editable(ns[i])&&live(ns[i]))return true;}"
      +   "}catch(e){}"
      +   "return false;"
      + "}"
      // 触点是否落在"输入区"：输入框本身 / 含输入框的小容器（发送键、工具栏）
      + "function inInput(el){"
      +   "if(owns(el))return true;"
      +   "var n=el,hops=0;"
      +   "while(n&&n!==document.body&&hops<4){"
      +     "if(owns(n)){"
      +       "var r=n.getBoundingClientRect();"
      +       "if(r.width*r.height<window.innerWidth*window.innerHeight*0.5)return true;"
      +     "}"
      +     "n=n.parentElement;hops++;"
      +   "}"
      +   "return false;"
      + "}"
      // 几何兜底（20px、只认真输入框）：发送键与输入框同一行但不在同一容器时用
      + "function nearInput(x,y){"
      +   "var ns;try{ns=document.querySelectorAll(SEL);}catch(e){return false;}"
      +   "for(var i=0;i<ns.length;i++){"
      +     "if(!editable(ns[i])||!live(ns[i]))continue;"
      +     "var b=ns[i].getBoundingClientRect();"
      +     "if(x>=b.left-20&&x<=b.right+20&&y>=b.top-20&&y<=b.bottom+20)return true;"
      +   "}"
      +   "return false;"
      + "}"
      + "function blurNow(){var a=document.activeElement;if(editable(a)){try{a.blur();}catch(e){}}}"
      + "function blurIfIdle(){if(Date.now()-armed<ARMED)return;blurNow();}"
      + "function arm(){armed=Date.now();}"
      + "function onDown(e){"
      +   "var t=e.target,x=0,y=0;"
      +   "try{if(e.touches&&e.touches.length){x=e.touches[0].clientX;y=e.touches[0].clientY;}"
      +   "else{x=e.clientX||0;y=e.clientY||0;}}catch(e1){}"
      +   "if(inInput(t)||nearInput(x,y)){arm();return;}"
      +   "armed=0;blurNow();"                        // 点输入区以外：立刻收键盘（不等定时器）
      +   "setTimeout(blurIfIdle,0);setTimeout(blurIfIdle,180);"
      + "}"
      + "function onUp(){if(Date.now()-armed<ARMED)return;blurIfIdle();}"   // 兜底：start 丢了还有 end
      // 只"续期"不"放行"：打字中不掐键盘；SPA 自己派发的 input 打不开闸门
      + "function onInput(e){"
      +   "if(Date.now()-armed>=ARMED)return;"
      +   "if(!inInput(e.target))return;"
      +   "arm();"
      + "}"
      + "function onFocus(e){"
      +   "var t=e.target;"
      +   "if(!editable(t))return;"
      +   "if(Date.now()-armed<ARMED){try{fights.delete(t);}catch(e3){}return;}"
      +   "var now=Date.now(),rec=fights.get(t);"
      +   "if(!rec||now-rec.t0>1000)rec={n:0,t0:now};"
      +   "rec.n++;fights.set(t,rec);"
      +   "if(rec.n>3)return;"                        // 同一元素 1s 内被拦 4 次=自打架，放它自己
      +   "try{t.blur();}catch(e2){}"
      + "}"
      + "document.addEventListener('touchstart',onDown,true);"
      + "document.addEventListener('pointerdown',onDown,true);"
      + "document.addEventListener('mousedown',onDown,true);"
      + "document.addEventListener('touchend',onUp,true);"
      + "document.addEventListener('focusin',onFocus,true);"
      + "document.addEventListener('keydown',onInput,true);"
      + "document.addEventListener('input',onInput,true);"
      + "setTimeout(blurIfIdle,0);setTimeout(blurIfIdle,300);setTimeout(blurIfIdle,1000);"
      + "}catch(e){}})();";
}
