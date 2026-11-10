/**
 * conv-identity.test.ts — 手机端会话存储键的账号 did 形态归一（**canonical-only**）。
 *
 * 与 PC `apps/home/src-tauri/src/chat_service.rs` 的 `conv_identity_tests` 同款用例集
 * （回归"好友消息 ✓已发送但对方/自己看不见"）：手机端此前按裸串 `didSafe(convId)` 做
 * 存储键——入站 ingest 用**信封 from 的出示形态**、出站/UI 用**名册 did 的历史形态**
 * → 同一把钥匙两份键，UI 只读得到自己那份。
 *
 * 2026-10-10 系统拍板：密钥 did **canonical-only**（`did:<method>:z<base58btc(0xed01+32B)>`），
 * legacy（`did:<method>:<裸 base58>`）**已废止**——不再解码、不再当别名、不再参与归并。
 * 因此本用例集的"历史形态"轴 = **双前缀 canonical**（did:myco:z… / did:youling:z… 同 tail）；
 * 存量 **legacy 命名的文件/键**仍由别名表枚举参与**归并读取**（这条能力不能丢），
 * 但 legacy **作为身份输入**时退化为只有原串一个（反向守卫见文末）。
 *
 * 本模块锁三件事：① 写目标唯一（归一键）；② 读取归并（存量各形态键都上屏，不迁移
 * 不删档）；③ 索引/改写同源（摘要与消息键同归一键；撤回/回写/删除逐键命中，不把归并
 * 结果整份写回一份键——那会重复或丢消息）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import bs58 from 'bs58'
import {
  _setStorageForTest, type ChatStorage, type ChatMsg, type ServerMsg,
  appendMsg, loadConv, loadConvMeta, convMetaAppend, convMetaKey, updateSendState,
  deleteMsgLocal, deleteConv, markSeen, unreadCount, getDraft, setDraft, convPref,
  setConvPinned, setConvMuted, ingestMsg, upsertFriend, listFriends,
} from './chat-store'
import { accountDidCanonical, convSafe, convSafesAll, didFromPubkey, didPubkeyBytes, didSafeId } from './didUtil'
import { digestOf } from './p2p'
import { _setOutboxStoreForTest, memOutboxStore, enqueueOutbox, removeConvOutbox, listOutbox } from './outbox'

const pk = (b: number): Uint8Array => new Uint8Array(32).fill(b)
const b58 = (b: number): string => bs58.encode(pk(b))
/** 双前缀 canonical（spec v0.3）：同一把钥匙的两种合法写法（"历史形态"轴 = 前缀轴）。 */
const mycoCanonOf = (b: number): string => didFromPubkey(pk(b), 'myco')
const youlingCanonOf = (b: number): string => didFromPubkey(pk(b), 'youling')
/** 已废止的 legacy 串（裸 32B base58）：**只作存量文件名/键名**（归并读取）与反例，不作身份。 */
const legacyOf = (b: number): string => `did:myco:${b58(b)}`
const legacyTwinOf = (b: number): string => `did:youling:${b58(b)}`

function memStorage(): ChatStorage & { dump: Map<string, string> } {
  const m = new Map<string, string>()
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v) }, del: (k) => { m.delete(k) }, dump: m }
}
let st: ReturnType<typeof memStorage>
beforeEach(() => {
  st = memStorage()
  _setStorageForTest(st)
  _setOutboxStoreForTest(memOutboxStore())
})

// 存储键由 chat-store 的归一口现算（账号桶可能是 _guest 也可能是真实账号桶——
// 环境里若残留 vault 也不会让用例错位）。
const bucketOf = (convId: string): string => convMetaKey(convId).split('.convmeta.')[0]
const convKeyOf = (convId: string): string => `${bucketOf(convId)}.conv.${convSafe(convId)}`
const metaKeyOf = (convId: string): string => convMetaKey(convId)
/** 直接按**某个具体形态**（不经归一）造键——模拟存量历史键。 */
const rawConvKey = (convId: string): string => `${bucketOf(convId)}.conv.${didSafeId(convId)}`
const rawMetaKey = (convId: string): string => `${bucketOf(convId)}.convmeta.${didSafeId(convId)}`

const text = (id: string, dir: 'in' | 'out', from: string, to: string, t: string, ts: number): ChatMsg =>
  ({ msgId: id, from, to, kind: 'text', payload: { text: t }, ts, dir })
