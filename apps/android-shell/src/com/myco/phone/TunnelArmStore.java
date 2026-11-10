package com.myco.phone;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * TunnelArmStore — :tunnel 服务的 arm 配置持久化（Android Keystore 加密）。
 *
 * 背景：NativeRdpTunnel 的 CFG 只在内存，TunnelProcessService 被 START_STICKY
 * 重拉后，空 intent 不会恢复监听/签名配置，只能等 WebView JS 再 arm。
 *
 * 边界：
 *  - 只保存 JS 已经下发给原生成员设备隧道的 arm JSON，不接触主账号/根设备种子；
 *  - 整段 arm JSON 用 AndroidKeyStore 内的 AES-GCM 密钥加密，成员设备种子不明文落盘；
 *  - Keystore 密钥不可导出；密文只在本应用私有 SharedPreferences 中；
 *  - 解密失败 fail-closed：跳过该条并等 JS 重注，绝不退回明文保存。
 */
public final class TunnelArmStore {
    private static final String PREFS = "myco_tunnel_arm_secure";
    private static final String KEY_ALIAS = "myco_tunnel_arm_aes_v1";
    private static final String RECORD_PREFIX = "arm_";
    private static final String FORMAT_V1 = "v1";

    private TunnelArmStore() { }

    /** 保存一条 arm 配置（调用方须先通过 NativeRdpTunnel.arm 校验）。 */
    public static synchronized void save(Context ctx, int localPort, String armJson) throws Exception {
        if (ctx == null) throw new IllegalArgumentException("context 为空");
        if (armJson == null || armJson.isEmpty()) throw new IllegalArgumentException("armJson 为空");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        // AndroidKeyStore 在 randomizedEncryptionRequired=true 时禁止调用方提供 IV；
        // 由 Keystore 在 ENCRYPT_MODE 初始化时生成，随密文记录供解密使用。
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(armJson.getBytes(StandardCharsets.UTF_8));
        String record = FORMAT_V1 + ":" + Base64.encodeToString(iv, Base64.NO_WRAP)
                + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        boolean committed = prefs(ctx).edit().putString(RECORD_PREFIX + localPort, record).commit();
        if (!committed) throw new IllegalStateException("arm 配置落盘失败");
    }

    public static synchronized boolean remove(Context ctx, int localPort) {
        if (ctx == null) return false;
        boolean committed = prefs(ctx).edit().remove(RECORD_PREFIX + localPort).commit();
        return committed && !prefs(ctx).contains(RECORD_PREFIX + localPort);
    }

    public static synchronized boolean clear(Context ctx) {
        if (ctx == null) return false;
        boolean committed = prefs(ctx).edit().clear().commit();
        return committed && prefs(ctx).getAll().isEmpty();
    }

    /**
     * 读取全部可恢复配置。返回 localPort → 原始 arm JSON；坏记录跳过并留日志。
     * 每次调用都重新解密，避免把种子再长期复制到另一个静态内存表。
     */
    public static synchronized Map<Integer, String> loadAll(Context ctx) {
        Map<Integer, String> out = new LinkedHashMap<Integer, String>();
        if (ctx == null) return out;
        for (Map.Entry<String, ?> e : prefs(ctx).getAll().entrySet()) {
            String key = e.getKey();
            if (key == null || !key.startsWith(RECORD_PREFIX)) continue;
            int port;
            try {
                port = Integer.parseInt(key.substring(RECORD_PREFIX.length()));
            } catch (Exception ex) {
                continue;
            }
            try {
                String value = String.valueOf(e.getValue());
                String[] parts = value.split(":", 3);
                if (parts.length != 3 || !FORMAT_V1.equals(parts[0])) {
                    throw new IllegalStateException("记录格式不支持");
                }
                byte[] iv = Base64.decode(parts[1], Base64.NO_WRAP);
                byte[] encrypted = Base64.decode(parts[2], Base64.NO_WRAP);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
                String json = new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
                out.put(port, json);
            } catch (Exception ex) {
                GwLog.note(null, "tunnel-arm 恢复跳过 localPort=" + port + "（Keystore/记录失效，等 JS 重注）");
            }
        }
        return out;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return (SecretKey) store.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
