/**
 * native-rdp-crypto-live.test.ts — **现场重算版**跨实现对拍（2026-10-26 RDP 原生化）。
 *
 * 与 `native-rdp-crypto.test.ts`（冻结向量版）互补：
 *   · 冻结向量版：断言 TS noble ≡ 历史 Java 输出（常量锚点，任何机器可跑）；
 *   · 本文件：**当场编译并运行** `eval/vnetfix/TunnelProtoTest.java`，把 Java 的
 *     RESULT 向量与 TS `p2p-tunnel.ts`（noble）现算值逐字节比对——Java 侧任何
 *     协议漂移（改帧布局/改 KDF/换实现）都会当场红，不依赖手工更新常量。
 * 两者叠加 = Java ≡ noble ≡ Rust（PC 端，noble 与 dalek 的对拍在 p2p-tunnel.test.ts）。
 *
 * 环境无 JDK（Android Studio JBR / JAVA_HOME / PATH 都没有）→ 整套跳过，不红。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { x25519, ed25519 } from '@noble/curves/ed25519.js'
import {
  FrameIo,
  buildTunnelHandshake,
  deriveSessionKeys,
  nonceFor,
  toHex,
  toB64,
  tunnelSignMaterial,
  tunnelAuthHeader,
} from './p2p-tunnel'

const ALICE_PRIV = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'
const ALICE_PUB = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'
const BOB_PUB = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'
const ACCOUNT = 'did:youling:zTestAccount'
const DEVICE = 'did:myco:zTestDevice'
const NONCE = 'tn-fixednonce0123456789abcdef'
const TS_MS = 1730000000000
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const fromHex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/.{2}/g) ?? []).map((h) => Number.parseInt(h, 16)))

function findJdk(): { javac: string; java: string } | null {
  const cands: string[] = []
  if (process.env.MYCO_JBR) cands.push(process.env.MYCO_JBR)
  cands.push('D:\\Program Files\\Android\\Android Studio\\jbr\\bin')
  if (process.env.JAVA_HOME) cands.push(join(process.env.JAVA_HOME, 'bin'))
  for (const dir of cands) {
    if (existsSync(join(dir, 'javac.exe')) && existsSync(join(dir, 'java.exe'))) {
      return { javac: join(dir, 'javac.exe'), java: join(dir, 'java.exe') }
    }
  }
  try {
    execFileSync('javac', ['-version'], { stdio: 'pipe' })
    return { javac: 'javac', java: 'java' }
  } catch {
    return null
  }
}

function runJavaVectors(): Record<string, string> | null {
  const jdk = findJdk()
  if (!jdk) return null
  const here = fileURLToPath(new URL('.', import.meta.url))
  const repoRoot = join(here, '..', '..', '..')
  const testDir = join(repoRoot, 'eval', 'vnetfix')
  if (!existsSync(join(testDir, 'TunnelProtoTest.java'))) return null
  const outDir = join(testDir, 'out')
  mkdirSync(outDir, { recursive: true })
  execFileSync(
    jdk.javac,
    [
      '-encoding', 'UTF-8',
      '-d', outDir,
      '-sourcepath', `${join(repoRoot, 'apps', 'android-shell', 'src')};${testDir}`,
      join(testDir, 'TunnelProtoTest.java'),
    ],
    { stdio: 'pipe' },
  )
  const stdout = execFileSync(jdk.java, ['-cp', outDir, 'TunnelProtoTest'], {
    stdio: 'pipe',
    encoding: 'utf8',
  })
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
  if (!line) throw new Error('Java 向量测试没打出 RESULT 行（自身断言可能已失败）:\n' + stdout.slice(-2000))
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, string>
}

const jv = runJavaVectors()

describe('Java 原生 RDP 数据面现场对拍（重编译重跑）', () => {
  it('X25519 共享秘密', () => {
    if (!jv) return
    expect(toHex(x25519.getSharedSecret(fromHex(ALICE_PRIV), fromHex(BOB_PUB)))).toBe(jv['x25519Shared'])
  })

  it('握手信封原文 / 会话密钥五段 / CONFIRM 帧', () => {
    if (!jv) return
    const raw = buildTunnelHandshake(ACCOUNT, DEVICE, DEVICE, 3389, NONCE)
    expect(raw).toBe(jv['handshakeRaw'])
    const keys = deriveSessionKeys(
      x25519.getSharedSecret(fromHex(ALICE_PRIV), fromHex(BOB_PUB)),
      fromHex(ALICE_PUB),
      fromHex(BOB_PUB),
      raw,
    )
    expect(toHex(keys.c2s)).toBe(jv['c2s'])
    expect(toHex(keys.s2c)).toBe(jv['s2c'])
    expect(toHex(keys.prefix)).toBe(jv['prefix'])
    expect(toHex(keys.confirmC2s)).toBe(jv['confirmC2s'])
    expect(toHex(keys.confirmS2c)).toBe(jv['confirmS2c'])
    const io = new FrameIo(keys, 'originator', raw)
    expect(toHex(io.confirmFrame())).toBe(jv['confirmFrame'])
  })

  it('DATA 帧连续 seal（seq/nonce/prefix/GCM）+ nonceFor', () => {
    if (!jv) return
    const keys = deriveSessionKeys(
      x25519.getSharedSecret(fromHex(ALICE_PRIV), fromHex(BOB_PUB)),
      fromHex(ALICE_PUB),
      fromHex(BOB_PUB),
      jv['handshakeRaw'],
    )
    const io = new FrameIo(keys, 'originator', jv['handshakeRaw'])
    expect(toHex(io.seal(utf8('RDP native test message #1')))).toBe(jv['frame1'])
    expect(toHex(io.seal(new Uint8Array(64)))).toBe(jv['frame2'])
    expect(toHex(io.seal(new Uint8Array(1000)))).toBe(jv['frame3'])
    const io2 = new FrameIo(keys, 'originator', jv['handshakeRaw'])
    io2.seal(utf8('RDP native test message #1'))
    io2.seal(new Uint8Array(64))
    io2.seal(new Uint8Array(1000))
    io2.seal(utf8('tamper'))
    expect(toHex(io2.seal(utf8('prefix')))).toBe(jv['frame6'])
    const prefix = fromHex(jv['prefix'])
    expect(toHex(nonceFor(prefix, 0n))).toBe(jv['nonce0'])
    expect(toHex(nonceFor(prefix, 1n))).toBe(jv['nonce1'])
    expect(toHex(nonceFor(prefix, 0xdeadbeefcafebaben))).toBe(jv['nonceDead'])
  })

  it('Ed25519：同值签名 + noble 能验 Java 的签名（互认）', () => {
    if (!jv) return
    const seed = fromHex(ALICE_PRIV)
    expect(toHex(ed25519.getPublicKey(seed))).toBe(jv['edPub'])
    const material = tunnelSignMaterial(DEVICE, TS_MS, jv['handshakeRaw'])
    const sig = ed25519.sign(utf8(material), seed)
    expect(toB64(sig)).toBe(jv['edSigB64'])
    expect(ed25519.verify(fromHex(jv['edSigHex']), utf8(material), ed25519.getPublicKey(seed))).toBe(true)
    expect(tunnelAuthHeader(DEVICE, TS_MS, toB64(sig))).toBe(jv['authHeader'])
  })

  it('base64 同表', () => {
    if (!jv) return
    const seq = new Uint8Array(64)
    for (let i = 0; i < 64; i++) seq[i] = i
    expect(toB64(seq)).toBe(jv['b64Seq'])
  })
})
