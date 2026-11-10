package com.myco.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;

/**
 * TunnelProcessService — 独立进程承载 myco vnet 的 RDP/DSH 数据面。
 *
 * 设计动机（2026-10-26 真机实测）：
 *  - 主进程在 Honor 上退后台后会被厂商整进程冻结（isFrozen=true、schedstat 停止），
 *    即使 KeepAliveService 已是 specialUse 前台服务也无法保证持续调度。
 *  - 把 RDP 隧道放到独立进程后，主进程冻结不再影响数据面。
 *
 * 通信方式：
 *  - 主进程通过 SharedPreferences 写入 arm/disarm 请求，再 startService 触发本服务。
 *  - 本服务在同一包内独立进程运行，读写同一 SharedPreferences 文件。
 *  - 状态回写也走 SharedPreferences，主进程可读。
 */
public class TunnelProcessService extends Service {
    public static final String ACTION_ARM = "com.myco.phone.tunnel.ARM";
    public static final String ACTION_DISARM = "com.myco.phone.tunnel.DISARM";
    public static final String EXTRA_ARM_JSON = "com.myco.phone.tunnel.EXTRA_ARM_JSON";
    public static final String EXTRA_LOCAL_PORT = "com.myco.phone.tunnel.EXTRA_LOCAL_PORT";
    public static final String PREFS_NAME = "myco_tunnel_process";
    public static final String KEY_STATE_JSON = "state_json";
    public static final String STATE_FILE_NAME = "tunnel-state.json";
    public static final String CHANNEL_ID = "myco_tunnel_process";

    private android.os.PowerManager.WakeLock wakeLock;
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private Thread stateWriter;
    /** 周期 writeState 也要保留的诊断字段；只在后续明确成功/新操作时更新。 */
    private volatile Boolean securePersisted;
    private volatile String securePersistError;
    private volatile String restoreErrors;

    @Override
    public void onCreate() {
        super.onCreate();
        // 2026-10-26：服务进程与主进程分开，GwLog 的 cachedDir 是进程级静态。
        // 之前本进程先以 context=null 写日志 → cachedDir 一直是 null → native-rdp
        // 的 arm/胜者/关闭原因全部静默丢失，升级后 RDP 排障只剩 PC 侧 enc-fail 噪声。
        // onCreate 先用本服务 Context 初始化一次，后续 NativeRdpTunnel/ForwardListener
        // 的 null 日志才能落到同一个 gw-net.log。
        GwLog.note(this, "tunnel-service onCreate（日志上下文已初始化）");
        startForegroundWithNotification();
        acquireLocks();
        // 进程创建即恢复，而不是只等空 intent：系统重拉、显式启动和后续新 arm
        // 都先恢复既有配置与监听；无记录时是零成本 no-op。
        restoreArms();
        startStateWriter();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : "";
        GwLog.note(this, "tunnel-service onStart action=" + action);
        if (ACTION_ARM.equals(action)) {
            handleArm(intent);
        } else if (ACTION_DISARM.equals(action)) {
            handleDisarm(intent);
        }
        return START_STICKY;
    }

