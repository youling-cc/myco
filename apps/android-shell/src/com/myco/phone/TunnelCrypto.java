package com.myco.phone;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * TunnelCrypto — 手机侧 P2P 隧道 v2 线协议的**原生子层**（2026-10-26 RDP 原生化）。
 *
 * 权威来源逐字节对齐：
 *   · JS：`apps/phone/src/p2p-tunnel.ts`（deriveSessionKeys / nonceFor / buildTunnelHandshake）
 *   · Rust：`apps/home/src-tauri/src/p2p_tunnel.rs`（PC 对端，SessionKeys::derive / nonce_for）
 * 对齐锚点：`eval/vnetfix/TunnelProtoTest.java` + `apps/phone/src/native-rdp-crypto.test.ts`
 * （RFC 7748/5869/4231/8032 向量 + 与 JS noble 实现的全链对拍）。
 *
 * ── 为什么手机要再实现一份 ─────────────────────────────────────────────────
 * WebView JS 在荣耀等机型上一退后台（外部 RDP App 切前台）就被冻结，整条隧道停摆
 * （0.3.175 A/B 实测定案）。RDP 数据面（23389→对端 3389）必须搬到原生线程，
 * 不再依赖 WebView 活性——X25519/AES-GCM/帧编解码都得在 Java 里跑。
 *
 * ── 实现选型（零第三方依赖，minSdk 24） ────────────────────────────────────
 *   · AES-256-GCM：javax.crypto（API 19+ 就有，系统原生实现，快）。
 *   · HMAC-SHA256 / SHA-256：javax.crypto / java.security（同理）。
 *   · X25519：系统 KeyAgreement("XDH") 要 API 31+，minSdk 24 不够——这里用
 *     BigInteger 按 RFC 7748 §5 的 Montgomery ladder 纯 Java 实现。临时钥每连接
 *     一次，性能（~ms 级）与侧信道要求都够（ BigInteger 非常量时间，与 noble/
 *     dalek 不同——本机自算自己的钥，可接受；记录在案）。
 *   · Ed25519（签名，NativeRdpTunnel 用）：见 {@link Ed25519}。
 *
 * 本文件**只用 java./javax.**（不 import android.*）——可以直接在桌面 JVM 上跑单测。
 * 线程模型：纯函数 + 无共享可变状态，线程安全。
 */
public class TunnelCrypto {

    // ══════════════════ 帧常量（与 JS/Rust 同名同值） ══════════════════

    /** 帧魔数 "MET2"。 */
    public static final byte[] FRAME_MAGIC = {0x4d, 0x45, 0x54, 0x32};
    /** 帧格式版本。 */
    public static final int FRAME_FORMAT_VERSION = 1;
    public static final int FRAME_HELLO = 1;
    public static final int FRAME_CONFIRM = 2;
    public static final int FRAME_DATA = 3;
    /** HELLO/CONFIRM 帧长：MAGIC(4)+ver(1)+type(1)+32B。 */
    public static final int FRAME_HELLO_LEN = 38;
    /** DATA 帧固定头：MAGIC(4)+ver(1)+type(1)+seq(8)+noncePrefix(12)。 */
    public static final int FRAME_DATA_HEADER = 26;
    /** GCM tag 长度。 */
    public static final int GCM_TAG_BITS = 128;
    /** HKDF info（域分隔标签）。 */
    public static final byte[] HKDF_INFO = utf8("myco-p2p-tunnel/v2");
    /** 隧道协议版本（握手信封 v=2）。 */
    public static final int TUNNEL_PROTOCOL_VERSION = 2;
    /** okm 总长（五段切片）。 */
    public static final int OKM_LEN = 140;
    /** 帧载荷上限（对齐 Rust FRAME_MAX_PAYLOAD）。 */
    public static final int FRAME_MAX_PAYLOAD = 1024 * 1024;

    // ══════════════════ 小工具 ══════════════════