const srv = (over: Partial<ServerMsg>): ServerMsg =>
  ({ seq: 1, id: 's1', from: '', fromName: '', fromDevice: 'did:myco:dev', kind: 'text', payload: { text: 'x' }, ts: 1, ...over })
const texts = (msgs: ChatMsg[]): string[] => msgs.map((m) => String(m.payload.text)).sort()

// 本机账号：双前缀 canonical 各一份（同一把钥匙）——名册/信封两形态都可能出现。
const ME_MYCO = mycoCanonOf(0x01)
const ME_CANON = youlingCanonOf(0x01)

// ══════════════ ① 归一键：写目标唯一 ══════════════

describe('会话归一键（canonical 双前缀 + did_safe 形态 → 同一键）', () => {
  it('双前缀 canonical + 下划线形态都落同一消息键/摘要键', () => {
    const peer = 0x21
    const forms = [mycoCanonOf(peer), youlingCanonOf(peer), didSafeId(mycoCanonOf(peer)), didSafeId(youlingCanonOf(peer))]
    const wantConv = convKeyOf(youlingCanonOf(peer))
    const wantMeta = metaKeyOf(youlingCanonOf(peer))
    for (const f of forms) {
      expect(convKeyOf(f)).toBe(wantConv)
      expect(metaKeyOf(f)).toBe(wantMeta)
    }
    // 不同公钥不撞键
    expect(convKeyOf(mycoCanonOf(0x22))).not.toBe(wantConv)
  })

  it('legacy 串（裸 base58）已废止：不再归一（原样成键，不误并）', () => {
    const legacy = legacyOf(0x21)
    const legacySafe = didSafeId(legacy)
    expect(convKeyOf(legacy)).toBe(`${bucketOf(legacy)}.conv.${legacySafe}`)
    expect(convKeyOf(legacySafe)).toBe(`${bucketOf(legacy)}.conv.${legacySafe}`)
    expect(convKeyOf(legacy)).not.toBe(convKeyOf(youlingCanonOf(0x21)))
  })

  it('群 id / 软 did 原样（不误并、不误改名）', () => {
    expect(convKeyOf('grp-1a0eb64aa34')).toBe(`${bucketOf('grp-1a0eb64aa34')}.conv.grp-1a0eb64aa34`)
    expect(convKeyOf('did:youling:BOB')).toBe(`${bucketOf('did:youling:BOB')}.conv.did_youling_BOB`)
    // 不同公钥不撞键
    expect(convKeyOf(mycoCanonOf(0x22))).not.toBe(convKeyOf(mycoCanonOf(0x21)))
  })
})

// ══════════════ ② 归并读取存量（不迁移、不删档） ══════════════