    private void handleArm(Intent intent) {
        String json = intent != null ? intent.getStringExtra(EXTRA_ARM_JSON) : null;
        if (json == null || json.isEmpty()) {
            writeState("{\"ok\":false,\"err\":\"arm_json 未写入\"}");
            return;
        }
        int localPort;
        try {
            localPort = new org.json.JSONObject(json).optInt(
                    "localPort", NativeRdpTunnel.RDP_LOCAL_PORT);
        } catch (Exception e) {
            writeState("{\"ok\":false,\"err\":\"arm JSON 解析失败\"}");
            return;
        }
        if (localPort == NativeRdpTunnel.RDP_LOCAL_PORT
                || localPort == NativeRdpTunnel.DSH_LOCAL_PORT) {
            // 重 arm 先清旧记录：若新配置应用途中进程死亡，宁可等 JS 重注，
            // 也不能让上一个已淘汰身份/路由在重启后复活。
            if (!TunnelArmStore.remove(this, localPort)) {
                writeState("{\"ok\":false,\"err\":\"旧 arm 配置删除落盘失败，拒绝覆盖\"}");
                GwLog.note(this, "tunnel-arm 旧记录删除失败，拒绝重 arm localPort=" + localPort);
                return;
            }
        }
        String result = NativeRdpTunnel.arm(json);
        // arm 必须“配置合法 + 本地监听成功”才算成功；否则不落盘、不报 ready。
        try {
            if (localPort == NativeRdpTunnel.RDP_LOCAL_PORT
                    || localPort == NativeRdpTunnel.DSH_LOCAL_PORT) {
                if (!new org.json.JSONObject(result).optBoolean("ok", false)) {
                    writeState(result);
                    return;
                }
                // 2026-11-05 vnet 本地回环模式（目标②）：开了 vnet 且 arm 成功，
                // 本地口直接交给 libvnet（数据面不过 JS/Java 加密泵）；
                // 失败立即回落 ForwardListener + NativeRdpTunnel 老路径，绝不白屏。
                boolean wantVnet = VnetTransport.isEnabled()
                        || new org.json.JSONObject(json).optBoolean("vnetTransport", false);
                if (wantVnet) {
                    String vnetResult = VnetTransport.arm(json, this);
                    if (new org.json.JSONObject(vnetResult).optBoolean("ok", false)) {
                        GwLog.note(this, "tunnel-service vnet 数据面接管 :" + localPort);
                        try {
                            TunnelArmStore.save(this, localPort, json);
                            securePersisted = true;
                            securePersistError = null;
                            restoreErrors = null;
                            NativePresence.ensureFromJson(json);
                            writeState(new org.json.JSONObject(result)
                                    .put("transport", "vnet")
                                    .put("securePersisted", true).put("listening", true).toString());
                        } catch (Exception e) {
                            securePersisted = false;
                            securePersistError = "arm 加密保存失败";
                            writeState(new org.json.JSONObject(result)
                                    .put("transport", "vnet")
                                    .put("securePersisted", false).put("listening", true).toString());
                        }
                        return;
                    }
                    GwLog.note(this, "tunnel-service vnet 接管失败回落 legacy :" + localPort + " " + vnetResult);
                }
                String listenResult = ForwardListener.start(localPort);
                boolean listening = new org.json.JSONObject(listenResult).optBoolean("ok", false);
                if (!listening) {
                    NativeRdpTunnel.disarm(localPort);
                    String err = "arm 配置合法但 listener 绑定失败：" + listenResult;
                    GwLog.note(this, "tunnel-service " + err);
                    securePersisted = false;
                    securePersistError = err;
                    writeState(new org.json.JSONObject(result)
                            .put("ok", false).put("err", err).toString());
                    return;
                }
                // 配置与监听都成功后，才保存用于 START_STICKY 的恢复记录。
                try {
                    TunnelArmStore.save(this, localPort, json);
                    securePersisted = true;
                    securePersistError = null;
                    restoreErrors = null;
                    // 成员设备 presence 也归 :tunnel 自治；JS 冻结不再导致云名册离线。
                    NativePresence.ensureFromJson(json);
                    writeState(new org.json.JSONObject(result)
                            .put("securePersisted", true).put("listening", true).toString());
                } catch (Exception e) {
                    GwLog.note(this, "tunnel-arm 加密保存失败 localPort=" + localPort + "（重拉后需 JS 重注）: " + e);
                    securePersisted = false;
                    securePersistError = "arm 加密保存失败";
                    writeState(new org.json.JSONObject(result)
                            .put("securePersisted", false).put("listening", true).toString());
                }
            } else {
                writeState(result);
            }
        } catch (Exception e) {
            GwLog.note(this, "tunnel-service arm 后处理失败: " + e);
            writeState("{\"ok\":false,\"err\":\"arm 后处理失败\"}");
        }
    }