    public static byte[] utf8(String s) {
        try {
            return s.getBytes("UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException("UTF-8 不可用", e);
        }
    }

    public static String hex(byte[] b) {
        if (b == null) return "";
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 0xf, 16))
                .append(Character.forDigit(x & 0xf, 16));
        return sb.toString();
    }

    public static byte[] fromHex(String s) {
        int n = s.length() / 2;
        byte[] out = new byte[n];
        for (int i = 0; i < n; i++) out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    /** 标准 base64（带填充，无换行；与 JS btoa / android.util.Base64.NO_WRAP 一致）。 */
    public static String b64(byte[] b) {
        final char[] A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();
        StringBuilder sb = new StringBuilder((b.length + 2) / 3 * 4);
        for (int i = 0; i < b.length; i += 3) {
            int n = (b[i] & 0xff) << 16;
            if (i + 1 < b.length) n |= (b[i + 1] & 0xff) << 8;
            if (i + 2 < b.length) n |= (b[i + 2] & 0xff);
            sb.append(A[(n >>> 18) & 63]).append(A[(n >>> 12) & 63]);
            sb.append(i + 1 < b.length ? A[(n >>> 6) & 63] : '=');
            sb.append(i + 2 < b.length ? A[n & 63] : '=');
        }
        return sb.toString();
    }

    /** base64 → 字节（容忍缺 padding；失败抛 IllegalArgumentException）。 */
    public static byte[] unb64(String s) {
        String t = s.replaceAll("[^A-Za-z0-9+/=]", "");
        // 去掉 padding 再按 4 字符块解
        while (t.endsWith("=")) t = t.substring(0, t.length() - 1);
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(t.length() * 3 / 4 + 3);
        int buf = 0, bits = 0;
        for (int i = 0; i < t.length(); i++) {
            int c = t.charAt(i);
            int v;
            if (c >= 'A' && c <= 'Z') v = c - 'A';
            else if (c >= 'a' && c <= 'z') v = c - 'a' + 26;
            else if (c >= '0' && c <= '9') v = c - '0' + 52;
            else if (c == '+') v = 62;
            else if (c == '/') v = 63;
            else throw new IllegalArgumentException("base64 非法字符");
            buf = (buf << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out.write((buf >> bits) & 0xff);
            }
        }
        return out.toByteArray();
    }

    public static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += p == null ? 0 : p.length;
        byte[] out = new byte[n];
        int off = 0;
        for (byte[] p : parts) {
            if (p == null || p.length == 0) continue;
            System.arraycopy(p, 0, out, off, p.length);
            off += p.length;
        }
        return out;
    }

    /** 定长字节比较（与 JS bytesEqual 同语义）。 */
    public static boolean bytesEqual(byte[] a, int aOff, byte[] b, int bOff, int len) {
        int d = 0;
        for (int i = 0; i < len; i++) d |= (a[aOff + i] ^ b[bOff + i]);
        return d == 0;
    }

    // ══════════════════ 摘要 / MAC / KDF ══════════════════

    public static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    public static byte[] hmacSha256(byte[] key, byte[] data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(data);
        } catch (Exception e) {
            throw new IllegalStateException("HmacSHA256 不可用", e);
        }
    }

    /**
     * HKDF-SHA256（RFC 5869；与 @noble/hashes hkdf(sha256,ikm,salt,info,len) 一致）。
     * salt 为空时用 32 字节 0（RFC 规定）——本协议 salt 恒非空。
     */
    public static byte[] hkdfSha256(byte[] ikm, byte[] salt, byte[] info, int length) {
        byte[] realSalt = (salt == null || salt.length == 0) ? new byte[32] : salt;
        byte[] prk = hmacSha256(realSalt, ikm);
        java.io.ByteArrayOutputStream okm = new java.io.ByteArrayOutputStream(length);
        byte[] t = new byte[0];
        int i = 1;
        while (okm.size() < length) {
            t = hmacSha256(prk, concat(t, info, new byte[]{(byte) i}));
            okm.write(t, 0, t.length);
            i++;
        }
        byte[] full = okm.toByteArray();
        return Arrays.copyOf(full, length);
    }

    // ══════════════════ X25519（RFC 7748，BigInteger 纯 Java） ══════════════════

    private static final BigInteger P = BigInteger.valueOf(2).pow(255).subtract(BigInteger.valueOf(19));
    private static final BigInteger A24 = BigInteger.valueOf(121665);
    private static final BigInteger U_BASE = BigInteger.valueOf(9);
    /** RFC 7748 基点 u=9 的小端 32 字节。 */
    public static final byte[] X25519_BASE = le32(U_BASE);

    /** 小端 32 字节 → 非负 BigInteger。 */
    private static BigInteger fromLe32(byte[] b) {
        BigInteger v = BigInteger.ZERO;
        for (int i = b.length - 1; i >= 0; i--) v = v.shiftLeft(8).or(BigInteger.valueOf(b[i] & 0xff));
        return v;
    }

    /** BigInteger → 定长 32 字节小端。 */
    private static byte[] le32(BigInteger v) {
        byte[] out = new byte[32];
        byte[] raw = v.toByteArray(); // 大端，可能带符号位或超长
        for (int i = 0; i < 32 && i < raw.length; i++) {
            out[i] = raw[raw.length - 1 - i];
        }
        return out;
    }

    /** 生成临时 X25519 密钥对（每次连接新建 = 前向保密；与 JS genEphemeral 同口径）。 */
    public static KeyPair genEphemeral() {
        byte[] priv = new byte[32];
        new SecureRandom().nextBytes(priv);
        return keyPair(priv);
    }

    /** 由私钥种子建对（测试注入确定性钥用）。 */
    public static KeyPair keyPair(byte[] priv32) {
        if (priv32 == null || priv32.length != 32) throw new IllegalArgumentException("X25519 私钥必须 32B");
        KeyPair kp = new KeyPair();
        kp.priv = priv32;
        kp.pub = x25519(priv32, X25519_BASE);
        return kp;
    }

    /** 临时密钥对（纯数据持有者）。 */
    public static class KeyPair {
        public byte[] priv;
        public byte[] pub;
    }

    /**
     * X25519 标量乘（RFC 7748 §5 Montgomery ladder）。
     * 输入：任意 32B 标量（内部 clamp）、任意 32B u 坐标（高位按 RFC 掩掉）。
     * 输出：32B 小端共享秘密（调用方负责全 0 检查——见 deriveSessionKeys）。
     */
    public static byte[] x25519(byte[] scalar32, byte[] u32) {
        if (scalar32 == null || scalar32.length != 32 || u32 == null || u32.length != 32) {
            throw new IllegalArgumentException("X25519 输入必须各 32B");
        }
        byte[] k = scalar32.clone();
        k[0] &= 248;
        k[31] &= 127;
        k[31] |= 64;
        BigInteger kInt = fromLe32(k);
        BigInteger u = fromLe32(u32).and(BigInteger.ONE.shiftLeft(255).subtract(BigInteger.ONE));

        BigInteger x1 = u, x2 = BigInteger.ONE, z2 = BigInteger.ZERO, x3 = u, z3 = BigInteger.ONE;
        int swap = 0;
        for (int t = 254; t >= 0; t--) {
            int kt = kInt.testBit(t) ? 1 : 0;
            swap ^= kt;
            // 条件交换（BigInteger 非常量时间——本机自算，可接受；noble 为常量时间）
            if (swap == 1) {
                BigInteger tx = x2; x2 = x3; x3 = tx;
                BigInteger tz = z2; z2 = z3; z3 = tz;
            }
            swap = kt;
            BigInteger a = x2.add(z2).mod(P);
            BigInteger aa = a.multiply(a).mod(P);
            BigInteger b = x2.subtract(z2).mod(P);
            BigInteger bb = b.multiply(b).mod(P);
            BigInteger e = aa.subtract(bb).mod(P);
            BigInteger c = x3.add(z3).mod(P);
            BigInteger d = x3.subtract(z3).mod(P);
            BigInteger da = d.multiply(a).mod(P);
            BigInteger cb = c.multiply(b).mod(P);
            x3 = da.add(cb).mod(P).pow(2).mod(P);
            z3 = x1.multiply(da.subtract(cb).mod(P).pow(2).mod(P)).mod(P);
            x2 = aa.multiply(bb).mod(P);
            z2 = e.multiply(aa.add(A24.multiply(e).mod(P)).mod(P)).mod(P);
        }
        if (swap == 1) {
            BigInteger tx = x2; x2 = x3; x3 = tx;
            BigInteger tz = z2; z2 = z3; z3 = tz;
        }
        BigInteger zInv = z2.modPow(P.subtract(BigInteger.valueOf(2)), P);
        return le32(x2.multiply(zInv).mod(P));
    }

    // ══════════════════ 会话密钥（与 JS deriveSessionKeys / Rust SessionKeys::derive 逐字节一致） ══════════════════

    /** 会话密钥材料（okm 140B 的五段切片）。纯数据持有者。 */
    public static class SessionKeys {
        public byte[] c2s = new byte[32];
        public byte[] s2c = new byte[32];
        public byte[] prefix = new byte[12];
        public byte[] confirmC2s = new byte[32];
        public byte[] confirmS2c = new byte[32];
    }

    /** 由共享秘密 + 双方临时公钥 + 握手原文派生会话密钥。全 0 共享 → 拒（key-rejected）。 */
    public static SessionKeys deriveSessionKeys(byte[] shared, byte[] ctClient, byte[] ctServer,
                                                String handshakeRaw) {
        if (shared == null || shared.length != 32) throw new FrameException("key-rejected", "ECDH 共享密钥长度异常");
        boolean allZero = true;
        for (byte b : shared) {
            if (b != 0) {
                allZero = false;
                break;
            }
        }
        if (allZero) throw new FrameException("key-rejected", "低阶公钥/非贡献行为");
        byte[] salt = sha256(concat(FRAME_MAGIC, ctClient, ctServer, utf8(handshakeRaw)));
        byte[] okm = hkdfSha256(shared, salt, HKDF_INFO, OKM_LEN);
        SessionKeys k = new SessionKeys();
        System.arraycopy(okm, 0, k.c2s, 0, 32);
        System.arraycopy(okm, 32, k.s2c, 0, 32);
        System.arraycopy(okm, 64, k.prefix, 0, 12);
        System.arraycopy(okm, 76, k.confirmC2s, 0, 32);
        System.arraycopy(okm, 108, k.confirmS2c, 0, 32);
        return k;
    }

    /** 薄封装：临时私钥 + 对端临时公钥 → 会话密钥（生产路径用）。 */
    public static SessionKeys deriveWithEcdh(byte[] myPriv, byte[] theirPub,
                                             byte[] ctClient, byte[] ctServer, String handshakeRaw) {
        return deriveSessionKeys(x25519(myPriv, theirPub), ctClient, ctServer, handshakeRaw);
    }

    // ══════════════════ AES-256-GCM（无 AAD；ct||tag 拼接，与 noble gcm 同形） ══════════════════

    public static byte[] aesGcmEncrypt(byte[] key32, byte[] nonce12, byte[] plaintext) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key32, "AES"), new GCMParameterSpec(GCM_TAG_BITS, nonce12));
            return c.doFinal(plaintext);
        } catch (Exception e) {
            throw new IllegalStateException("AES-GCM 加密失败", e);
        }
    }

    /** tag 校验失败抛 FrameException("auth-fail")。 */
    public static byte[] aesGcmDecrypt(byte[] key32, byte[] nonce12, byte[] ctAndTag) {
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key32, "AES"), new GCMParameterSpec(GCM_TAG_BITS, nonce12));
            return c.doFinal(ctAndTag);
        } catch (FrameException fe) {
            throw fe;
        } catch (Exception e) {
            throw new FrameException("auth-fail", "帧认证失败（密文被篡改）");
        }
    }

    // ══════════════════ 握手信封（与 JS buildTunnelHandshake / Rust tunnel_handshake_json 逐字节一致） ══════════════════

    /**
     * 握手信封原文：{"v":2,"port":P,"account":A,"device":D,"origin":O,"nonce":N,"cap":["resume"]}
     * 字段顺序 = serde 结构体声明顺序；紧凑 JSON（无空格）。这个字符串同时是
     * 签名载荷、HKDF salt 分量、PC 端 serde 解析输入——一处不同则全链失配。
     * cap 是加法字段：v1 对端忽略未知字段；签名与 HKDF 都使用完整原文。
     * 缺 cap 时 NativeRdpConn 仍发 METR/RESUME 会被提供端按未知帧关闭（04:09 实证）。
     */
    public static String buildTunnelHandshake(String account, String device, int port, String nonce) {
        return "{\"v\":" + TUNNEL_PROTOCOL_VERSION
                + ",\"port\":" + port
                + ",\"account\":" + jsonStr(account)
                + ",\"device\":" + jsonStr(device)
                + ",\"origin\":" + jsonStr(device)
                + ",\"nonce\":" + jsonStr(nonce)
                + ",\"cap\":[\"resume\"]}";
    }

    /** JSON 字符串字面量（与 JSON.stringify 的转义口径一致：ASCII 短转义 + 控制字符转 u00xx 形态）。 */
    public static String jsonStr(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (ch < 0x20) sb.append(String.format("\\u%04x", (int) ch));
                    else sb.append(ch);
            }
        }
        return sb.append('"').toString();
    }

    /** 签名材料：`<deviceDid>\n<tsMs>\n<握手原文>`（与 tunnelSignMaterial 一字对应）。 */
    public static String tunnelSignMaterial(String device, long tsMs, String handshakeRaw) {
        return device + "\n" + tsMs + "\n" + handshakeRaw;
    }

    /** 认证头值：`<deviceDid>.<tsMs>.<sigB64>`。 */
    public static String tunnelAuthHeader(String device, long tsMs, String sigB64) {
        return device + "." + tsMs + "." + sigB64;
    }

    /** 一次性 nonce（`tn-` + 16B 真随机的小写 hex；与 JS nextNonce 同形）。 */
    public static String nextNonce() {
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        return "tn-" + hex(b);
    }

    // ══════════════════ 帧层错误（code 与 JS FrameErrorCode 一一对应） ══════════════════

    /** 帧层错误：code 稳定（对拍/断言用），message 给人看。 */
    public static class FrameException extends RuntimeException {
        public final String code;

        public FrameException(String code, String message) {
            super(message == null || message.isEmpty() ? code : message);
            this.code = code;
        }
    }
}