describe('存量双形态键归并读取', () => {
  it('存量 legacy 命名键的历史消息照样上屏（UI 传 canonical）；新消息一律落归一键', () => {
    const legacyName = legacyOf(0x23) // 存量文件名（修复前按旧形态落的键）
    const myco = mycoCanonOf(0x23)
    const canon = youlingCanonOf(0x23)
    const oldKey = rawConvKey(legacyName)
    const canonKey = convKeyOf(canon)
    expect(oldKey).not.toBe(canonKey) // 用例前提：两键真的不同
    // 存量：修复前按老形态落的键（含历史消息 + 老摘要）
    st.set(oldKey, JSON.stringify([text('old-1', 'out', ME_MYCO, legacyName, '旧', 10)]))
    st.set(rawMetaKey(legacyName), JSON.stringify({ n: 1, lastTs: 10, F: digestOf(['old-1']), ids: [['old-1', 10]] }))
    // 新消息：任取一 canonical 形态落库 → 写目标都是归一键
    appendMsg(myco, text('new-out', 'out', ME_MYCO, myco, '333', 30))
    appendMsg(canon, text('new-in', 'in', canon, ME_CANON, '213', 20))
    expect(st.get(canonKey)).toBeTruthy()
    expect(st.get(oldKey)).toBeTruthy() // 存量键不得被删/迁移（红线）
    expect(JSON.parse(st.get(oldKey)!).length).toBe(1)
    // UI 视角（名册形态 = 任一 canonical 前缀）读到全部三条；两 canonical 形态读到的一致
    const want = ['213', '333', '旧']
    for (const f of [myco, canon, didSafeId(myco)]) {
      expect(texts(loadConv(f))).toEqual(want)
    }
    // 反向：legacy 作为身份输入不再归并——只直读到 legacy 命名的那份（不误并 canonical 键）
    expect(texts(loadConv(legacyName))).toEqual(['旧'])
  })

  it('实机场景还原：接收按 did:myco:z… 信封 from 落、发送按 did:youling:z… 名册 did 落 → in/out 都在', () => {
    const myco = mycoCanonOf(0x24)
    const canon = youlingCanonOf(0x24)
    // ① 接收：ingest 用信封 from 的出示形态（did:myco:z…）落库
    ingestMsg(ME_CANON, srv({ id: 'in-1', from: myco, to: ME_CANON, kind: 'text', payload: { text: '213' }, ts: 1 }))
    // ② 发送：appendOut 路径用名册 did 形态（did:youling:z…）落库（appendOut 会 didSafe 后再落）
    appendMsg(didSafeId(canon), text('out-1', 'out', ME_MYCO, canon, '333', 2))
    // ③ 只有一份会话键（同一把钥匙一个键）
    expect(st.get(convKeyOf(canon))).toBeTruthy()
    expect(st.get(rawConvKey(myco))).toBeNull() // 未归一的原形态键不该被写
    // ④ UI：convId = 好友表的 did（另一 canonical 前缀）→ in/out 都在（修前只剩 out）
    const msgs = loadConv(myco)
    expect(texts(msgs)).toEqual(['213', '333'])
    expect(msgs.filter((m) => m.dir === 'in')).toHaveLength(1)
    expect(msgs.filter((m) => m.dir === 'out')).toHaveLength(1)
  })

  it('双前缀 canonical 两键（did:myco:z… / did:youling:z… 同公钥）读成一个会话，索引也归并', () => {
    const myco = mycoCanonOf(0x25)
    const youling = youlingCanonOf(0x25)
    const legacyName = legacyOf(0x25) // 存量第三种命名（已废止形态，仅文件名）
    // 存量键：另一 canonical 前缀键（出站）+ legacy 命名键（入站）——都不是归一键本体
    st.set(rawConvKey(myco), JSON.stringify([text('o-1', 'out', ME_MYCO, myco, '出', 1)]))
    st.set(rawConvKey(legacyName), JSON.stringify([text('i-1', 'in', legacyName, ME_CANON, '入', 2)]))
    expect(texts(loadConv(myco))).toEqual(['入', '出'])
    expect(texts(loadConv(youling))).toEqual(['入', '出'])
    // 无归一键摘要时：存量形态键里的消息折进同一份索引（与 PC load_meta 的别名并入同语义）
    const m1 = loadConvMeta(myco)
    const m2 = loadConvMeta(youling)
    expect(m1.n).toBe(2)
    expect(m1.F).toBe(digestOf(['o-1', 'i-1']))
    expect(m1.F).toBe(m2.F)
  })

  it('不同账号（不同公钥）不串：键/摘要/消息三隔离', () => {
    const a = mycoCanonOf(0x26)
    const b = legacyOf(0x27) // 另一个账号的 legacy 命名（不归并，各成键）
    appendMsg(a, text('a-1', 'in', a, ME_CANON, 'A', 1))
    appendMsg(b, text('b-1', 'in', b, ME_CANON, 'B', 2))
    expect(texts(loadConv(a))).toEqual(['A'])
    expect(texts(loadConv(youlingCanonOf(0x26)))).toEqual(['A'])
    expect(texts(loadConv(b))).toEqual(['B'])
    expect(convKeyOf(a)).not.toBe(convKeyOf(b))
    expect(loadConvMeta(a).F).not.toBe(loadConvMeta(b).F)
  })
})

// ══════════════ ③ 索引/改写同源 ══════════════

