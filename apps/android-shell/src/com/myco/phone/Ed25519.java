package com.myco.phone;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * Ed25519 — 纯 Java 签名器（RFC 8032 §5.1，只实现 sign + 公钥推导）。
 *
 * 为什么自己写：设备签名（`x-myco-auth` 头）必须在**原生线程**里出——WebView JS
 * 冻结时新连接也要能签（这是 RDP 数据面原生化的一部分）。而系统
 * `java.security.Signature("Ed25519")` 要 API 33+，minSdk 24 不够；也不引第三方 jar。
 *
 * 实现选型：BigInteger + RFC 8032 §5.1.4 的统一加法公式（a=-1 扭曲 Edwards 坐标，
 * 对倍加同样成立，无需单独的倍点公式）。每连接一次签名（~ms 级），性能与侧信道
 * 要求都够（非常量时间——本机签自己的消息，可接受；记录在案）。
 *
 * 与 JS noble `ed.sign(msg, seed)` / Rust ed25519-dalek 逐字节兼容（同一 RFC 8032）。
 * 对齐锚点：RFC 8032 §7.1 TEST 1..3 + `native-rdp-crypto.test.ts`（noble verify 验签）。
 *
 * 本文件只用 java.*——桌面 JVM 可直接跑单测。
 */
public class Ed25519 {

    private static final BigInteger TWO = BigInteger.valueOf(2);
    /** 素域 p = 2^255-19（与 X25519 同域）。 */
    private static final BigInteger P = TWO.pow(255).subtract(BigInteger.valueOf(19));
    /** 群阶 L = 2^252 + 27742317777372353535851937790883648493。 */
    private static final BigInteger L = TWO.pow(252)
            .add(new BigInteger("27742317777372353535851937790883648493"));
    /** d = -121665/121666 mod p。 */
    private static final BigInteger D = BigInteger.valueOf(-121665)
            .multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);
    /** 基点 B（RFC 8032 Table 1，已知常量，不必现场恢复 x）。 */
    private static final BigInteger BX = new BigInteger(
            "15112221349535400772501151409588531511454012693041857206046113283949847762202");
    private static final BigInteger BY = new BigInteger(
            "46316835694926478169428394003475163141307993866256225615783033603165251855960");

    private static byte[] sha512(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-512").digest(data);
        } catch (Exception e) {
            throw new IllegalStateException("sha512-unavailable", e);
        }
    }

    private static BigInteger leToInt(byte[] b) {
        BigInteger v = BigInteger.ZERO;
        for (int i = b.length - 1; i >= 0; i--) v = v.shiftLeft(8).or(BigInteger.valueOf(b[i] & 0xff));
        return v;
    }

    private static byte[] intToLe32(BigInteger v) {
        byte[] out = new byte[32];
        byte[] raw = v.toByteArray();
        for (int i = 0; i < 32 && i < raw.length; i++) out[i] = raw[raw.length - 1 - i];
        return out;
    }

    /** 扭曲 Edwards 点（扩展齐次坐标 X:Y:Z:T；仿射 = (X/Z, Y/Z)）。纯数据持有者。 */
    private static class Point {
        BigInteger x, y, z, t;

        static Point identity() {
            Point p = new Point();
            p.x = BigInteger.ZERO;
            p.y = BigInteger.ONE;
            p.z = BigInteger.ONE;
            p.t = BigInteger.ZERO;
            return p;
        }

        /** RFC 8032 §5.1.4 统一加法（对任意两点成立，含倍加）。 */
        Point add(Point q) {
            Point r = new Point();
            BigInteger a = this.y.subtract(this.x).mod(P).multiply(q.y.subtract(q.x).mod(P)).mod(P);
            BigInteger b = this.y.add(this.x).mod(P).multiply(q.y.add(q.x).mod(P)).mod(P);
            BigInteger c = TWO.multiply(this.t).mod(P).multiply(q.t).mod(P).multiply(D).mod(P);
            BigInteger d = TWO.multiply(this.z).mod(P).multiply(q.z).mod(P);
            BigInteger e = b.subtract(a).mod(P);
            BigInteger f = d.subtract(c).mod(P);
            BigInteger g = d.add(c).mod(P);
            BigInteger h = b.add(a).mod(P);
            r.x = e.multiply(f).mod(P);
            r.y = g.multiply(h).mod(P);
            r.t = e.multiply(h).mod(P);
            r.z = f.multiply(g).mod(P);
            return r;
        }

        /** 标量乘（简单倍加，MSB→LSB；签名场景不需常量时间）。 */
        Point mul(BigInteger k) {
            Point acc = identity();
            Point add = this;
            int bits = k.bitLength();
            for (int i = 0; i < bits; i++) {
                if (k.testBit(i)) acc = acc.add(add);
                add = add.add(add);
            }
            return acc;
        }

        /** 点编码：LE(y) 且最高位 = x 的奇偶（RFC 8032 §5.1.2）。 */
        byte[] encode() {
            BigInteger zInv = z.modPow(P.subtract(TWO), P);
            BigInteger xAff = x.multiply(zInv).mod(P);
            BigInteger yAff = y.multiply(zInv).mod(P);
            byte[] out = intToLe32(yAff);
            out[31] = (byte) ((out[31] & 0x7f) | (xAff.testBit(0) ? 0x80 : 0x00));
            return out;
        }
    }

    private static Point basePoint() {
        Point b = new Point();
        b.x = BX;
        b.y = BY;
        b.z = BigInteger.ONE;
        b.t = BX.multiply(BY).mod(P);
        return b;
    }

    /** 由 32B 种子推导公钥（= noble ed.getPublicKey(seed)）。 */
    public static byte[] publicKey(byte[] seed32) {
        checkSeed(seed32);
        byte[] h = sha512(seed32);
        return basePoint().mul(leToInt(expandSeed(h))).encode();
    }

    /** RFC 8032 签名：返回 64B R||S（= noble ed.sign(msg, seed)）。 */
    public static byte[] sign(byte[] seed32, byte[] msg) {
        checkSeed(seed32);
        byte[] h = sha512(seed32);
        BigInteger s = leToInt(expandSeed(h));
        byte[] prefix = Arrays.copyOfRange(h, 32, 64);

        byte[] aEnc = publicKey(seed32);
        BigInteger r = leToInt(sha512(TunnelCrypto.concat(prefix, msg))).mod(L);
        byte[] rEnc = basePoint().mul(r).encode();
        BigInteger k = leToInt(sha512(TunnelCrypto.concat(rEnc, aEnc, msg))).mod(L);
        BigInteger bigS = r.add(k.multiply(s)).mod(L);
        return TunnelCrypto.concat(rEnc, intToLe32(bigS));
    }

    /** 种子哈希 → clamp 后的标量字节（h[0]&=248; h[31]&=127; h[31]|=64）。 */
    private static byte[] expandSeed(byte[] h) {
        byte[] s = Arrays.copyOfRange(h, 0, 32);
        s[0] &= 248;
        s[31] &= 127;
        s[31] |= 64;
        return s;
    }

    private static void checkSeed(byte[] seed) {
        if (seed == null || seed.length != 32) {
            throw new IllegalArgumentException("Ed25519 seed must be 32B");
        }
    }
}
