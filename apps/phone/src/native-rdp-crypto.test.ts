/**
 * native-rdp-crypto.test.ts — Java 原生隧道层与 TS noble 实现的跨实现对拍。
 *
 * 向量来源：`eval/vnetfix/TunnelProtoTest.java` 在桌面 JVM 上跑出的 RESULT 行
 * （RFC 向量 + 固定握手/签名/帧）。任何一端协议漂移都会在这里红。
 */
import { describe, expect, it } from 'vitest'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import {
  FrameIo,
  buildTunnelHandshake,
  deriveSessionKeys,
  fromB64,
  helloFrame,
  nonceFor,
  parseHello,
  toHex,
  tunnelAuthHeader,
  tunnelSignMaterial,
} from './p2p-tunnel'

const ALICE_PRIV_HEX = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'
const ALICE_PUB_HEX = '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'
const BOB_PUB_HEX = 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f'
const SHARED_HEX = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742"
const HANDSHAKE_RAW = "{\"v\":2,\"port\":3389,\"account\":\"did:youling:zTestAccount\",\"device\":\"did:myco:zTestDevice\",\"origin\":\"did:myco:zTestDevice\",\"nonce\":\"tn-fixednonce0123456789abcdef\",\"cap\":[\"resume\"]}"
const C2S = "d35404f4ba45d847b4abd39d99ad410555c3406108d6b98d9ba488097a0b95e7"
const S2C = "525637085ad0bc32998a8184c5f7bf72d853b173bc78dcf27b61a9b1154fab05"
const PREFIX = "9a1a6ef035d6367c95dde999"
const CONFIRM_C2S = "83a1344498eb8b29bb26955b14f7f7eb152f733494823bc595d01e60e57c1e4d"
const CONFIRM_S2C = "84dd268518dd1edfeec6a73b1e5229378b444c40e8273fcd6932cbda58c4548e"
const CONFIRM_FRAME = "4d4554320102408c39630b973c961738ac08547c21bd9b367c54afc3d63943e607059ae5c659"
const FRAME1 = "4d455432010300000000000000009a1a6ef035d6367c95dde999d97da82c37115c3a4b06496dca08c6a15baa4dd6168394e5f202cbab0db3d3ecdbcd0d1ae887e7b21ded"
const FRAME2 = "4d455432010300000000000000019a1a6ef035d6367c95dde9992391eb1ee408f6caafe1b5d9a324dcad8a491d3e7820b50318606eeb74e2a93a8af812c7c7a46db1b6591f4b407c558446ac9636afd6965446d7bef31e3ea325d52ca29d8402501e8427b11bcb12350f"
const FRAME3 = "4d455432010300000000000000029a1a6ef035d6367c95dde99911c543de9a6ebd26e7be558454ba3808f78aa04d7a7152cf34ca9deda9b2553b95f7bc78420287c785891d011a98a29a3ef04e4974b852100f435a7ae4eacaaab802c797f91598df9d9ac4a1e0d92d2d99eea6385a6e5f43604e7aabf7455280cd5b056715e60612d9ec0eb1ad58304483e5241cb22bccf9e0aa5d960c7c6eed954f5d4331dfd98b13f78db9f1fd2ffc571cdc78e7d02f94ccdaf7d99d778516638d28220d8a141c9f8bae5d360b7c96186075497426b666b2f09f393940959e67785d2f9c5f1e1bd5548eb010458236a65b3bd0ec5a158a49d5a956f43eba37db679f49257afd5e497fec1a6529509b842a18ff93ad26aa13017379593ea6947bce98b61f493de686bcc21800885767d3be13d5bc73ea7569aff3260bf9abd07ee504c641139d452bd73788ed589541c684762ecde0cb3f9734a3d5cc3ddd74d28df488d06dc700606eca79b48d1aa13dd8031ac81e9e28f039314d8c99fe5f03f4dac0c82ad83f2ea35eb764cf2272ee7c85aec9e27d47ebd7fa2ceb3b727544b6a3a215ff7f1a1aade176bce21578008a8fea305d9844ca9a4b60ecbae62312d8e72afe3b3fd0eed32fd05adfcb5fbc2069dbfc0d016bb9c1e32e74d833c46f4143a6a7020e4b1fc9a247f94962e7edc5318191fe3d9532ea16ec4b1d329eb4cb0ccc98c9c60a35866d83c47773af660639ad0fb59dce94ffc751e31453f893d10897800986f7feb61f7d7bd080a5fd031366fbae4a782b59b06be5b932f804a587b5d4e94c9c7850b3b5321590c6073de8adec4c6213d6cbe594cb76e607d406672c9f32cb4722b49e9e77c4b7f9a7c8ed72ec517a43fe6f65a7c3def418d38ae66fb87e21a2cfdc8dec5b50ac2a5932703d1004dd7be5d9c4c284c88b045b817e8d6dd6233749f4ae3f1bcd680690462f1f02f3790c779cb30ebe1659990b764c0b96a129ecdb76bbb31028b415cdab7911ccb5a747989bf47a3f42f94061e3e34a0236e1aa0bdd595fa1f464021f3226ea579362abaec47d1e091b21bcef5b2b0b6d579dc2b819200533d45c60d78cfc64472a466307c657aa9364e679075eaf63ca0d20a40323d70db4da70fe8e6208dbc628f5b2f2781bca8992728b861e9aa5acf2e40c7c689d21f5e4fe573abbcff77810e470a98bcc771730c07a5c2d4c87d67e06f66f0ae3e21db50d16ca8dc22a7196d863e46c1554316ee162df94bdec68eed881d3f77d20113c06e0b40a14628713dbf6e4dd33a15a3f065d065d7f64d7438af65404ed02e4382d96c7812dd21159ad062f3b917a62dbf87a9ed5b481c1a434b132d9af83cf2dd1467b35c2df8d1b71fb068fe76aefbe705ef621c5dd53bb5d010ec6ecb6e5adb162c3d6035dfd46fdae4c2b9803a7dc248882dd220c45a04bd8beee4962fb121f7c1c9e54e14c48f63f"
const FRAME6 = "4d455432010300000000000000049a1a6ef035d6367c95dde9999b828a25ed33b3bfbb209eef44d248284a460e5f034d"
const NONCE0 = "9a1a6ef035d6367c95dde999"
const NONCE1 = "9a1a6ef035d6367c95dde998"
const NONCE_DEAD = "9a1a6ef0eb7b88935f235327"
const ED_PUB = "d0a4cec0f8b50ba1e936ec5615454aa97dfb27864f5f17608af2cbb10548f1b3"
const ED_SIG_B64 = "Ak2ZbNuGLZVm9HPq2RoHlCJ+Kr9ft438RtWDhKf2qe/I6Y4+3UdMr4WwrK4jTTBTYx7c1b9oUs5ctU3tR7GkAQ=="
const ED_SIG_HEX = "024d996cdb862d9566f473ead91a0794227e2abf5fb78dfc46d58384a7f6a9efc8e98e3edd474caf85b0acae234d3053631edcd5bf6852ce5cb54ded47b1a401"
const AUTH_HEADER = "did:myco:zTestDevice.1730000000000.Ak2ZbNuGLZVm9HPq2RoHlCJ+Kr9ft438RtWDhKf2qe/I6Y4+3UdMr4WwrK4jTTBTYx7c1b9oUs5ctU3tR7GkAQ=="