describe('摘要（对账索引）归并', () => {
  it('两形态各一份存量摘要 → 一份索引（n/F/ids 一致，两形态查到相同值）', () => {
    const canon = youlingCanonOf(0x28)
    const otherPrefix = mycoCanonOf(0x28)
    // 实机形态：youling 侧先进来（摘要只有入站），另一前缀侧后补（只有出站）
    appendMsg(canon, text('in-1', 'in', canon, ME_CANON, '213', 1))
    const m0 = loadConvMeta(canon)
    expect(m0.n).toBe(1)
    st.set(rawMetaKey(otherPrefix), JSON.stringify({ n: 1, lastTs: 2, F: digestOf(['out-1']), ids: [['out-1', 2]] }))
    const fromOther = loadConvMeta(otherPrefix)
    const fromCanon = loadConvMeta(canon)
    expect(fromOther.n).toBe(2)
    expect(fromOther.F).toBe(digestOf(['in-1', 'out-1']))
    expect(fromCanon.n).toBe(2)
    expect(fromCanon.F).toBe(fromOther.F)
    expect(fromOther.ids.map(([id]) => id).sort()).toEqual(['in-1', 'out-1'])
  })

  it('幂等：重复 append 同一 msgId 丢弃（跨形态重复也不复活）', () => {
    const myco = mycoCanonOf(0x29)
    const canon = youlingCanonOf(0x29)
    appendMsg(myco, text('dup-1', 'in', canon, ME_CANON, 'x', 1))
    const before = loadConvMeta(canon).n
    expect(appendMsg(canon, text('dup-1', 'in', canon, ME_CANON, 'x', 1))).toBe(false)
    expect(appendMsg(didSafeId(myco), text('dup-1', 'in', canon, ME_CANON, 'x', 1))).toBe(false)
    expect(loadConvMeta(canon).n).toBe(before)
    expect(loadConv(myco)).toHaveLength(1)
  })

  it('convMetaAppend 幂等 + 摘要键唯一（不再各形态各写一份）', () => {
    const myco = mycoCanonOf(0x2a)
    const canon = youlingCanonOf(0x2a)
    expect(convMetaAppend(myco, 'm-1', 1)).toBe(true)
    expect(convMetaAppend(canon, 'm-1', 1)).toBe(false)
    expect(st.dump.has(metaKeyOf(canon))).toBe(true)
    expect(st.dump.has(rawMetaKey(myco))).toBe(false)
  })
})

describe('改写/删除逐等价键命中（不把归并结果整份写回）', () => {
  it('回写 sendState 只动命中那份；删除单条同理', () => {
    const myco = mycoCanonOf(0x2b)
    const canon = youlingCanonOf(0x2b)
    st.set(rawConvKey(myco), JSON.stringify([{ ...text('old-out', 'out', ME_MYCO, myco, '旧出', 1), sendState: 'sending' }]))
    appendMsg(canon, text('new-in', 'in', canon, ME_CANON, '新入', 2))
    expect(updateSendState(canon, 'old-out', 'sent')).toBe(true) // 归一键查询 → 命中另一前缀的老键
    const oldRaw = st.get(rawConvKey(myco))!
    expect(oldRaw).toContain('"sendState":"sent"')
    expect(texts(loadConv(canon))).toEqual(['新入', '旧出'])
    expect(JSON.parse(st.get(convKeyOf(canon))!)).toHaveLength(1) // 归一键那份不得被动
    // 删除单条（在老形态键里）：只动老形态键
    expect(deleteMsgLocal(canon, 'old-out')).toBe(true)
    expect(JSON.parse(st.get(rawConvKey(myco))!)).toHaveLength(0)
    expect(texts(loadConv(canon))).toEqual(['新入'])
    // 找不到 → false（不误写）
    expect(updateSendState(canon, 'nope', 'sent')).toBe(false)
    expect(deleteMsgLocal(canon, 'nope')).toBe(false)
  })

  it('删会话清掉全部等价键（含存量 legacy 命名键，否则从另一形态"复活"）', () => {
    const canon = youlingCanonOf(0x2c)
    const otherPrefix = mycoCanonOf(0x2c)
    const legacyName = legacyOf(0x2c)
    st.set(rawConvKey(otherPrefix), JSON.stringify([text('o-1', 'out', ME_MYCO, otherPrefix, '出', 1)]))
    st.set(rawConvKey(legacyName), JSON.stringify([text('o-2', 'out', ME_MYCO, legacyName, '旧出', 1)]))
    appendMsg(canon, text('i-1', 'in', canon, ME_CANON, '入', 2))
    st.set(rawMetaKey(legacyName), JSON.stringify({ n: 1, lastTs: 1, F: digestOf(['o-2']), ids: [['o-2', 1]] }))
    deleteConv(canon)
    expect(st.get(rawConvKey(otherPrefix))).toBeNull()
    expect(st.get(rawConvKey(legacyName))).toBeNull()
    expect(st.get(convKeyOf(canon))).toBeNull()
    expect(st.get(rawMetaKey(legacyName))).toBeNull()
    expect(st.get(metaKeyOf(canon))).toBeNull()
    expect(loadConv(canon)).toHaveLength(0)
  })
})