    /** 空 intent 重拉恢复：逐条解密并复用现有 arm 校验，成功后才启动监听。 */
    private void restoreArms() {
        java.util.Map<Integer, String> saved = TunnelArmStore.loadAll(this);
        java.util.List<String> restoreErrors = new java.util.ArrayList<String>();
        this.restoreErrors = null;
        GwLog.note(this, "tunnel-service 原生恢复 arm 记录=" + saved.size());
        GwLog.note(this, "native-restore count=" + saved.size());
        for (java.util.Map.Entry<Integer, String> e : saved.entrySet()) {
            int localPort = e.getKey();
            if (localPort != NativeRdpTunnel.RDP_LOCAL_PORT
                    && localPort != NativeRdpTunnel.DSH_LOCAL_PORT) continue;
            try {
                String result = NativeRdpTunnel.arm(e.getValue());
                if (new org.json.JSONObject(result).optBoolean("ok", false)) {
                    // vnet 回环恢复：优先 libvnet 接管本地口，失败回落 ForwardListener。
                    boolean wantVnet = VnetTransport.isEnabled()
                            || new org.json.JSONObject(e.getValue()).optBoolean("vnetTransport", false);
                    if (wantVnet) {
                        String vr = VnetTransport.arm(e.getValue(), this);
                        if (new org.json.JSONObject(vr).optBoolean("ok", false)) {
                            GwLog.note(this, "tunnel-service vnet 原生恢复 localPort=" + localPort);
                            NativePresence.ensureFromJson(e.getValue());
                            continue;
                        }
                        GwLog.note(this, "tunnel-service vnet 恢复失败回落 legacy localPort=" + localPort + " " + vr);
                    }
                    String listenResult = ForwardListener.start(localPort);
                    if (new org.json.JSONObject(listenResult).optBoolean("ok", false)) {
                        GwLog.note(this, "tunnel-service 已原生恢复 localPort=" + localPort);
                        GwLog.note(this, "native-restore ok localPort=" + localPort);
                        NativePresence.ensureFromJson(e.getValue());
                    } else {
                        // 配置和监听是两件事：bind 失败不得记“已恢复”，也不得留下
                        // CFG armed 但无 listener 的假状态。加密记录保留，供下次重拉再试。
                        NativeRdpTunnel.disarm(localPort);
                        restoreErrors.add(localPort + ":listener:" + listenResult);
                        GwLog.note(this, "tunnel-service arm 已恢复但 listener 失败 localPort=" + localPort + " " + listenResult);
                    }
                } else {
                    restoreErrors.add(localPort + ":arm:" + result);
                    GwLog.note(this, "tunnel-service 恢复 arm 被拒 localPort=" + localPort + " " + result);
                }
            } catch (Exception ex) {
                restoreErrors.add(localPort + ":exception:" + ex);
                GwLog.note(this, "tunnel-service 恢复 arm 异常 localPort=" + localPort + ": " + ex);
            }
        }
        String state = NativeRdpTunnel.state();
        this.restoreErrors = restoreErrors.isEmpty() ? null : String.join(" | ", restoreErrors);
        try {
            if (!restoreErrors.isEmpty()) {
                state = new org.json.JSONObject(state)
                        .put("restoreErrors", new org.json.JSONArray(restoreErrors)).toString();
            }
        } catch (Exception ignored) { }
        writeState(state);
    }

    private void handleDisarm(Intent intent) {
        int localPort = intent != null ? intent.getIntExtra(EXTRA_LOCAL_PORT, 0) : 0;
        String persistErr = null;
        if (localPort == NativeRdpTunnel.RDP_LOCAL_PORT
                || localPort == NativeRdpTunnel.DSH_LOCAL_PORT) {
            // 撤权记录先删，再停隧道；删除失败必须显式留证，不能报“撤权已持久化”。
            if (!TunnelArmStore.remove(this, localPort)) {
                persistErr = "撤权记录删除落盘失败";
                GwLog.note(this, "tunnel-arm 撤权删除落盘失败 localPort=" + localPort + "（当前进程仍强制 disarm）");
            }
            NativeRdpTunnel.disarm(localPort);
            ForwardListener.stop(localPort);
            VnetTransport.disarm();
        } else {
            if (!TunnelArmStore.clear(this)) {
                persistErr = "全部撤权记录删除落盘失败";
                GwLog.note(this, "tunnel-arm 全部撤权删除落盘失败（当前进程仍强制 disarmAll）");
            }
            NativeRdpTunnel.disarmAll();
            ForwardListener.stop(NativeRdpTunnel.RDP_LOCAL_PORT);
            ForwardListener.stop(NativeRdpTunnel.DSH_LOCAL_PORT);
            VnetTransport.disarm();
        }
        if (!NativeRdpTunnel.hasArmed()) NativePresence.stop();
        String state = NativeRdpTunnel.state();
        securePersistError = persistErr;
        if (persistErr == null) securePersisted = false;
        restoreErrors = null;
        try {
            if (persistErr != null) {
                state = new org.json.JSONObject(state).put("securePersistError", persistErr).toString();
            }
        } catch (Exception ignored) { }
        writeState(state);
    }