const hex = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

describe('native RDP crypto cross-implementation vectors', () => {
  it('X25519 / HKDF / FrameIo / Ed25519 与 Java 向量逐字节一致', () => {
    const alicePriv = hex(ALICE_PRIV_HEX)
    const alicePub = hex(ALICE_PUB_HEX)
    const bobPub = hex(BOB_PUB_HEX)
    const account = 'did:youling:zTestAccount'
    const device = 'did:myco:zTestDevice'
    const port = 3389
    const nonce = 'tn-fixednonce0123456789abcdef'

    expect(toHex(x25519.getPublicKey(alicePriv))).toBe(ALICE_PUB_HEX)
    const shared = x25519.getSharedSecret(alicePriv, bobPub)
    expect(toHex(shared)).toBe(SHARED_HEX)

    const handshakeRaw = buildTunnelHandshake(account, device, device, port, nonce)
    expect(handshakeRaw).toBe(HANDSHAKE_RAW)

    const keys = deriveSessionKeys(shared, alicePub, bobPub, handshakeRaw)
    expect(toHex(keys.c2s)).toBe(C2S)
    expect(toHex(keys.s2c)).toBe(S2C)
    expect(toHex(keys.prefix)).toBe(PREFIX)
    expect(toHex(keys.confirmC2s)).toBe(CONFIRM_C2S)
    expect(toHex(keys.confirmS2c)).toBe(CONFIRM_S2C)

    expect(toHex(helloFrame(alicePub))).toBe('4d4554320101' + ALICE_PUB_HEX)
    expect(toHex(parseHello(helloFrame(alicePub)))).toBe(ALICE_PUB_HEX)

    const orig = new FrameIo(keys, 'originator', handshakeRaw)
    const resp = new FrameIo(keys, 'responder', handshakeRaw)
    expect(toHex(orig.confirmFrame())).toBe(CONFIRM_FRAME)
    resp.acceptConfirm(orig.confirmFrame())
    orig.acceptConfirm(resp.confirmFrame())

    expect(toHex(orig.seal(new TextEncoder().encode('RDP native test message #1')))).toBe(FRAME1)
    expect(toHex(orig.seal(new Uint8Array(64)))).toBe(FRAME2)
    expect(toHex(orig.seal(new Uint8Array(1000)))).toBe(FRAME3)
    expect(resp.open(hex(FRAME1))).toEqual(new TextEncoder().encode('RDP native test message #1'))
    expect(resp.open(hex(FRAME2))).toEqual(new Uint8Array(64))
    expect(resp.open(hex(FRAME3))).toEqual(new Uint8Array(1000))
    orig.seal(new TextEncoder().encode('tamper')) // 对齐 Java 向量的 seq=3（非向量帧）
    expect(toHex(orig.seal(new TextEncoder().encode('prefix')))).toBe(FRAME6)

    expect(toHex(nonceFor(keys.prefix, 0n))).toBe(NONCE0)
    expect(toHex(nonceFor(keys.prefix, 1n))).toBe(NONCE1)
    expect(toHex(nonceFor(keys.prefix, 0xdeadbeefcafebaben))).toBe(NONCE_DEAD)

    const seed = hex(ALICE_PRIV_HEX)
    expect(toHex(ed25519.getPublicKey(seed))).toBe(ED_PUB)
    const ts = 1730000000000
    const material = tunnelSignMaterial(device, ts, handshakeRaw)
    const sig = ed25519.sign(new TextEncoder().encode(material), seed)
    expect(toHex(sig)).toBe(ED_SIG_HEX)
    expect(toHex(fromB64(ED_SIG_B64))).toBe(ED_SIG_HEX)
    expect(tunnelAuthHeader(device, ts, ED_SIG_B64)).toBe(AUTH_HEADER)
  })
})