// ══════════════ ④ 会话小 map（seen/drafts/prefs）别名 ══════════════

describe('未读/草稿/偏好的形态别名读写', () => {
  it('归一键写下、另一 canonical 前缀读出（反之亦然）', () => {
    const myco = mycoCanonOf(0x2d)
    const canon = youlingCanonOf(0x2d)
    appendMsg(canon, text('i-1', 'in', canon, ME_CANON, '入', 1))
    expect(unreadCount(myco)).toBe(1)
    markSeen(canon)
    expect(unreadCount(myco)).toBe(0)
    expect(unreadCount(canon)).toBe(0)
    // 老形态下已读 → 新形态读出也认（存量不清零）
    const myco2 = mycoCanonOf(0x2e)
    const canon2 = youlingCanonOf(0x2e)
    appendMsg(myco2, text('i-2', 'in', myco2, ME_CANON, '入2', 1))
    markSeen(didSafeId(myco2))
    expect(unreadCount(canon2)).toBe(0)
    // 草稿
    setDraft(canon, '草稿A')
    expect(getDraft(myco)).toBe('草稿A')
    expect(getDraft(didSafeId(myco))).toBe('草稿A')
    setDraft(myco, '')
    expect(getDraft(canon)).toBe('')
    // 偏好
    setConvPinned(canon, true)
    expect(convPref(myco).pinned).toBeTruthy()
    setConvMuted(myco, true)
    expect(convPref(canon).muted).toBe(true)
    setConvPinned(myco, false)
    expect(convPref(canon).pinned).toBeUndefined()
    expect(convPref(canon).muted).toBe(true)
    setConvMuted(canon, false)
    expect(convPref(myco)).toEqual({})
  })
})

// ══════════════ ⑤ 好友表/待发队列的形态等价 ══════════════

describe('好友表与待发队列不因形态分裂', () => {
  it('upsertFriend 公钥级去重（同一账号两 canonical 前缀只一行）', () => {
    const myco = mycoCanonOf(0x2f)
    upsertFriend(myco, '小明', 'ok')
    upsertFriend(youlingCanonOf(0x2f), '小明', 'ok')
    expect(listFriends()).toHaveLength(1)
  })

  it('upsertFriend：legacy 串不再与 canonical 判等（已废止形态 → 不合并）', () => {
    upsertFriend(youlingCanonOf(0x30), '小明', 'ok')
    upsertFriend(legacyOf(0x30), '小明', 'ok')
    expect(listFriends()).toHaveLength(2)
  })

  // （2026-10-07 好友去服务端化：mergeServerFriends 随服务器权威同步链删除——形态等价
  //  语义由 upsertFriend/ingestFriendHandshake 的 accountDidEq 判等延续，见 chat-store.test.ts）

  it('outbox：convId 存归一键，删会话按归一键命中（另一前缀入队也清得掉）', async () => {
    const myco = mycoCanonOf(0x31)
    const canon = youlingCanonOf(0x31)
    const env = { msgId: 'ob-1', from: ME_CANON, kind: 'text', payload: {} }
    await enqueueOutbox(myco, [myco], env)
    const items = await listOutbox()
    expect(items).toHaveLength(1)
    expect(items[0].convId).toBe(convSafe(canon))
    await removeConvOutbox(canon)
    expect(await listOutbox()).toHaveLength(0)
  })
})

// ══════════════ ⑥ 反向守卫（canonical-only） ══════════════

describe('反向守卫：legacy did 不再被解码/不再归并', () => {
  it('legacy 串解不出公钥 → canonical 归一/别名表/键表全退化（只有原串一个）', () => {
    for (const legacy of [legacyOf(0x32), legacyTwinOf(0x32)]) {
      expect(didPubkeyBytes(legacy)).toBeNull()
      expect(accountDidCanonical(legacy)).toBe(legacy)
      expect(convSafesAll(legacy)).toEqual([didSafeId(legacy)])
    }
  })
})