    private void writeState(String json) {
        String safe = json == null ? "" : json;
        // 周期状态刷新必须带上持续性诊断，不能每秒把一次性错误重新覆盖成 ok:true。
        try {
            org.json.JSONObject o = new org.json.JSONObject(safe);
            if (securePersisted != null) o.put("securePersisted", securePersisted.booleanValue());
            if (securePersistError != null) o.put("securePersistError", securePersistError);
            if (restoreErrors != null) o.put("restoreErrors", restoreErrors);
            safe = o.toString();
        } catch (Exception ignored) { }
        // 2026-10-26：SharedPreferences 是进程内缓存，主进程读 `:tunnel` 进程写入
        // 会拿到旧值（真机 streams armed 但 conns/opened 全 0）。状态文件用原子替换，
        // 供 MycoShell.vnetRdpState() 按次直读；prefs 只留兼容兜底。
        try {
            java.io.File dir = getExternalFilesDir(null);
            if (dir != null) {
                java.io.File out = new java.io.File(dir, STATE_FILE_NAME);
                java.io.File tmp = new java.io.File(dir, STATE_FILE_NAME + ".tmp");
                java.io.FileOutputStream os = new java.io.FileOutputStream(tmp, false);
                os.write(safe.getBytes("UTF-8"));
                os.flush();
                os.getFD().sync();
                os.close();
                if (!tmp.renameTo(out)) {
                    java.io.FileOutputStream direct = new java.io.FileOutputStream(out, false);
                    direct.write(safe.getBytes("UTF-8"));
                    direct.flush();
                    direct.getFD().sync();
                    direct.close();
                    tmp.delete();
                }
            }
        } catch (Throwable ignored) {
        }
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        prefs.edit().putString(KEY_STATE_JSON, safe).apply();
    }

    /** 主进程读 `:tunnel` 状态：优先原子文件，失败回落 SharedPreferences。 */
    static String readState(Context ctx) {
        try {
            java.io.File dir = ctx.getExternalFilesDir(null);
            if (dir != null) {
                java.io.File f = new java.io.File(dir, STATE_FILE_NAME);
                if (f.isFile() && f.length() > 0) {
                    java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                    java.io.FileInputStream is = new java.io.FileInputStream(f);
                    byte[] buf = new byte[4096];
                    for (int n; (n = is.read(buf)) > 0; ) b.write(buf, 0, n);
                    is.close();
                    String s = new String(b.toByteArray(), "UTF-8").trim();
                    if (!s.isEmpty()) return s;
                }
            }
        } catch (Throwable ignored) {
        }
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String s = prefs.getString(KEY_STATE_JSON, "");
        return s == null ? "" : s;
    }

    private void startStateWriter() {
        if (stateWriter != null) return;
        stateWriter = new Thread(() -> {
            int ticks = 0;
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException e) {
                    break;
                }
                try {
                    ticks++;
                    writeState(NativeRdpTunnel.state());
                    // tick 必须在 :tunnel 进程打；主进程静态 CFG 永远为空，会误报 armed=[]。
                    if ((ticks % 32) == 0) NativeRdpTunnel.tick();
                } catch (Throwable ignored) {
                }
            }
        }, "myco-tunnel-state-writer");
        stateWriter.setDaemon(true);
        stateWriter.start();
    }

    private void startForegroundWithNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "RDP/DSH 隧道服务", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持远程桌面与 DSH 数据连接");
            nm.createNotificationChannel(channel);
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle("myco RDP/DSH 隧道")
                .setContentText("远程桌面与 DSH 数据通道保持中")
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true);
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startForeground(2, builder.build(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } catch (Throwable ignored) {
                startForeground(2, builder.build());
            }
        } else {
            startForeground(2, builder.build());
        }
    }

    private void acquireLocks() {
        try {
            android.os.PowerManager pm = getSystemService(android.os.PowerManager.class);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "myco:tunnel_process");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire();
            }
        } catch (Throwable ignored) {
        }
        try {
            android.net.wifi.WifiManager wm = getSystemService(android.net.wifi.WifiManager.class);
            if (wm != null) {
                wifiLock = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "myco:tunnel_process_wifi");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onDestroy() {
        NativePresence.stop();
        if (stateWriter != null) {
            stateWriter.interrupt();
            stateWriter = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
