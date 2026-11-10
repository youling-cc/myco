/**
 * chat-store.ts — 手机端好友聊天本地存储 + 消息收发（第81轮；2026-10-07 好友去服务端化）。
 *
 * 好友关系=双方本地档案+签名握手（与 PC chat_service.rs 同构）：friend-request/
 * accept/remove 三 kind 复用 wire 信封，P2P 直推优先 → 信箱兜底；防冒充三件套
 * （payload.sig 验签+名册归属+公钥判等）在接收端（ingestFriendHandshake）。
 * 聊天正文/任务卡仍走 P2P 直连（第84轮），群档案/群管理仍走信箱元数据（第85轮，不动）。
 *
 * 架构与 PC chat_service.rs 对称：identity-svc /msg/* 只中转群元数据（拉走即删零存档），
 * 消息存本地 localStorage（第66轮命名收敛 youling.chat.*；第96轮修复1 按账号分桶，
 * 与 PC chat/<safeDid>/ 同构——切账号各看各桶，解绑清桶）：
 *   youling.chat.<safeDid>.friends       [{did,name,addedAt,status}]（好友本地档案——去服务端化后即权威）
 *   youling.chat.<safeDid>.groups        [{id,name,members,createdAt}]
 *   youling.chat.<safeDid>.tasks         任务卡分享的本地 peer 任务库
 *   youling.chat.<safeDid>.seen          {convId: lastSeenTs}（未读角标）
 *   youling.chat.<safeDid>.conv.{id}     单会话消息（上限 200 条滚动，超限丢最老）
 *   youling.chat.<safeDid>.media.{msgId} 图片/文件 b64（媒体不进 conv 键，防撑爆单键）
 * 旧全局键（无 <safeDid> 段）在首个真实账号访问时一次性整体迁移进其桶。
 *
 * 存储层可注入（_setStorageForTest）——单测零 localStorage 依赖；
 * 网络层走 identity.ts 的 signedPost（设备钥签名，与 presence 同链）。
 * 任务卡协议与 PC 一致：卡=微活契约平铺；回执词表对齐 HBL（claim/submit + task_id/worker_did）。
 *
 * 批二（2026-09-28，群语义修正，与 PC chat_service.rs 同构）：
 * ① 群任务卡落群会话（payload.groupId=grp-*）+ 接受/完成回执群广播；单聊行为不变。
 * ② 群主退群=解散：广播 group-disband（新 kind）+compat group-leave；全体群会话
 *   保留只读+members 清空+系统条"群已被解散"。
 * ③ 被踢=群会话保留只读+系统条"你已被移出群「X」"；不再静默删群。
 * ④ 自愈建群 ownerPending（治理全拒）→ group-create 落群会话参与对账补齐真 owner。
 */
import {
  signalPost, getRootIdentity, getAttestation, currentIdentity, currentYoulingName,
  friendSignMaterial, signFriendHandshake, verifyDeviceSig, listRootDevices, pubkeyB64FromDid,
} from './identity'
import { sha256 } from '@noble/hashes/sha256.js'
import * as ed from '@noble/ed25519'
import { accountDidAliases, accountDidCanonical, accountDidEq, convSafe, convSafesAll, didSafeId, restoreDidSafe } from './didUtil'
// 「点卡就进」的回包投递（share-entry-grant → 唤醒等在 remoteOpen 的调用方）。
// 无循环依赖：share-entry 只依赖 p2p-tunnel 的类型与纯函数，不引 chat-store。
import { deliverShareEntryGrant, actionShareCoords } from './share-entry'
// 2026-10-25 文案精简：任务卡标题显示时抹掉 127.0.0.1:端口 等技术细节（纯显示层，
// task-env 只导出纯函数，无循环依赖）。数据与打开链路不动。
import { cleanCardTitle } from './task-env'

// ══════════════ 类型 ══════════════

export interface ChatMsg {
  msgId: string
  from: string
  to: string
  kind: string
  payload: Record<string, unknown>
  ts: number
  dir: 'out' | 'in'
  fromName?: string
  /** 第95轮：发送状态（仅 dir=out 有）：sending=⏳ 发送中（离线队列待补发）/
   *  sent=✓ 已发送 / failed=! 失败（点按重发）。老消息无此字段=不显示徽标。 */
  sendState?: 'sending' | 'sent' | 'failed'
  /** 设备群（2026-10-07 设计 §3 决策D）：同账号多设备 from 恒同——行级持久化
   *  fromDevice/fromDeviceName（群消息 ingest 落盘/对账 wire 原样带），署名与
   *  dir 判定靠它区分"哪台设备说的"；普通群/单聊不带（缺省走 fromName，行为不变）。 */
  fromDevice?: string
  fromDeviceName?: string
}
export interface Friend { did: string; name: string; addedAt: number; pending?: boolean; status?: 'out-pending' | 'in-pending' | 'ok'; official?: boolean }


// ══════════════════════════════════════════════════════════════════════
// 小灵官方通知（2026-10-20）：固定官方 did，服务端经 /msg/poll 投递
// kind=official-notice；本端验签后落「小灵」会话（与 PC chat_service.rs 同构）。
// 验签材料：official-notice\n<收件人 canonic 账号did>\n<noticeId>\n<createdAt>\n<sha256hex(title\nbody\nlabel\nurl)>
// ══════════════════════════════════════════════════════════════════════
export const OFFICIAL_ACCOUNT_DID = 'did:youling:z6MkuH5FNdqmGUcoEsNUqiw47dvaHCXoYfBXTdrXpzEZEthD'
export const OFFICIAL_ACCOUNT_NAME = '小灵'
export const OFFICIAL_NOTICE_KIND = 'official-notice'
const OFFICIAL_PUBKEYS_B64 = [
  '3ENJqvaI6PqDbFKdTksfSeBVjRKNdvJ5V8k2A+8TADA=', // 官方账号根公钥
  'B+rm1EAASFf7conJhulyrrpdXv4EO3JaPFEhgYgjGgo=', // 「小灵推送」设备公钥
]

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function bytesToHex(u8: Uint8Array): string {
  let s = ''
  for (const b of u8) s += b.toString(16).padStart(2, '0')
  return s
}

/** 通知签名材料（与 identity-svc official.mjs、PC chat_service 同口径）。 */
export function officialNoticeMaterial(recipientCanonical: string, noticeId: string, createdAt: number,
                                       title: string, body: string, label: string, url: string): string {
  const inner = bytesToHex(sha256(new TextEncoder().encode(`${title}\n${body}\n${label}\n${url}`)))
  return `${OFFICIAL_NOTICE_KIND}\n${recipientCanonical}\n${noticeId}\n${createdAt}\n${inner}`
}

/** 验签：from 必须是官方 did；signer 必须是内置官方 root/设备公钥；材料逐字节一致。 */
export function verifyOfficialNotice(m: ServerMsg, myDid: string): boolean {
  const p = (m.payload || {}) as {
    noticeId?: string; createdAt?: number; title?: string; body?: string; sigB64?: string
    signer?: { pubkeyB64?: string }; action?: { label?: string; url?: string }
  }
  if (!p.noticeId || !p.createdAt || !p.title || !p.sigB64 || !p.signer?.pubkeyB64) return false
  if (!accountDidEq(m.from, OFFICIAL_ACCOUNT_DID)) return false
  if (!OFFICIAL_PUBKEYS_B64.includes(String(p.signer.pubkeyB64))) return false
  const material = officialNoticeMaterial(accountDidCanonical(myDid), p.noticeId, Number(p.createdAt),
    p.title, p.body || '', p.action?.label || '', p.action?.url || '')
  try {
    return ed.verify(b64ToBytes(p.sigB64), new TextEncoder().encode(material), b64ToBytes(String(p.signer.pubkeyB64)))
  } catch { return false }
}

/** 小灵会话 id（convSafe 形态；restoreDidSafe 后可还原出 did）。 */
export function officialConvId(): string { return convSafe(OFFICIAL_ACCOUNT_DID) }
export function isOfficialConv(convId: string): boolean {
  try { return accountDidEq(restoreDidSafe(convId) || convId, OFFICIAL_ACCOUNT_DID) } catch { return false }
}

/** 内置好友（幂等补缺；历史用户升级/新注册都会出现；不覆盖用户自定义）。 */
export function ensureOfficialFriend(): boolean {
  const list = listFriends()
  if (list.some((f) => accountDidEq(f.did, OFFICIAL_ACCOUNT_DID))) return false
  list.push({ did: OFFICIAL_ACCOUNT_DID, name: OFFICIAL_ACCOUNT_NAME, addedAt: Date.now(), status: 'ok', official: true })
  writeArr(K.friends(), list)
  return true
}

function ingestOfficialNotice(my: string, m: ServerMsg): boolean {
  if (!verifyOfficialNotice(m, my)) {
    console.warn('[official] 验签失败，丢弃通知', m.id)
    return false
  }
  ensureOfficialFriend()
  const p = (m.payload || {}) as Record<string, unknown>
  const noticeId = String(p.noticeId || m.id)
  const row: ChatMsg = {
    msgId: noticeId, from: OFFICIAL_ACCOUNT_DID, to: my, kind: OFFICIAL_NOTICE_KIND,
    payload: p, ts: Number(p.createdAt || m.ts || Date.now()), dir: 'in', fromName: OFFICIAL_ACCOUNT_NAME,
  }
  return appendMsg(officialConvId(), row)
}

/** 已读回执（设备签名；服务端校验设备归属后 queued/delivered→read；幂等）。 */
export async function ackOfficialNotices(my: string, noticeIds: string[]): Promise<void> {
  const r = await signalPost('/official/read', { accountDid: my, noticeIds })
  if (!r.ok) throw new Error(`official read ${r.status}`)
}

let _lastOfficialSyncMs = 0

/** 自愈同步：/msg/poll 拉走即删，响应丢失会永久丢件 —— 定期拉 delivered 未读补投（msgId 幂等）。 */
export async function syncOfficialPending(my: string): Promise<number> {
  const r = await signalPost('/official/pending', { accountDid: my })
  if (!r.ok) throw new Error(`official pending ${r.status}`)
  const d = (await r.json()) as { data?: { msgs?: ServerMsg[] } }
  let n = 0
  for (const m of d.data?.msgs ?? []) {
    if (m.kind === OFFICIAL_NOTICE_KIND && ingestOfficialNotice(my, m)) n += 1
  }
  return n
}

// ══════════════ 2026-10-18 fast-ack：链路 trace + 前台判定 ══════════════

/** 轻量链路 trace（只 msgId/阶段/目标/耗时，**不含聊天内容**）→ console.log 落
 *  gw-net.log（adb 拉取）；格式与 PC `chat_service.rs` 的 `[chat-trace]` 完全一致
 *  （ev/msgId/ts/target/ms），测量脚本按 msgId 对齐两端时间线算 M2/M3/M4/M7。 */
export function chatTrace(ev: string, msgId: string, target: string, ms: number): void {
  try {
    console.log(`[chat-trace] ${JSON.stringify({ ev, msgId, ts: Date.now(), target, ms })}`)
  } catch { /* 日志绝不抛 */ }
}

/** 应用是否前台（浏览器环境看 visibilityState；无 document 的测试环境按前台）。
 *  前台：信箱轮询 1.5s / 补发 3s 起；后台：5s / 60s（省电省流量）。 */
export function isForeground(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}
/** 第85轮：群档案+治理模型——owner=建群者（群主，加入即授权管理）；
 *  governance 治理开关仅预留（'owner'=群主制，恒定；'vote'=投票制，未来支持，暂无切换入口）；
 *  muted=禁言表（did → 截止 ts；0/缺=正常）。
 * 批二（2026-09-28）：status=终态（'disbanded'=群主已解散 / 'kicked'=我已被移出——
 *  档案保留只读、历史可回查、members 清空）；ownerPending=自愈建群 owner 未同步
 *  （治理全拒直到 group-create 补齐真 owner，不再首成员冒充群主）。 */
export interface ChatGroup {
  id: string; name: string; members: string[]; createdAt: number
  owner?: string
  governance?: 'owner' | 'vote'
  muted?: Record<string, number>
  status?: 'disbanded' | 'kicked'
  ownerPending?: boolean
  /** 设备群（2026-10-07 设计 §3 决策A）：kind='device'=系统群标记——本账号全部设备
   *  自动入群（ensureDeviceGroup 本地幂等建档）；治理入口全锁（UI ⚙️ 隐藏 + 数据层闸）。 */
  kind?: 'device'
}
/** 第83轮：任务参与方（分享=owner / 接受=member；status='done' 该参与方已完成）。 */
export interface TaskParticipant { did: string; name?: string; role?: 'owner' | 'member' | string; status?: string; acceptedAt?: number; doneAt?: number }
/** §3.23 赠卡：**源设备随卡下发**的"我的角色 / 我的权限"投影。
 *  只用于展示 + 本地转发闸（`canReshare`）；**判定仍在源设备**（这张卡不构成任何凭据）。 */
export interface TaskGrantView {
  role?: string
  label?: string
  /** 只读（true=看，不可说） */
  ro?: boolean
  expiresAt?: number
  /** 生效能力勾选（四个固定 id：session.read / session.input / agent.view / scope.switch） */
  caps?: Record<string, boolean>
  /** 生效可见范围（§3.20 的 S→O 投影） */
  visibility?: { space?: string; sessions?: string[]; windowMs?: number | null }
  windowMs?: number | null
  /** 我能不能把这张卡转给第三人（默认 false = 要经主人同意） */
  canReshare?: boolean
  reshareExp?: number
  reshareVia?: string | null
}
/** 我的任务（本机任务库；**持久化，不依赖那条聊天消息还在不在**）。
 *
 *  2026-10-09 任务卡进列表：好友/设备分享来的分享卡（带 `shareId`）与本地任务同库，
 *  幂等键 = `taskId`（源设备派生 `peer-task-share-<shareId>`）**或** `shareId`
 *  ——同一张卡重复投递永远只有一条（见 `ingestMsg` 的 task-share 分支）。 */
export interface PeerTask {
  taskId: string; title: string; desc?: string; requirements?: string
  rSpec?: { key: string; label?: string; target: unknown; unit?: string }[]
  reward?: string; from: string; fromName?: string; createdAt?: number; expiresAt?: number
  status: string; convId: string; source?: string; participants?: TaskParticipant[]; acceptedAt?: number; doneAt?: number
  /** 改名时间戳（task-rename，2026-10-11）：ts 大者生效的冲突裁决锚；缺省=0（任何改名都可应用） */
  titleTs?: number
  /** 关联的 myco 分享（`sh-…`）——有它才有"随时点开"的入口 */
  shareId?: string
  /** **源设备** did（隧道目标）与展示名：点开 = 向它取票、经隧道把那一页拉过来 */
  sourceDevice?: string; sourceDeviceName?: string
  /** 源账号 did（grant 名单按它比对；转授申请要投给它） */
  sourceAccount?: string
  /** true = 这张卡来自**别的设备/别人**（本机没有这条分享的注册表） */
  remoteOrigin?: boolean
  /** 我的角色：owner（我的分享/同账号设备）/ collaborator（好友分享给我） */
  myRole?: string
  /** 赠卡（我的权限摘要；`taskPermLabel` 把它说成人话） */
  grant?: TaskGrantView
  /** 转授闸（§3.23）：默认 false —— 转给第三人要经主人同意 */
  canReshare?: boolean; reshareExp?: number; reshareVia?: string | null
  /** 卡片动作（薄卡片契约；open-url = 点开直达；open-env = 按卡上 env 直接建链，
   *  2026-10-23：env 卡的入口是**环境本身**，不是分享页 `/gw/<id>/app/`）。 */
  action?: { kind?: string; url?: string; label?: string; target?: string; env?: unknown[]; shareId?: string }
  /** 卡面 env（2026-10-23）：与 PC `share_card_record` 的 `env[]` 同形状。
   *  列表行/气泡的 env 入口**只认它**（没有 env 的老卡保持原行为）。 */
  env?: unknown[]
  /** 卡面能力声明（执行器按它放行 `vnet.forward`；缺省=拒绝） */
  caps?: unknown
  /** 卡主人账号 did（审计/归属；缺省不猜） */
  owner?: string
}
/** 服务器信箱条目（/msg/poll 返回）。to 仅 P2P wire 适配时带（对账回流的
 *  自己消息归位用，第84轮）。 */
export interface ServerMsg {
  seq: number; id: string; from: string; fromName?: string; fromDevice: string
  /** 设备群署名（决策 D.2）：P2P wire 信封带 fromDeviceName（手机 buildEnvelope 已带；
   *  PC 侧 T2 合入后同构）——信箱路径无此字段，缺省走 fromName 降级。 */
  fromDeviceName?: string
  to?: string; kind: string; payload: Record<string, unknown>; ts: number
}

// ══════════════ 存储层（可注入） ══════════════

export interface ChatStorage { get(k: string): string | null; set(k: string, v: string): void; del(k: string): void; keys?(): string[] }

const browserStorage: ChatStorage = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* 容错（隐私模式） */ } },
  del: (k) => { try { localStorage.removeItem(k) } catch { /* 忽略 */ } },
  keys: () => {
    try {
      const out: string[] = []
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k) out.push(k) }
      return out
    } catch { return [] }
  },
}
let storage: ChatStorage = browserStorage
/** 测试注入（生产不调）。 */
export function _setStorageForTest(s: ChatStorage): void { storage = s }

function didSafe(did: string): string { return did.replace(/[:/]/g, '_') }

// ══════════════ 2026-10-07：会话 id 形态归一（与 PC chat_service.rs conv_key 同款） ══════════════
// 根因（PC 端已实证的同款隐患）：会话存储键此前直接是裸串 `didSafe(peer)`——
//   ① 入站 ingest 按**信封 from 的出示形态**落键（新账号 canonical `did:youling:z…`，
//      老账号 legacy `did:myco:<b58>`）；
//   ② 发送与 UI 按**名册 did 的历史形态**读写（服务器好友表里是另一种形态）。
// 同一把钥匙 → 两份存储键；UI 只读得到自己那份，对方消息"收到了但看不见"。
// 修法照 PC：归一键 = `convSafe`（四形态 + did_safe 下划线形态 → 单一 canonical）作
// **唯一写目标**；存量各形态键由 `convKeysAll` 归并读取（不迁移、不删档）；改写类逐键
// 命中（防把归并结果整份写回一份键而重复/丢消息）。群 id（grp-*）与软 did 原样。

/** 该会话全部等价消息键（归一键首位 + 存量形态）。 */
function convKeysAll(convId: string): string[] {
  const p = accPrefix() // 热路径：前缀只解析一次（含旧全局键迁移探测）
  return convSafesAll(convId).map((s) => `${p}.conv.${s}`)
}
/** 该会话全部等价摘要键（与消息键同源）。 */
function convMetaKeysAll(convId: string): string[] {
  const p = accPrefix()
  return convSafesAll(convId).map((s) => `${p}.convmeta.${s}`)
}
/** 删会话/删好友/退群：等价消息键 + 归一键摘要键一并清（否则删完还会从另一形态"复活"）。 */
function convRemoveKeys(convId: string): void {
  for (const k of convKeysAll(convId)) storage.del(k)
  for (const k of convMetaKeysAll(convId)) storage.del(k)
}

// ══════════════ 第96轮（修复1）：账号分桶——youling.chat.<safeDid>.* ══════════════

/** 当前账号的键前缀（未关联=_guest 桶，与 PC chat_dir() 同语义）。首个真实账号
 *  访问时惰性触发旧全局键一次性迁移（见 migrateLegacyChatKeys）。
 *  2026-10-07 修（三端互测矩阵 m4 实锤）：分身态（agent，仅 attestation 无根钥）
 *  此前只看 getRootIdentity() → null → 误落 _guest 桶——与 myAccountDid() 的
 *  回退语义（attestation.rootDid）及 PC chat_dir()（agent 态=账号桶）都不一致。
 *  统一走 myAccountDid()：主设备= vault rootDid；分身=attestation.rootDid。 */
function accPrefix(): string {
  const did = myAccountDid()
  const p = did ? `youling.chat.${didSafe(did)}` : 'youling.chat._guest'
  if (did) ensureLegacyMigrated(p)
  return p
}

const migratedBuckets = new Set<string>()
/** 旧全局键（第66-95轮形态，无 <safeDid> 段）：固定键 + conv./convmeta./media. 前缀。
 *  drafts/convprefs 属批四（v0.3.84 已随 dev 发版为全局键）——合入分桶后同样整体迁移，防用户草稿/偏好滞留旧键。 */
const LEGACY_FIXED = ['friends', 'groups', 'tasks', 'seen', 'friendsMigrated86', 'media.index', 'drafts', 'convprefs'].map((s) => `youling.chat.${s}`)
const LEGACY_PREFIXES = ['youling.chat.conv.', 'youling.chat.convmeta.', 'youling.chat.media.']

function ensureLegacyMigrated(prefix: string): void {
  if (migratedBuckets.has(prefix)) return
  migratedBuckets.add(prefix)
  migrateLegacyChatKeys(storage, prefix)
}

/** 旧全局 youling.chat.* → 账号桶键的一次性迁移（整体 move=set 新键+del 旧键）。
 *  触发条件：桶为空（无任何 prefix. 键）且旧负载存在——不覆盖桶内已有数据。
 *  纯存储操作（存储注入可测）；存储不可枚举（无 keys()）时安全跳过。 */
export function migrateLegacyChatKeys(st: ChatStorage, prefix: string): number {
  if (!st.keys) return 0
  const all = st.keys()
  const legacy = all.filter((k) => LEGACY_FIXED.includes(k) || LEGACY_PREFIXES.some((p) => k.startsWith(p)))
  if (legacy.length === 0) return 0
  if (all.some((k) => k.startsWith(`${prefix}.`))) return 0 // 桶非空——不动
  let moved = 0
  for (const k of legacy) {
    const v = st.get(k)
    if (v === null) continue
    st.set(k.replace('youling.chat.', `${prefix}.`), v)
    st.del(k)
    moved++
  }
  return moved
}

/** 键表（全部按账号分桶；切账号=换前缀，各看各桶）。 */
const K = {
  friends: () => `${accPrefix()}.friends`,
  groups: () => `${accPrefix()}.groups`,
  tasks: () => `${accPrefix()}.tasks`,
  /** 2026-10-27：任务卡撤销墓碑（PC tombstoneTasks 广播；防手机端对账/迟到重放复活）。 */
  taskTombstones: () => `${accPrefix()}.task-tombstones`,
  seen: () => `${accPrefix()}.seen`,
  /** 批四：草稿（按会话；发送清空/切会话恢复/列表 [草稿] 预览）。 */
  drafts: () => `${accPrefix()}.drafts`,
  /** 批四：会话偏好 {convIdSafe:{pinned?:number(置顶时刻),muted?:boolean}}。 */
  convprefs: () => `${accPrefix()}.convprefs`,
  conv: (id: string) => `${accPrefix()}.conv.${convSafe(id)}`,
  media: (msgId: string) => `${accPrefix()}.media.${msgId}`,
  /** 第84轮：会话对账摘要 {n,lastTs,F,ids:[[msgId,ts],...]}（ids 全量，不随 CONV_MAX 滚动丢）。
   *  2026-10-07：与消息键同归一键（旧形态摘要由 loadConvMeta 归并读取）。 */
  convmeta: (id: string) => `${accPrefix()}.convmeta.${convSafe(id)}`,
}
export const CONV_MAX = 200
const MEDIA_MAX = 24 // 媒体键上限（FIFO 淘汰；localStorage 总量 ~5MB，2MB 单图下 24 已紧）

function readArr<T>(k: string): T[] {
  try { return JSON.parse(storage.get(k) || '[]') as T[] } catch { return [] }
}
function writeArr<T>(k: string, v: T[]): void { storage.set(k, JSON.stringify(v)) }

// ══════════════ 第84轮：会话对账摘要（与 PC p2p_sync.rs 同算法） ══════════════

export interface ConvMeta { n: number; lastTs: number; F: string; ids: [string, number][] }

export function convMetaKey(id: string): string { return K.convmeta(id) }

const emptyMeta = (): ConvMeta => ({ n: 0, lastTs: 0, F: '0'.repeat(64), ids: [] })

/** 指纹（XOR SHA256(msgId)，与 p2p.ts digestOf / PC fingerprint_of 字节级一致）。 */
function fingerprintHex(ids: string[]): string {
  const cur = new Uint8Array(32)
  for (const id of ids) {
    const h = sha256(new TextEncoder().encode(id))
    for (let i = 0; i < 32; i++) cur[i] ^= h[i]
  }
  return Array.from(cur).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function parseMeta(raw: string | null): ConvMeta | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as ConvMeta | null
    if (v && Array.isArray(v.ids) && typeof v.F === 'string') return v
  } catch { /* 坏键按空 */ }
  return null
}

/** 两份摘要合并：ids 按 msgId 去重（先到者胜）、n/ids 取并集、lastTs 取最大、
 *  F 按并集重算（XOR 可增量，但两份各自算过——重算保证与归并视图自洽）。 */
function mergeConvMeta(a: ConvMeta, b: ConvMeta): ConvMeta {
  const seen = new Set<string>()
  const ids: [string, number][] = []
  let lastTs = 0
  for (const src of [a, b]) {
    for (const [id, ts] of src.ids) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      ids.push([id, ts])
      if (ts > lastTs) lastTs = ts
    }
  }
  if (!ids.length) return { ...emptyMeta(), lastTs: Math.max(a.lastTs, b.lastTs) }
  return { n: ids.length, lastTs, F: fingerprintHex(ids.map(([id]) => id)), ids }
}

/** 把**存量形态键**里、归一键索引尚未收录的 msgId 折进摘要（与 PC load_meta 的
 *  aliasSrc 并入同语义）。归一键本体键的 id 由 convMetaAppend 维护，不再扫；
 *  只扫非本体的存量等价键（通常 0~1 个）——成本可控，且幂等（只增不删）。 */
function foldLegacyConvIds(convId: string, m: ConvMeta, p: string): ConvMeta {
  const canon = convSafe(convId)
  const extra: [string, number][] = []
  for (const s of convSafesAll(convId)) {
    if (s === canon) continue
    const raw = storage.get(`${p}.conv.${s}`)
    if (!raw) continue
    try {
      const arr = JSON.parse(raw) as ChatMsg[]
      if (!Array.isArray(arr)) continue
      for (const x of arr) if (x?.msgId) extra.push([x.msgId, x.ts ?? 0])
    } catch { /* 坏键跳过 */ }
  }
  if (!extra.length) return m
  const known = new Set(m.ids.map(([id]) => id))
  const add = extra.filter(([id]) => !known.has(id))
  if (!add.length) return m
  const ids = [...m.ids, ...add]
  return { n: ids.length, lastTs: ids.reduce((a, [, ts]) => Math.max(a, ts), m.lastTs), F: fingerprintHex(ids.map(([id]) => id)), ids }
}

/** 读会话摘要。2026-10-07：**归并读取**全部等价键（存量同账号两形态两份摘要 → 一份
 *  索引）——此前按裸串命名，同一对端两份键各算各的 F，"收到的消息"不进 UI 那份会话的
 *  指纹。只有一个形态时原样返回（零行为变化）；存量形态键里索引未收录的消息也会折进来。 */
export function loadConvMeta(convId: string): ConvMeta {
  const p = accPrefix() // 前缀只解析一次（账号桶含迁移探测）
  let merged: ConvMeta | null = null
  for (const s of convSafesAll(convId)) {
    const v = parseMeta(storage.get(`${p}.convmeta.${s}`))
    if (!v) continue
    merged = merged ? mergeConvMeta(merged, v) : v
  }
  return foldLegacyConvIds(convId, merged ?? emptyMeta(), p)
}

/** 写摘要：**唯一写目标 = 归一键**（旧形态摘要不再各写一份；其存量条目由归并读取带出）。 */
export function saveConvMeta(convId: string, m: ConvMeta): void {
  storage.set(K.convmeta(convId), JSON.stringify(m))
}

/** 摘要增量追加（O(1)：F ^= SHA256(msgId)；ids push）。幂等：已存在返回 false。
 *  实现刻意不 import p2p.ts 的 digestOf（避免环）——字节级一致由单测互锁。 */
export function convMetaAppend(convId: string, msgId: string, ts: number): boolean {
  if (!msgId) return false
  const m = loadConvMeta(convId)
  if (m.ids.some(([id]) => id === msgId)) return false
  // F ^= SHA256(msgId)
  const cur = Uint8Array.from({ length: 32 }, (_, i) => parseInt(m.F.slice(i * 2, i * 2 + 2), 16) || 0)
  const h = sha256(new TextEncoder().encode(msgId))
  let fhex = ''
  for (let i = 0; i < 32; i++) fhex += (cur[i] ^ h[i]).toString(16).padStart(2, '0')
  saveConvMeta(convId, {
    n: m.n + 1,
    lastTs: Math.max(m.lastTs, ts),
    F: fhex,
    ids: [...m.ids, [msgId, ts] as [string, number]],
  })
  return true
}

// ══════════════ 2026-10-18：wire msgId 内存去重索引（对账重放/渲染风暴治理） ══════════════
//
// 实测（chat-metrics A 轮 WiFi 直连，gw-net.log）：手机 2 分钟 1252 行 `[chat-trace] recv`，
// 只有 64 个不同 msgId——同一批历史各被重复 recv ~22 次；存储不重复（appendMsg 幂等挡住），
// 但**每次重放仍走完整 ingest 状态机 + notify 通知 + recv trace + UI 全量重读**，把批量
// 20 条的端到端上屏 M3 放大到 P50 4.6s / P95 8.4s（用户观感"聊天卡"）。
//
// 根因两层：① 对账 convId 视角未映射（见 p2p.ts `localConvIdOfPeerView`）→ 单聊 F 恒不
// 相等 → 每拍把对端全量历史当"缺的"拉回；② `ingestMsg` 返回值语义是"已处理"而非"新入库"
// （text/image/group-msg 等分支恒 return true）→ 入口无从判断重复。
//
// 本索引在 **wire 入口**（p2p.ts ingestWireMsg）做 O(1) 严格去重：见过即丢——不 ingest、
// 不 notify、不 trace、不触发渲染。session 级（Set）；对账读本地 meta 时批量预热，重启后
// 第一拍即收敛，历史不再重放。
const wireSeenIds = new Set<string>()

/** wire msgId 是否已处理过（O(1)；重复消息据此直接丢弃）。 */
export function wireMsgSeen(msgId: string): boolean {
  return msgId.length > 0 && wireSeenIds.has(msgId)
}

/** 登记 wire msgId（幂等）；返回 true=首次见（调用方应走 ingest）。 */
export function markWireMsgSeen(msgId: string): boolean {
  if (!msgId) return false
  if (wireSeenIds.has(msgId)) return false
  wireSeenIds.add(msgId)
  return true
}

/** 批量预热（对账 `loadConvMeta().ids` 全量登记）——重启后第一拍即把历史视为已见，
 *  对账重放不再触发 ingest/渲染。O(n) 只在每次对账每会话一次，不在 ingest 热路径。 */
export function seedWireMsgSeen(ids: Iterable<string>): void {
  for (const id of ids) if (id) wireSeenIds.add(id)
}

/** 已做过全局预热的账号桶（切账号后各自预热一次；Set 防重复解析全部摘要）。 */
const wireSeededBuckets = new Set<string>()

/** 一次性全局预热（session 首次对账前调）：把**当前账号桶所有会话摘要**里的 msgId
 *  灌进索引。与 seedWireMsgSeen 的区别：后者只登记"正在对账的那个会话"的 id，而
 *  实测重放的一批 msgId 历史落进了**另一个会话键**（同一批消息因 to/from 形态差异
 *  被路由成两个 conv key）——只按会话预热仍会被当成"缺的"重拉重灌。全局预热后，
 *  对账拉取前可按 `wireMsgSeen` 过滤：同一 msgId 只要本机任何会话里已有，就不再拉。
 *  成本：O(本桶消息总数) 一次（11 个会话/~千条 id 实测 <10ms）；之后走 Set O(1)。
 *  幂等：同一账号桶只做一次（切账号各做一次；返回本次新增条数，重复调用返回 0）。 */
export function seedWireMsgSeenFromStorage(): number {
  if (!storage.keys) return 0
  const p = accPrefix()
  if (wireSeededBuckets.has(p)) return 0
  wireSeededBuckets.add(p)
  const prefix = `${p}.convmeta.`
  let added = 0
  for (const k of storage.keys()) {
    if (!k.startsWith(prefix)) continue
    const meta = parseMeta(storage.get(k))
    if (!meta) continue
    for (const [id] of meta.ids) {
      if (id && !wireSeenIds.has(id)) {
        wireSeenIds.add(id)
        added += 1
      }
    }
  }
  return added
}

/** 测试用：清空索引（模拟进程重启）。 */
export function _resetWireSeenForTest(): void {
  wireSeenIds.clear()
  wireSeededBuckets.clear()
}

export function listFriends(): Friend[] {
  // 第82轮：pending(bool)→status 三态迁移（读时迁移,写时全 status）
  const list = readArr<Friend>(K.friends())
  for (const f of list) {
    if (!f.status) f.status = f.pending ? 'in-pending' : 'ok'
    delete f.pending
  }
  return list
}
const fstOf = (f: Friend) => f.status || 'ok'
export function listGroups(): ChatGroup[] { return readArr<ChatGroup>(K.groups()) }
export function listTasks(): PeerTask[] { return readArr<PeerTask>(K.tasks()) }

/** 任务卡撤销墓碑：taskId 或 shareId 任一命中即死卡（与 PC tombstoneTasks 语义对齐）。 */
interface TaskTombstone { taskId?: string; shareId?: string; revokedAt: number }
function taskTombstoned(taskId: string, shareId: string): boolean {
  const tid = taskId.trim(), sid = shareId.trim()
  if (!tid && !sid) return false
  return readArr<TaskTombstone>(K.taskTombstones()).some((x) =>
    (tid && x.taskId === tid) || (sid && x.shareId === sid))
}
function markTaskTombstoned(taskId: string, shareId: string): void {
  const tid = taskId.trim(), sid = shareId.trim()
  if (!tid && !sid) return
  const list = readArr<TaskTombstone>(K.taskTombstones())
  const now = Date.now()
  // Upsert（2026-10-27 复核 blocker）：先补可合并的半键墓碑；若同 shareId 已绑定别的
  // taskId（污染副本 P + anchor T），必须追加 (T,S) 独立记录，不能 early-return。
  const fill = list.find((x) =>
    (tid && x.taskId === tid && !x.shareId) || (sid && x.shareId === sid && !x.taskId))
  if (fill) {
    if (tid) fill.taskId = tid
    if (sid) fill.shareId = sid
    fill.revokedAt = now
  } else {
    const exact = list.some((x) =>
      (!tid || x.taskId === tid) && (!sid || x.shareId === sid))
    if (!exact) list.push({ ...(tid ? { taskId: tid } : {}), ...(sid ? { shareId: sid } : {}), revokedAt: now })
  }
  writeArr(K.taskTombstones(), list)
}

/** 2026-10-20：按 shareId 删任务卡（僵尸卡自愈用：分享已停止时手机端自动清理）。
 *  返回删掉的条数。 */
export function removeTasksByShareId(shareId: string): number {
  if (!shareId) return 0
  const list = readArr<PeerTask>(K.tasks())
  const kept = list.filter((t) => {
    const c = taskShareCardOf(t)
    if (c && c.shareId === shareId) return false
    // 兜底：卡形状不标准（缺 device/account）时 taskShareCardOf 返回 null，
    // 直接看 action.url 里是否带这个 shareId（老卡/僵尸卡形态）。
    const url = typeof (t as { action?: { url?: string } }).action?.url === 'string'
      ? String((t as { action?: { url?: string } }).action?.url)
      : ''
    return !url.includes(shareId)
  })
  const removed = list.length - kept.length
  if (removed > 0) writeArr(K.tasks(), kept)
  return removed
}

export function upsertFriend(did: string, name: string, status: Friend['status']): void {
  const list = listFriends()
  const nm = name.trim() || '有灵账号'
  const rank = (s: string) => (s === 'ok' ? 2 : s === 'in-pending' ? 1 : 0)
  // 2026-10-07：公钥级同判定——同一账号的历史形态不再堆成两行好友
  const i = list.findIndex((f) => accountDidEq(f.did, did))
  if (i >= 0) {
    if (rank(status || 'ok') >= rank(fstOf(list[i]))) { list[i].status = status; list[i].name = nm }
  } else {
    list.push({ did, name: nm, addedAt: Date.now(), status })
  }
  writeArr(K.friends(), list)
}

export function removePendingFriend(did: string): void {
  writeArr(K.friends(), listFriends().filter((f) => f.status !== 'in-pending' || !accountDidEq(f.did, did)))
}

/** 删好友（第82轮）：本地清理（好友行+会话+媒体）。 */
export function removeFriendLocal(did: string): void {
  writeArr(K.friends(), listFriends().filter((f) => !accountDidEq(f.did, did)))
  // 第84轮：会话+对账 meta 一并清；2026-10-07：等价形态键全清（否则删完从另一形态复活）
  try { convRemoveKeys(did) } catch { /* 忽略 */ }
  void import('./outbox').then((o) => o.removeConvOutbox(did)).catch(() => { /* 第95轮：待发同清 */ })
}

// ══════════════ 2026-10-07 好友关系去服务端化：签名握手（与 PC chat_service.rs 同构）══════════════
//
// 好友关系=双方各自本地档案（youling.chat.<safeDid>.friends 即权威），变更靠三类
// 签名握手消息传播：friend-request（加）/friend-accept（接受）/friend-remove
// （删除·拒绝·忽略共用）。服务器 friends 模块已删（/friends/* 404）——信箱只做
// 对端离线时的兜底中转（30 天 TTL）。
//
// 签名主体=设备钥（与聊天鉴权同语义）；材料字段序固定（协议红线，与 PC 逐字节一致）：
//   `${kind}\n${from}\n${to}\n${fromDevice}\n${ts}\n${nonce}`，payload={to,nonce,sig,name?}
// 防冒充三件套（接收端）：payload.sig 验签 + 名册归属闸（fromDevice ∈ from 的未吊销
// 设备，/root/{from} 公开读）+ 公钥级 did 判等（accountDidEq）。ts 窗口 7 天；
// msgId/nonce 每次新生成——幂等靠状态机（friendIngest 12 格），不靠消息去重。

/** 握手 ts 窗口：7 天（离线对端经信箱兜底上线后件仍有效；更老的作废）。 */
export const FRIEND_TS_WINDOW_MS = 7 * 24 * 3600_000

/** 好友握手三 kind（chatPoll 分流/ingestMsg 防御性丢弃共用词表）。 */
export function isFriendHandshakeKind(kind: string): boolean {
  return kind === 'friend-request' || kind === 'friend-accept' || kind === 'friend-remove'
}

/** 状态机动作（与 PC FriendIngest 同语义）：status=落行/升态 / keep=幂等 / remove=删行 / drop=丢弃。 */
export type FriendIngestAction =
  | { act: 'status'; status: Friend['status'] }
  | { act: 'keep' }
  | { act: 'remove' }
  | { act: 'drop' }

/** 好友握手接收状态机（纯函数，设计 §3.4 十二格全表——单测直击，与 PC friend_ingest 同表）：
 *  request：无行→in-pending；out-pending→ok（互加即好友）；其余幂等。
 *  accept：无行→drop；两 pending→ok；ok 幂等。
 *  remove：任意态→remove（删除/被拒/被撤共用，幂等收敛）。 */
export function friendIngest(kind: string, cur: Friend['status'] | null): FriendIngestAction {
  switch (kind) {
    case 'friend-request':
      if (cur === null) return { act: 'status', status: 'in-pending' }
      if (cur === 'out-pending') return { act: 'status', status: 'ok' }
      return { act: 'keep' }
    case 'friend-accept':
      if (cur === null) return { act: 'drop' }
      if (cur === 'out-pending' || cur === 'in-pending') return { act: 'status', status: 'ok' }
      return { act: 'keep' }
    case 'friend-remove':
      return { act: 'remove' }
    default:
      return { act: 'drop' }
  }
}

/** 好友握手投递：P2P 直推（对端 PC 在线秒达；friend-* 在 PC p2p_server 好友闸豁免表）
 * → 未达走信箱 /msg/send 兜底。同一 (msgId,ts) 双路一致（nonce=msgId 每次新生成——
 * 幂等靠状态机）。设备钥签名；失败抛错（UI 提示重试——本地乐观态保留，重试幂等）。 */
async function friendDeliver(to: string, kind: string): Promise<void> {
  const my = requireMy()
  const msgId = newMsgId()
  const ts = Date.now()
  const fromDevice = currentIdentity()?.did ?? ''
  const material = friendSignMaterial(kind, my, to, fromDevice, ts, msgId)
  const sig = signFriendHandshake(material)
  if (!sig) throw new Error('身份未就绪')
  const payload: Record<string, unknown> = { to, nonce: msgId, sig, name: myName() }
  // ① P2P 直推（best-effort——手机无入站监听，直推只覆盖对端 PC 在线场景）
  try {
    const { buildEnvelope, p2pDeliver } = await import('./p2p') // 动态 import 防模块环
    if (await p2pDeliver(to, buildEnvelope(to, kind, payload, msgId, ts)).catch(() => false)) return
  } catch { /* 直推链路异常不挡信箱兜底 */ }
  // ② 信箱兜底（30 天 TTL；服务器哑中转——接收端三件套再验）
  const body = { fromAccountDid: my, fromName: myName(), toAccountDid: to, kind, payload, msgId, ts }
  const r = await signalPost('/msg/send', body)
  if (!r.ok) throw new Error(`发送失败 (${r.status})`)
}

/** 删除好友（去服务端化）：投递成功才清本地（强一致，同旧语义——好友删除不抢跑）。 */
export async function removeFriend(did: string): Promise<void> {
  requireMy()
  await friendDeliver(did, 'friend-remove')
  removeFriendLocal(did)
}

/** 好友握手接收链（chatPoll 对三 kind 的处理；ingestMsg 保持同步契约不变）：
 *  同步段（基础闸/ts 窗/验签）→ 异步名册归属 → 状态机 → 副作用。
 *  返回是否发生状态迁移（chatPoll 计数用；keep/drop/校验失败=false）。
 *  通知：FriendsPanel 好友快照 diff toast 既有机制接管（📩 请求加你为好友等）。 */
export async function ingestFriendHandshake(my: string, m: ServerMsg): Promise<boolean> {
  const payload = (m.payload || {}) as Record<string, unknown>
  // ① 基础闸：from 非空且不是我；payload.to 必须是我（防错投/改址重放）
  if (!m.from || accountDidEq(m.from, my)) return false
  const to = String(payload.to || '')
  if (!to || !accountDidEq(to, my)) return false
  // ② ts 窗口 7 天（绝对值——未来件也拒）
  const ts = Number(m.ts || 0)
  if (Math.abs(Date.now() - ts) > FRIEND_TS_WINDOW_MS) return false
  // ③ payload.sig 验签（设备 did 自带公钥——自证；材料字段序红线）
  const nonce = String(payload.nonce || '')
  const sig = String(payload.sig || '')
  if (!nonce || !sig || !m.fromDevice) return false
  const material = friendSignMaterial(m.kind, m.from, to, m.fromDevice, ts, nonce)
  if (!verifyDeviceSig(m.fromDevice, material, sig)) return false
  // ④ 名册归属闸（fromDevice ∈ from 的未吊销设备；fail-closed——查不到/网络失败=拒）
  const devPub = pubkeyB64FromDid(m.fromDevice)
  if (!devPub) return false
  const roster = await listRootDevices(m.from).catch(() => [])
  if (!roster.some((d) => !d.revoked && d.pubkeyB64 === devPub)) return false
  // ⑤ 状态机 + 副作用
  const cur = listFriends().find((f) => accountDidEq(f.did, m.from))
  const curStatus = cur ? fstOf(cur) : null
  const name = String(payload.name || m.fromName || '').trim()
  const disp = name || cur?.name || `…${m.from.slice(-4)}`
  const r = friendIngest(m.kind, curStatus)
  if (r.act === 'status' && r.status === 'in-pending') {
    upsertFriend(m.from, disp, 'in-pending')
    return true
  }
  if (r.act === 'status') {
    // 转正 ok：行升 ok + 发起方等待转正的会话凭据系统条（msgId 固定，appendMsg 幂等）
    upsertFriend(m.from, disp, 'ok')
    appendMsg(m.from, { msgId: `sys-friend-ok-${m.from}`, from: m.from, to: my, kind: 'sys', payload: { text: '你们已成为好友，开始聊天吧' }, ts: Date.now(), dir: 'in' })
    if (m.kind === 'friend-request' && curStatus === 'out-pending') {
      // 互加即好友（对方在我 out-pending 期间反向加我）：回发 accept 收敛对端
      try { await friendDeliver(m.from, 'friend-accept') } catch { /* 未达时对端重发请求再收敛 */ }
    }
    return true
  }
  if (r.act === 'remove') {
    removeFriendLocal(m.from) // 清行+会话+待发（原 friend-remove 消息语义）
    return true
  }
  if (r.act === 'keep' && name && cur && (!cur.name || cur.name.startsWith('…'))) {
    upsertFriend(m.from, name, fstOf(cur)) // 改名后重发：只刷名不动状态
  }
  return false
}

export function upsertGroup(id: string, name: string, members: string[], owner?: string): void {
  const list = listGroups()
  const i = list.findIndex((g) => g.id === id)
  if (i >= 0) {
    list[i].name = name
    list[i].members = members
    if (owner && !list[i].owner) {
      list[i].owner = owner // 第85轮：群主只认首个（建群者），不随消息覆盖
      delete list[i].ownerPending // 批二：真 owner 到位，自愈标记收敛
    }
  } else {
    list.push({ id, name, members, createdAt: Date.now(), owner, governance: 'owner' }) // 第85轮：治理恒 owner（vote 预留）
  }
  writeArr(K.groups(), list)
}

/** 批二：群消息/群任务卡兜底自愈建群（group-create 尚未到达）。owner 未知≠首成员
 *  是群主——打 ownerPending，治理闸全拒，直到 group-create（直推或对账——批二起
 *  group-create 落群会话参与对账）带真 owner 到达。 */
export function upsertGroupSelfheal(id: string, name: string, members: string[]): void {
  if (listGroups().some((g) => g.id === id)) return // 已有档案（含 owner）不动
  upsertGroup(id, name, members)
  const list = listGroups()
  const g = list.find((x) => x.id === id)
  if (g && !g.owner) { g.ownerPending = true; writeArr(K.groups(), list) }
}

/** 批二：群 owner 是否未同步（自愈建群且 group-create 未补齐）。 */
export function groupOwnerPending(g: ChatGroup): boolean { return !!g.ownerPending && !g.owner }

/** 批二：群主判定——ownerPending 时不兜底首成员（冒充群主=各端认知分叉根因）。 */
export function groupOwnerOf(g: ChatGroup): string {
  if (g.owner) return g.owner
  if (groupOwnerPending(g)) return ''
  return g.members[0] ?? ''
}

/** 批二：群终态（disbanded=已解散 / kicked=已被移出）——只读。 */
export function groupTerminalStatus(g: ChatGroup): '' | 'disbanded' | 'kicked' { return g.status ?? '' }

/** 批二：群置终态（解散/被踢共用）——档案保留（会话行只读可回查）+ members 清空
 *  （不再参与对账共享/扇出）+ 系统条 + 待发清理。幂等：已终态不重复落条。 */
function markGroupTerminal(gid: string, status: 'disbanded' | 'kicked', sysText: string, msgId: string, ts: number, from: string): void {
  const list = listGroups()
  const g = list.find((x) => x.id === gid)
  if (!g || groupTerminalStatus(g)) return // 不存在或已终态（重复投递/compat 连带）——幂等
  g.status = status
  g.members = []
  writeArr(K.groups(), list)
  appendMsg(gid, { msgId, from, to: gid, kind: 'sys', payload: { text: sysText }, ts, dir: 'in' })
  void import('./outbox').then((o) => o.removeConvOutbox(gid)).catch(() => { /* 群已死，待发不再补 */ })
}

// ══════════════ 第85轮：群管理状态机（owner 模型；单测覆盖） ══════════════
// 2026-10-07：成员/群主/禁言表一律**公钥级判等**（accountDidEq）——同一账号的历史
// did 形态（双前缀 × 双格式）不再被当成两个人（群主闸误拒/成员重复/禁言失效）。

/** 清禁言表里某账号的**全部等价形态**键（形态不同不会漏删）。 */
function mutedClear(g: ChatGroup, did: string): void {
  if (!g.muted) return
  for (const a of [did, ...accountDidAliases(did)]) delete g.muted[a]
}

/** 是否群主（无 owner 字段的老群=首个成员兜底，兼容第81轮存量；
 *  批二：ownerPending=自愈 owner 未同步 → 无人是群主，不兜底）。 */
export function isGroupOwner(g: ChatGroup, my: string): boolean {
  return accountDidEq(groupOwnerOf(g), my)
}

/** 某账号的禁言截止时刻（等价形态全覆盖；未禁言=0）。 */
export function mutedUntilOf(g: ChatGroup, did: string): number {
  if (!g.muted) return 0
  let until = 0
  for (const a of [did, ...accountDidAliases(did)]) {
    const v = g.muted[a]
    if (typeof v === 'number' && v > until) until = v
  }
  return until
}

/** 成员是否被禁言中（等价形态全覆盖）。 */
export function isMuted(g: ChatGroup, did: string, now = Date.now()): boolean {
  return mutedUntilOf(g, did) > now
}

/** 本地群档案变更统一口（members 变更校验 owner 治理权——非群主的元数据消息拒收）。
 *  批二：终态群（已解散/已被移出）一切治理拒收；ownerPending 时 groupOwnerOf 返空
 *  → 任何 from 过不了群主闸（"群主信息未同步"）。 */
function applyGroupUpdate(gid: string, from: string, mut: (g: ChatGroup) => string | null): { ok: boolean; reason?: string } {
  const list = listGroups()
  const i = list.findIndex((x) => x.id === gid)
  if (i < 0) return { ok: false, reason: '群不存在' }
  const g = list[i]
  if (groupTerminalStatus(g)) return { ok: false, reason: '群已解散或你已被移出，仅可查看历史' } // 批二：终态只读
  // 治理闸（governance='owner' 恒定，第85轮）：元数据操作只认群主。
  // 老群无 owner 字段（第81-84轮存量）：首成员兜底为群主——被踢风险为零（旧群无踢人语义）。
  const owner = groupOwnerOf(g)
  if (groupOwnerPending(g)) return { ok: false, reason: '群主信息未同步（创建者离线），暂无法管理群' } // 批二
  if (from !== owner && !accountDidEq(from, owner)) return { ok: false, reason: '非群主操作被拒' }
  const err = mut(g)
  if (err) return { ok: false, reason: err }
  writeArr(K.groups(), list)
  return { ok: true }
}

/** 群主拉人：members 全量更新 + 群里落系统条；逐成员投递 group-invite。 */
export async function groupInvite(groupId: string, newMembers: string[]): Promise<void> {
  const my = requireMy()
  const g = listGroups().find((x) => x.id === groupId)
  if (!g) throw new Error('群不存在')
  if (isDeviceGroup(g)) throw new Error('设备群为系统群，不可管理')
  if (!isGroupOwner(g, my)) throw new Error('只有群主可以拉人')
  const add = newMembers.filter((m) => m.startsWith('did:') && !g.members.some((x) => accountDidEq(x, m)))
  if (!add.length) throw new Error('没有新成员')
  const members = [...g.members, ...add]
  upsertGroup(groupId, g.name, members, g.owner ?? my)
  const sysMsg = (name: string): string => `🎉 ${name} 加入了群聊`
  for (const m of add) {
    const name = (await resolveName(m)) ?? `…${m.slice(-4)}`
    appendMsg(groupId, { msgId: `grp-join-${m}-${Date.now()}`, from: m, to: groupId, kind: 'sys', payload: { text: sysMsg(name) }, ts: Date.now(), dir: 'in' })
  }
  const targets = members.filter((m) => !accountDidEq(m, my))
  for (const t of targets) {
    await srvSendRaw(t, 'group-invite', { groupId, groupName: g.name, newMembers: add, members, from: my, fromName: myName(), ts: Date.now() })
  }
}

/** 群主改群名。 */
export async function groupRename(groupId: string, newName: string): Promise<void> {
  const my = requireMy()
  const g = listGroups().find((x) => x.id === groupId)
  if (!g) throw new Error('群不存在')
  if (isDeviceGroup(g)) throw new Error('设备群为系统群，不可管理')
  if (!isGroupOwner(g, my)) throw new Error('只有群主可以改群名')
  const name = newName.trim().slice(0, 24)
  if (!name) throw new Error('群名不能为空')
  const r = applyGroupUpdate(groupId, my, (gg) => { gg.name = name; return null })
  if (!r.ok) throw new Error(r.reason)
  for (const t of g.members.filter((m) => !accountDidEq(m, my))) {
    await srvSendRaw(t, 'group-rename', { groupId, newName: name, from: my, fromName: myName(), ts: Date.now() })
  }
}

/** 退群（任何人）：本地删档案+会话；其余成员收 group-leave。
 * 批二（2026-09-28 设计定稿）：群主退群=解散——广播 group-disband（新 kind，全体成员：
 * 群会话保留只读+members 清空+系统条"群已被解散"），compat group-leave 随发（老端
 * 优雅降级为"群主退出了群聊"，不崩）；群主本端同样置终态只读。非群主维持现语义。 */
export async function groupLeave(groupId: string): Promise<void> {
  const my = requireMy()
  const g = listGroups().find((x) => x.id === groupId)
  if (!g) return
  if (isDeviceGroup(g)) throw new Error('设备群为系统群，不可退出（成员随设备收编/吊销自动进出）')
  if (isGroupOwner(g, my)) {
    const ts = Date.now()
    markGroupTerminal(groupId, 'disbanded', `群「${g.name}」已被群主解散`, `grp-disband-${groupId}`, ts, my)
    for (const t of g.members.filter((m) => !accountDidEq(m, my))) {
      // 先 disband（新端只认它）后 leave（老端 compat——新端终态闸拒收，不双系统条）
      await srvSendRaw(t, 'group-disband', { groupId, groupName: g.name, from: my, fromName: myName(), ts })
      await srvSendRaw(t, 'group-leave', { groupId, from: my, fromName: myName(), ts })
    }
    return
  }
  writeArr(K.groups(), listGroups().filter((x) => x.id !== groupId))
  try { convRemoveKeys(groupId) } catch { /* 忽略 */ }
  void import('./outbox').then((o) => o.removeConvOutbox(groupId)).catch(() => { /* 第95轮：退群清待发 */ })
  for (const t of g.members.filter((m) => !accountDidEq(m, my))) {
    await srvSendRaw(t, 'group-leave', { groupId, from: my, fromName: myName(), ts: Date.now() })
  }
}

/** 群主踢人。 */
export async function groupKick(groupId: string, targetDid: string): Promise<void> {
  const my = requireMy()
  const g = listGroups().find((x) => x.id === groupId)
  if (!g) throw new Error('群不存在')
  if (isDeviceGroup(g)) throw new Error('设备群为系统群，不可管理')
  if (!isGroupOwner(g, my)) throw new Error('只有群主可以移出成员')
  if (accountDidEq(targetDid, my)) throw new Error('不能踢自己（退群用退出按钮）')
  const members = g.members.filter((m) => !accountDidEq(m, targetDid))
  const r = applyGroupUpdate(groupId, my, (gg) => {
    gg.members = members
    mutedClear(gg, targetDid)
    return null
  })
  if (!r.ok) throw new Error(r.reason)
  for (const t of members.filter((m) => !accountDidEq(m, my))) {
    await srvSendRaw(t, 'group-kick', { groupId, targetDid, members, from: my, fromName: myName(), ts: Date.now() })
  }
  // 被踢者单独一份（他也要删档案）——members 里已无他，上面循环没发给他
  await srvSendRaw(targetDid, 'group-kick', { groupId, targetDid, members, from: my, fromName: myName(), ts: Date.now() })
}

/** 群主禁言/解禁（mutedUntil=0 解禁）。 */
export async function groupMute(groupId: string, targetDid: string, mutedUntil: number): Promise<void> {
  const my = requireMy()
  const g = listGroups().find((x) => x.id === groupId)
  if (!g) throw new Error('群不存在')
  if (isDeviceGroup(g)) throw new Error('设备群为系统群，不可管理')
  if (!isGroupOwner(g, my)) throw new Error('只有群主可以禁言')
  const r = applyGroupUpdate(groupId, my, (gg) => {
    gg.muted = gg.muted ?? {}
    if (mutedUntil > 0) { mutedClear(gg, targetDid); gg.muted[targetDid] = mutedUntil }
    else mutedClear(gg, targetDid)
    return null
  })
  if (!r.ok) throw new Error(r.reason)
  for (const t of g.members.filter((m) => !accountDidEq(m, my))) {
    await srvSendRaw(t, 'group-mute', { groupId, targetDid, mutedUntil, from: my, fromName: myName(), ts: Date.now() })
  }
}

// ══════════════ 设备群（2026-10-07 设计 §3，docs/design/设备群设计.md；PC 对等=chat_service.rs T1/T2） ══════════════

export const DEVICE_GROUP_NAME = '设备群'

/** 设备群会话 id：grp-dev-{did_safe(canonical 账号 did)}——与 PC device_group_id 同式
 *  （canonical 归一防同账号 did 多形态派生出两个群；grp- 前缀保全库判群语义）。 */
export function deviceGroupId(rootDid: string): string {
  return `grp-dev-${didSafeId(accountDidCanonical(rootDid))}`
}

/** 设备群判定（与 Rust is_device_group 同式）：档案 kind='device' 或 id 前缀 grp-dev-。 */
export function isDeviceGroup(g: { id?: string; kind?: string } | null | undefined): boolean {
  if (!g) return false
  if (g.kind === 'device') return true
  return typeof g.id === 'string' && g.id.startsWith('grp-dev-')
}

/** 设备群 ingest 方向判定（决策 D.1，纯函数）：信封 fromDevice==本机设备 did → out
 *  （本机发出的消息经对账/多端回流，归位右侧）；他机（同事设备）→ in；fromDevice
 *  缺失（老端/信箱路径）→ in 保守（宁可当收到的，不把别人的当自己的）。 */
export function deviceGroupIngestDir(devGroup: boolean, myDeviceDid: string | null | undefined, fromDevice: string | null | undefined): 'in' | 'out' {
  return devGroup && !!myDeviceDid && !!fromDevice && fromDevice === myDeviceDid ? 'out' : 'in'
}

/** 名册设备行（/presence/by-root 返回形态；identity.fetchPresenceByRoot 产出）。 */
export interface RosterDevice { did: string; name?: string; online?: boolean; revoked?: boolean; isEmbodiment?: boolean; lastSeen?: number }

/** 设备群计数（决策 C：名册即成员表——吊销不算成员；在线=未吊销且 online）。纯函数。 */
export function deviceGroupCountsOf(devices: RosterDevice[]): { total: number; online: number } {
  const alive = devices.filter((d) => d && !d.revoked)
  return { total: alive.length, online: alive.filter((d) => d.online).length }
}

/** 每设备本地幂等 ensure（决策 B.3）：档案在→只校正 kind/name/members/owner；不在→
 *  建（kind=device）+ 一条系统条（msgId 确定性 devgrp-init-{gid}，对账幂等去重）。
 *  未登录（无账号 did）→ null 不建。挂点：App.tsx 账号加载后 + FriendsPanel 挂载
 *  （幂等，多处调用无害）；localStorage groups 沿用现有账号桶 key（K.groups）。 */
export function ensureDeviceGroup(): string | null {
  const my = myAccountDid()
  if (!my) return null
  const gid = deviceGroupId(my)
  const list = listGroups()
  const hit = list.find((g) => g.id === gid)
  if (hit) {
    let changed = false
    if (hit.kind !== 'device') { hit.kind = 'device'; changed = true }
    if (hit.name !== DEVICE_GROUP_NAME) { hit.name = DEVICE_GROUP_NAME; changed = true }
    if (!hit.members.some((mm) => accountDidEq(mm, my))) { hit.members = [my, ...hit.members]; changed = true }
    // 自愈建群兜底路径（群消息先于 ensure 到达）会打 ownerPending——设备群 owner 恒=自己
    if (!hit.owner || !accountDidEq(hit.owner, my)) { hit.owner = my; changed = true }
    if (hit.ownerPending) { delete hit.ownerPending; changed = true }
    if (changed) writeArr(K.groups(), list)
    return gid
  }
  list.push({ id: gid, name: DEVICE_GROUP_NAME, members: [my], createdAt: 0, owner: my, governance: 'owner', kind: 'device' })
  writeArr(K.groups(), list)
  appendMsg(gid, {
    msgId: `devgrp-init-${gid}`, from: my, to: gid, kind: 'sys',
    payload: { text: '📱 设备群已开启：本账号全部设备自动入群（群发/传文件）' },
    ts: Date.now(), dir: 'in',
  })
  return gid
}

/** 首见置顶种子（决策 F，一次性；用户可取消——取消后标记仍在，不复活）。
 *  手机 convprefs 取消置顶会**删键**（PC 是键驻留 {pin:undefined}），键存在性判不了
 *  "种过"——用每账号桶一个显式标记位（youling.chat.<safeDid>.devgrpPinSeeded）。 */
export function seedDeviceGroupPin(): void {
  const gid = ensureDeviceGroup()
  if (!gid) return
  const flag = `${accPrefix()}.devgrpPinSeeded`
  if (storage.get(flag) === '1') return
  storage.set(flag, '1')
  setConvPinned(gid, true)
}

/** 追加会话消息（200 条滚动）+ 对账摘要维护（ids 全量——显示层滚动丢弃，
 *  msgId 索引保留：对账语义完整，历史可从对端拉回）。幂等：msgId 重复丢弃。
 *  返回是否真实入库（批四：通知钩子据此判重——对账双份不重复通知）。 */
export function appendMsg(convId: string, m: ChatMsg): boolean {
  if (!convMetaAppend(convId, m.msgId, m.ts)) return false // 重复（对账/直推双份）——幂等丢弃
  if (m.msgId) wireSeenIds.add(m.msgId) // 2026-10-18：任何已落库的 msgId 都进去重索引
  const k = K.conv(convId) // 唯一写目标 = 归一键（形态不再分裂）
  let arr: ChatMsg[] = []
  try { arr = JSON.parse(storage.get(k) || '[]') as ChatMsg[] } catch { arr = [] }
  arr.push(m)
  if (arr.length > CONV_MAX) arr = arr.slice(arr.length - CONV_MAX)
  storage.set(k, JSON.stringify(arr))
  return true
}

/** 归并读取：该会话**全部等价键**按归一键优先的顺序拼接，再按 (ts,msgId) 排序 +
 *  同 msgId 去重（sortConvMsgs，先到者胜 = 归一键优先）——存量"同账号两形态两份键"
 *  从此读成一个会话。不迁移、不删档。 */
export function loadConv(convId: string): ChatMsg[] {
  const arr: ChatMsg[] = []
  for (const k of convKeysAll(convId)) {
    try {
      const part = JSON.parse(storage.get(k) || '[]') as ChatMsg[]
      if (Array.isArray(part)) arr.push(...part)
    } catch { /* 坏键跳过（与旧行为一致） */ }
  }
  // 第95轮：合并排序——对账灌入的历史（ts 早于现有）物理 append 在尾部，
  // 直接按存储序渲染=旧消息冒到最新位置；按 (ts,msgId) 排序后时间序单调，
  // 本地新消息（ts=now）恒在历史之后——同步进行中上屏位置稳定不跳变。
  return sortConvMsgs(arr)
}

/** 第95轮：会话消息合并排序（纯函数，单测覆盖；与 PC sort_conv_msgs 同语义）：
 *  ① 按 msgId 去重（首见保留；空 msgId 不去重）
 *  ② 按 (ts, msgId) 升序——时间序整体单调，双端合并结果确定性一致。 */
export function sortConvMsgs(msgs: ChatMsg[]): ChatMsg[] {
  const seen = new Set<string>()
  const dedup = msgs.filter((m) => {
    if (!m.msgId) return true
    if (seen.has(m.msgId)) return false
    seen.add(m.msgId)
    return true
  })
  return dedup.sort((a, b) => (a.ts - b.ts) || a.msgId.localeCompare(b.msgId))
}

/** 视图片段一致（msgId + 发送态；payload 变化只在撤回/编辑类操作发生，走整份替换）。 */
function sameConvPrefix(prev: ChatMsg[], next: ChatMsg[]): boolean {
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]
    const b = next[i]
    if (!b || a.msgId !== b.msgId || a.sendState !== b.sendState) return false
  }
  return true
}

/** 2026-10-18 渲染风暴治理：聊天屏读库结果 → 视图的**增量合并**（纯函数，单测覆盖）。
 *  对账/入库事件一秒可能多拍，旧实现每拍 `setMsgs(loadConv(convId))` 全量解析+全列表
 *  重渲（批量 20 条时端到端上屏被放大到 P50 4.6s）。这里：
 *  - 完全一致 → 返回 prev（React 不重渲）；
 *  - 纯尾部追加 → `[...prev, ...新增]`（增量渲染，老气泡引用不变、滚动位置不跳）；
 *  - 其它（历史补齐/撤回/发送态变更）→ 整份替换（正确优先）。 */
export function mergeConvView(prev: ChatMsg[], next: ChatMsg[]): ChatMsg[] {
  if (next.length === prev.length && sameConvPrefix(prev, next)) return prev
  if (next.length > prev.length && sameConvPrefix(prev, next)) return [...prev, ...next.slice(prev.length)]
  return next
}

/** 逐等价键读改写（撤回 tombstone/删除单条/回写 sendState 共用底座）。
 *  归并视图里的一条消息物理上可能躺在任一形态键里——只重写**命中**的那份
 *  （把合并结果整份写回归一键会重复/丢消息）。返回是否有命中改动。 */
function convRewrite(convId: string, f: (m: ChatMsg) => boolean): boolean {
  let any = false
  for (const k of convKeysAll(convId)) {
    const raw = storage.get(k)
    if (!raw) continue
    let arr: ChatMsg[]
    try {
      const parsed = JSON.parse(raw) as ChatMsg[]
      if (!Array.isArray(parsed)) continue
      arr = parsed
    } catch { continue }
    let hit = false
    for (const m of arr) if (f(m)) hit = true
    if (!hit) continue
    any = true
    storage.set(k, JSON.stringify(arr))
  }
  return any
}

/** 第95轮：回写某条消息的 sendState（补发成功 sent / 重试失败 failed）——
 *  UI 状态徽标数据源；调用方负责触发重渲。 */
export function updateSendState(convId: string, msgId: string, state: ChatMsg['sendState']): boolean {
  return convRewrite(convId, (m) => {
    if (m.msgId !== msgId) return false
    m.sendState = state
    return true
  })
}

/** 批四：删除单条消息显示行（撤回/长按"删除本地"共用）。
 *  墓碑语义：**不动 convmeta.ids**——撤回的行从显示层消失，但 msgId 索引保留，
 *  否则下次对账 diff 判定"我方缺这条"会把对端副本再拉回来（撤回复活）。
 *  2026-10-07：逐等价键命中（消息可能躺在历史形态键里）。 */
export function deleteMsgLocal(convId: string, msgId: string): boolean {
  let any = false
  for (const k of convKeysAll(convId)) {
    const raw = storage.get(k)
    if (!raw) continue
    let arr: ChatMsg[]
    try {
      const parsed = JSON.parse(raw) as ChatMsg[]
      if (!Array.isArray(parsed)) continue
      arr = parsed
    } catch { continue }
    const next = arr.filter((m) => m.msgId !== msgId)
    if (next.length === arr.length) continue
    any = true
    storage.set(k, JSON.stringify(next))
  }
  return any
}

/** 渲染序（2026-09-29 Bug1 修）：聊天滚动容器是 column-reverse（DOM 首个孩子=视觉
 *  底部，见 phone-chat.css .chat-scroll），因此 DOM 序必须=时间倒序（新→旧）——
 *  视觉才是旧→新、最新消息贴在底部输入框上方（微信语义）。存储本身正序追加
 *  （appendMsg push），渲染层统一经本函数倒序（ChatView 的 messages.reverse()
 *  同约定）。曾直接 msgs.map 正序渲染 → 最新顶到屏幕最上面（实测反馈）。 */
export function renderOrderMsgs(msgs: ChatMsg[]): ChatMsg[] {
  return [...msgs].reverse()
}
/** 会话小 map（seen/drafts/convprefs）的别名读：归一键优先，回落存量形态键。
 *  2026-10-07：这些 map 此前按 `didSafe(convId)` 裸串存——同一对端两形态键 → 未读数
 *  "永远未读"/草稿丢失/置顶失效；读侧跨等价键查找即愈合（不迁移存量）。 */
function mapConvGet<T>(map: Record<string, T>, convId: string): T | undefined {
  for (const s of convSafesAll(convId)) {
    const v = map[s]
    if (v !== undefined) return v
  }
  return undefined
}
/** 写：归一键一个键；`null`（清空语义）时连同存量形态键一并删——否则旧形态残留会让
 *  "清空/取消置顶"读出不存在的旧值。 */
function mapConvSet<T>(map: Record<string, T>, convId: string, value: T | null): void {
  if (value === null) {
    for (const s of convSafesAll(convId)) delete map[s]
    return
  }
  map[convSafe(convId)] = value
}

export function markSeen(convId: string): void {
  const seen = seenMap()
  mapConvSet(seen, convId, Date.now())
  storage.set(K.seen(), JSON.stringify(seen))
  // 小灵会话：打开即回执 /official/read（幂等；服务端三态 queued/delivered/read）
  if (isOfficialConv(convId)) {
    const my = myAccountDid()
    const ids = loadConv(convId)
      .filter((m) => m.kind === OFFICIAL_NOTICE_KIND)
      .map((m) => String((m.payload as { noticeId?: string }).noticeId || ''))
      .filter(Boolean)
    if (my && ids.length) void ackOfficialNotices(my, ids).catch(() => {})
  }
}
export function seenMap(): Record<string, number> {
  try { return JSON.parse(storage.get(K.seen()) || '{}') as Record<string, number> } catch { return {} }
}
/** 某会话最后已读时刻（等价键取最大——旧形态残留不影响新值）。 */
function seenOf(seen: Record<string, number>, convId: string): number {
  let v = 0
  for (const s of convSafesAll(convId)) {
    const t = seen[s]
    if (typeof t === 'number' && t > v) v = t
  }
  return v
}

// ══════════════ 批四：入站通知钩子（系统通知/App 徽章数据源） ══════════════
/** 内容类消息真实入库（去重后）时触发；sys/群管理/撤回不触发（各自 UI 自刷新）。 */
export type IngestListener = (convId: string, m: ChatMsg) => void
const ingestListeners = new Set<IngestListener>()
export function onMessageIngested(l: IngestListener): () => void {
  ingestListeners.add(l)
  return () => { ingestListeners.delete(l) }
}
function fireIngest(convId: string, m: ChatMsg): void {
  ingestListeners.forEach((l) => { try { l(convId, m) } catch { /* 监听器异常不殃及入库 */ } })
}

// ══════════════ 批四：草稿（按会话；localStorage 持久——杀进程也留） ══════════════

function readDrafts(): Record<string, string> {
  try { return JSON.parse(storage.get(K.drafts()) || '{}') as Record<string, string> } catch { return {} }
}
export function getDraft(convId: string): string {
  return mapConvGet(readDrafts(), convId) ?? ''
}
/** 写草稿；空串=删键（发送成功/清空后不留残；等价形态键一并清）。 */
export function setDraft(convId: string, text: string): void {
  const d = readDrafts()
  mapConvSet(d, convId, text || null)
  storage.set(K.drafts(), JSON.stringify(d))
}

// ══════════════ 批四：会话偏好（置顶/免打扰——长按会话行菜单写入） ══════════════

export interface ConvPref { pinned?: number; muted?: boolean }
function readPrefs(): Record<string, ConvPref> {
  try { return JSON.parse(storage.get(K.convprefs()) || '{}') as Record<string, ConvPref> } catch { return {} }
}
export function convPref(convId: string): ConvPref {
  return mapConvGet(readPrefs(), convId) ?? {}
}
export function setConvPinned(convId: string, on: boolean): void {
  const p = readPrefs()
  const cur = mapConvGet(p, convId) ?? {}
  if (on) mapConvSet(p, convId, { ...cur, pinned: Date.now() })
  else {
    const next = { ...cur }
    delete next.pinned
    mapConvSet(p, convId, Object.keys(next).length ? next : null)
  }
  storage.set(K.convprefs(), JSON.stringify(p))
}
export function setConvMuted(convId: string, on: boolean): void {
  const p = readPrefs()
  const cur = mapConvGet(p, convId) ?? {}
  if (on) mapConvSet(p, convId, { ...cur, muted: true })
  else {
    const next = { ...cur }
    delete next.muted
    mapConvSet(p, convId, Object.keys(next).length ? next : null)
  }
  storage.set(K.convprefs(), JSON.stringify(p))
}

/** 批四：会话单独删除（不删好友/群档案）——消息+对账 meta+待发队列+草稿全清。 */
export function deleteConv(convId: string): void {
  try { convRemoveKeys(convId) } catch { /* 忽略 */ }
  void import('./outbox').then((o) => o.removeConvOutbox(convId)).catch(() => { /* 待发同清 */ })
  setDraft(convId, '')
}

/** 批四：数字未读计数（>0 的 dir=in 且晚于 seen 的消息条数）。 */
export function unreadCount(convId: string): number {
  const last = seenOf(seenMap(), convId)
  return loadConv(convId).filter((m) => m.dir === 'in' && m.ts > last).length
}

/** 批四：App 级未读总数（免打扰会话不计——微信语义）。 */
export function unreadTotal(): number {
  const seen = seenMap()
  let n = 0
  const acc = (id: string) => {
    if (convPref(id).muted) return
    const last = seenOf(seen, id)
    n += loadConv(id).filter((m) => m.dir === 'in' && m.ts > last).length
  }
  for (const f of listFriends()) if ((f.status ?? 'ok') === 'ok') acc(f.did)
  for (const g of listGroups()) acc(g.id)
  return n
}

/** 批四：会话行排序（微信语义，纯函数，单测覆盖）：置顶优先（置顶时刻升序=先置顶的在前），
 *  其余按 lastTs 倒序（新消息浮顶）。 */
export function sortConvRows<T extends { pinned?: boolean; pinTs?: number; lastTs: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    if (a.pinned && b.pinned) return (a.pinTs ?? 0) - (b.pinTs ?? 0)
    return b.lastTs - a.lastTs
  })
}

/** 批四：时间分隔判定（纯函数，单测覆盖）——>5min 断开显示居中时间条。 */
export const TIME_SEP_GAP_MS = 5 * 60_000
export function needTimeSep(prevTs: number | null | undefined, curTs: number): boolean {
  if (prevTs == null) return true // 首条恒显（微信：第一条消息带时间）
  return curTs - prevTs > TIME_SEP_GAP_MS
}
/** 跨天判定（本地时区日历日）。 */
export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a); const db = new Date(b)
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate()
}
/** 会话行/时间条共用的时间格式化（微信同款规则）：
 *  今天→HH:MM；昨天→"昨天"；一周内→"星期x"；更早→"M月D日"；跨年→"YYYY/M/D"。
 *  withTime=true（聊天区时间条）时今天带 HH:MM、昨天/星期/日期也补时分。 */
export function fmtConvTime(ts: number, withTime = false): string {
  const d = new Date(ts)
  const now = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const sameDay = isSameDay(ts, now.getTime())
  if (sameDay) return hm
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (isSameDay(ts, yest.getTime())) return withTime ? `昨天 ${hm}` : '昨天'
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  const diffDays = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000)
  if (diffDays < 7) return withTime ? `星期${weekDays[d.getDay()]} ${hm}` : `星期${weekDays[d.getDay()]}`
  if (d.getFullYear() === now.getFullYear()) return withTime ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日`
  return withTime ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 媒体键索引（FIFO 队列记在专用键，淘汰最老媒体防 localStorage 撑爆）。第96轮：随账号分桶。 */
const mediaIndexKey = (): string => `${accPrefix()}.media.index`
export function storeMedia(msgId: string, b64: string): void {
  storage.set(K.media(msgId), b64)
  mediaIndexPush(msgId)
}
export function loadMediaB64(msgId: string): string | null {
  return storage.get(K.media(msgId))
}

/** 媒体 FIFO 索引共用（localStorage 图片键 + IndexedDB 文件键同队淘汰）。 */
function mediaIndexPush(msgId: string): void {
  const idx = (() => { try { return JSON.parse(storage.get(mediaIndexKey()) || '[]') as string[] } catch { return [] } })()
  idx.push(msgId)
  while (idx.length > MEDIA_MAX) {
    const old = idx.shift()
    if (old) { storage.del(K.media(old)); fileMediaDel(old) }
  }
  storage.set(mediaIndexKey(), JSON.stringify(idx))
}

// ══════════════ 第94轮：文件媒体（IndexedDB；localStorage ~5MB 装不下 10MB 文件） ══════════════
// 图片继续走 localStorage（≤2MB、同步读渲染气泡）；任意文件 b64 走 IndexedDB
// （配额宽裕、异步读写——文件卡渲染只需要 name/size/mime，点击打开时才取字节）。
// 环境无 indexedDB（vitest/node）时退内存 Map（单测可注入），生产浏览器/WebView 恒有。

const FILE_DB_NAME = 'myco-chat-media'
const FILE_STORE = 'files'
const memFileMedia = new Map<string, string>()

function fileDbOpen(): Promise<IDBDatabase | null> {
  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null)
    return new Promise((res) => {
      const r = indexedDB.open(FILE_DB_NAME, 1)
      r.onupgradeneeded = () => { r.result.createObjectStore(FILE_STORE) }
      r.onsuccess = () => res(r.result)
      r.onerror = () => res(null)
    })
  } catch { return Promise.resolve(null) }
}

/** 文件 b64 写 IndexedDB（含 FIFO 登记；无 IDB 环境退内存——同样进 FIFO 索引）。 */
export async function fileMediaPut(msgId: string, b64: string): Promise<void> {
  const db = await fileDbOpen()
  if (!db) {
    memFileMedia.set(msgId, b64)
    mediaIndexPush(msgId)
    return
  }
  await new Promise<void>((res) => {
    const tx = db.transaction(FILE_STORE, 'readwrite')
    tx.objectStore(FILE_STORE).put(b64, msgId)
    tx.oncomplete = () => res()
    tx.onerror = () => res()
  })
  mediaIndexPush(msgId)
}

/** 读文件 b64（localStorage 兜底——早期形态/内存环境）。 */
export async function loadFileB64(msgId: string): Promise<string | null> {
  const local = storage.get(K.media(msgId))
  if (local) return local
  const db = await fileDbOpen()
  if (!db) return memFileMedia.get(msgId) ?? null
  return new Promise((res) => {
    const tx = db.transaction(FILE_STORE, 'readonly')
    const rq = tx.objectStore(FILE_STORE).get(msgId)
    rq.onsuccess = () => res(typeof rq.result === 'string' ? rq.result : null)
    rq.onerror = () => res(null)
  })
}

function fileMediaDel(msgId: string): void {
  memFileMedia.delete(msgId)
  void fileDbOpen().then((db) => {
    if (!db) return
    const tx = db.transaction(FILE_STORE, 'readwrite')
    tx.objectStore(FILE_STORE).delete(msgId)
  }).catch(() => { /* 淘汰失败静默 */ })
}

// ══════════════ 纯逻辑（单测覆盖） ══════════════

/** 第94轮：文件大小格式化（文件卡气泡用；与 PC ChatBubble.fmtFileSize 同款）。 */
export function fmtFileSize(bytes?: number): string {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** 第94轮：任意文件上限——10MB 二进制（b64 ≈ 13.4M 字符，上限留裕量）。
 *  与 PC chat_service.rs FILE_B64_MAX 对齐；p2p_server body limit 已同步 16MB。 */
export const FILE_MAX_BYTES = 10 * 1024 * 1024
export const FILE_B64_MAX = 14_000_000

/** 发送前校验（纯函数，单测覆盖）：超限抛错由 UI 拦截提示。 */
export function assertFileSize(size: number): void {
  if (size > FILE_MAX_BYTES) throw new Error('文件过大（>10MB），暂不支持')
}

/** 会话预览文本。 */
export function convPreview(m: ChatMsg): string {
  const p = m.payload as { text?: string; name?: string; title?: string }
  switch (m.kind) {
    case 'text': case 'group-msg': return p.text || '[图片]'
    case 'image': return '[图片]'
    case 'file': return `[文件] ${p.name || ''}`
    case 'task-share': return `[任务卡] ${p.title || ''}`
    // 2026-10-11 任务卡改名：留痕系统条的会话预览
    case 'task-rename': return `✏️ 任务卡改名为「${p.title || ''}」`
    // 第83轮：带 name（接受/完成者）——"一起"语系
    case 'task-accept': return p.name ? `${p.name} 一起接了任务《${p.title || ''}》` : `已接受任务《${p.title || ''}》`
    case 'task-done': return p.name ? `${p.name} 完成了任务《${p.title || ''}》` : `已完成任务《${p.title || ''}》`
    // 批二：group-create 落群会话（对账载体）——预览人话
    case 'group-create': return `群「${(m.payload as { groupName?: string }).groupName || '群'}」已创建`
    default: return p.text || ''
  }
}

/** 任务卡是否过期。 */
export function taskExpired(t: { expiresAt?: number }): boolean {
  return !!t.expiresAt && t.expiresAt < Date.now()
}

/** 第83轮：participants 合并去重（by did；incoming 覆盖 role/status/时间戳，name 取非空者）。
 * 纯函数——接受/完成回执带全量 participants 上线，本地合并（不新增服务端接口）。单测覆盖。 */
export function mergeParticipants(cur: TaskParticipant[] | undefined, inc: TaskParticipant[]): TaskParticipant[] {
  const out = (cur ?? []).map((p) => ({ ...p }))
  for (const p of inc ?? []) {
    if (!p?.did) continue
    const i = out.findIndex((q) => q.did === p.did)
    if (i >= 0) {
      const q = out[i]
      if (p.role) q.role = p.role
      if (p.status) q.status = p.status
      if (p.acceptedAt) q.acceptedAt = p.acceptedAt
      if (p.doneAt) q.doneAt = p.doneAt
      if (p.name && !q.name) q.name = p.name
    } else out.push({ ...p })
  }
  return out
}

/**
 * 设备群广播的 `task-share` payload → **摊平后的卡**（纯函数；单测锁形状）。
 *
 * 真形状（PC 端 `chat_service::device_group_card_payload`，2026-10-09）：
 * ```
 * 外层 {groupId, groupName, members:[账号did], fromName, status, card:{…}}
 * card {taskId,title,desc,from,fromName,createdAt,source:"dsh-share",
 *       shareId,granularity,participants,status,sourceDevice,sourceDeviceName,action}
 * ```
 * 桌面端接收侧（`upsert_device_group_task`）把 `card` **摊平**进本地任务库再叠
 * `sourceDevice/sourceDeviceName/status/remoteOrigin/action`——手机必须同口径，
 * 否则 `title/shareId/sourceDevice` 全 undefined：卡上没标题、也没有「打开」入口。
 *
 * 规则（**只加不减**，平铺形态原样返回）：
 *   · `card` 的字段为准（它就是那张卡）；
 *   · 外层信封键（groupId/groupName/members/fromName/fromDevice…）只在卡里缺时补
 *     ——路由与署名信息不能丢；
 *   · **交付状态以「外层」为准**（PC 端下调 `status` 覆盖卡里那份：分享下线同步 done）；
 *   · 账号坐标补 `sourceAccount`（`members[0]` 是账号 did，最可靠；再退 `from`）——
 *     手机 `shareCardOf` 靠它比对 grant 名单。
 */
export function flattenTaskSharePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload?.card
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return payload
  const flat: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  for (const k of ['groupId', 'groupName', 'members', 'fromName', 'fromDevice', 'fromDeviceName', 'account']) {
    if (flat[k] === undefined && payload[k] !== undefined) flat[k] = payload[k]
  }
  // 交付状态：外层权威（卡里那份可能是建卡时的快照）
  if (typeof payload.status === 'string' && payload.status) flat.status = payload.status
  // 账号坐标（shareCardOf 的 sourceAccount 四级兜底在摊平后依然成立；这里补最可靠那条）
  const members = Array.isArray(payload.members) ? (payload.members as unknown[]) : []
  if (!flat.sourceAccount) {
    const cand = [flat.account, members[0], flat.from, payload.from]
    for (const c of cand) {
      if (typeof c === 'string' && c.trim()) {
        flat.sourceAccount = c.trim()
        break
      }
    }
  }
  // 来源设备名：卡里没有就退外层的（设备群广播的 fromName 就是来源设备名）
  if (!flat.sourceDeviceName && typeof payload.fromName === 'string' && payload.fromName.trim()) {
    flat.sourceDeviceName = payload.fromName
  }
  // 坐标最后一道兜底（2026-10-10）：卡顶层缺 shareId/sourceDevice 时，从 action.url
  // 的 query 抠齐（remoteOpen 入口本就带三坐标）——入库即完整，下游 shareCardOf /
  // taskShareCardOf / UI 展示全受益，不用再各自兜底。只补缺的，不覆盖卡里已有的。
  const urlQ = actionShareCoords(flat)
  if (!String(flat.shareId || '').trim() && urlQ.shareId) flat.shareId = urlQ.shareId
  if (!String(flat.sourceDevice || '').trim() && urlQ.device) flat.sourceDevice = urlQ.device
  if (!flat.sourceAccount && urlQ.account) flat.sourceAccount = urlQ.account
  return flat
}

/* ═══ 任务卡标题 mojibake 防护（2026-10-11 手机实测"??"-DSH????"根因） ═══
 * 病灶不在生产链路（fetch/reqwest/axum/原生隧道 base64 全程 UTF-8——同机会话里
 * 对账拉到的中文标题完好）：是**调试通道**把烂数据灌进了本机库——EnvServer
 * `/api/intent` eval 经 Windows PowerShell 5.1 发 POST 时，字符串 body 被按
 * ISO-8859-1 **best-fit** 编码（中文塌成 `?`、U+00B7→0xB7→UTF-8 解码成 U+FFFD、
 * 全角标点折半角），注入的 demo 卡标题就烂成了 `??-DSH????`。数据修复靠干净
 * 重投递/改名；这两个纯函数只管**显示兜底**：DSH 分享卡的标题已烂时，给一个
 * 可读的「分享·尾4」，别把 `????` 糊用户脸上。 */

/** 标题是否是 mojibake 烂尾形态（含 U+FFFD 或 ≥2 连问号）。 */
export function titleLooksMojibake(title: string | undefined | null): boolean {
  if (!title) return false
  return title.includes('\uFFFD') || /\?{2,}/.test(title)
}

/** 任务卡显示标题：**仅 DSH 分享卡**（有 shareId）烂尾时兜回「分享·尾4」；
 *  普通任务卡标题原样（用户真打了 `???` 也照显——不替用户改字）。
 *  2026-10-25：标题过 `cleanCardTitle`——老环境卡的卡名带 `127.0.0.1:端口`（旧建卡
 *  模板），显示时抹掉；数据与打开链路不动。 */
export function taskDispTitle(t: { title?: string; taskId?: string; shareId?: string }): string {
  const raw = String(t.title || '')
  if (t.shareId && titleLooksMojibake(raw)) return `分享·${String(t.shareId).slice(-4)}`
  return cleanCardTitle(raw) || '任务'
}

/** 任务卡改名入站（task-rename，2026-10-11；与 PC `chat_service::ingest_task_rename` 逐条同语义）：
 *  ① 本地有这张卡才受理（没有=rename 先于卡到达/陌生卡 → false 不落 meta，对账会再带）；
 *  ② **安全闸**：信封 from == task.from（公钥级）——非 owner 伪造一律拒收；
 *  ③ ts 大者生效（≤ 本地 titleTs = 重复投递/迟到旧值 → 不覆盖不落行）；
 *  ④ 更新 title + 落一条会话行（系统条留痕 + **对账载体**：owner 多端/参与者手机都靠它拉到；
 *     设备群载体行 payload.groupId=grp-dev-* 落设备群，渲染层过滤）。 */
function ingestTaskRename(my: string, m: ServerMsg): boolean {
  const p = m.payload || {}
  const taskId = String(p.taskId || '').trim()
  const titleRaw = String(p.title || '').trim()
  if (!taskId || !titleRaw) return false
  const title = titleRaw.slice(0, 64) // 防御性截断（不信任 wire 长度；发送侧同样 ≤64）
  const ts = Number(p.ts || m.ts || Date.now())
  const from = m.from
  const tasks = listTasks()
  const t = tasks.find((x) => x.taskId === taskId)
  if (!t) return false
  if (!t.from || !accountDidEq(from, t.from)) return false // 安全闸：只有 owner 能改
  if (ts <= (t.titleTs ?? 0)) return true // 幂等/迟到旧值
  t.title = title
  t.titleTs = ts
  writeArr(K.tasks(), tasks)
  const gid = typeof p.groupId === 'string' && p.groupId.startsWith('grp-') ? p.groupId : ''
  const selfEcho = accountDidEq(from, my)
  // 单聊自同步回流归位到「与 to 的会话」（与第84轮同语义）；群/设备群按 groupId 落
  const convTarget = gid || (selfEcho && m.to ? didSafe(m.to) : (!selfEcho && from ? didSafe(from) : ''))
  if (!convTarget) return true // 标题已应用；行没处落（异常形态）——不强行落
  const row: ChatMsg = {
    msgId: m.id, from, to: gid || (selfEcho ? (m.to || my) : my), kind: 'task-rename',
    payload: { taskId, title, ts, ...(gid ? { groupId: gid } : {}) },
    ts, dir: selfEcho ? 'out' : 'in', fromName: m.fromName || '',
  }
  if (appendMsg(convTarget, row)) fireIngest(convTarget, row) // msgId 幂等（直推+对账双份）
  return true
}

/** 单条入站消息入库（状态机，返回是否入库）。 */
export function ingestMsg(my: string, m: ServerMsg): boolean {
  // 2026-10-20 小灵官方通知：验签通过才落「小灵」会话（与 PC ingest_msg 同位置）
  if (m.kind === OFFICIAL_NOTICE_KIND) return ingestOfficialNotice(my, m)
  // 2026-10-09 跨设备「代打开」控制 kind（与 PC 端 chat_service::ingest_msg 同位置、同语义）：
  //   · `share-entry-grant`：源设备现签的窄票回来了 → 唤醒在等的「点卡就进」。
  //     **没有会话语义**，落行会把"收到一张票"变成聊天记录；放在最前面拦掉。
  //   · `share-entry-request` 的对侧处理在 PC（手机永远不是源设备，收到即丢弃——
  //     不给探测者当放大器）。
  if (m.kind === 'share-entry-grant') {
    return deliverShareEntryGrant(m as unknown as Record<string, unknown>)
  }
  if (m.kind === 'share-entry-request') return true
  // §3.23 转授闸（与 PC 端 chat_service::ingest_msg 同位置、同语义）：
  //   · `reshare-grant`：主人批/驳了我那张卡的转授申请 → 刷新本地卡的转授能力
  //     （**只改这一张卡的元数据**，不落气泡、不新增卡）；
  //   · `reshare-request` 是"好友 → 源设备"的申请，手机永远不是源设备 → 收到即丢弃
  //     （与 share-entry-request 同款：不给探测者当放大器）。
  if (m.kind === 'reshare-grant') {
    applyReshareUpdate(m.payload || {})
    return true
  }
  if (m.kind === 'reshare-request') return true
  // 任务卡改名（task-rename，2026-10-11）：**必须在下方 self-echo 归位之前**——
  // 归位会把 from==my 的回流行改写成对方 did，owner 校验（from==task.from）会误杀自己。
  // 校验/幂等/落行语义见 ingestTaskRename（与 PC chat_service::ingest_task_rename 同语义）。
  if (m.kind === 'task-rename') return ingestTaskRename(my, m)
  let from = m.from
  // 第84轮：对账回流里 from==my（自己在对端的 out 副本）——归位到"与 to 的会话"
  // （按 from 落会新建 didSafe(my) 会话，同 msgId 判重失效、F 永不收敛）。
  // 2026-10-07：公钥级同判定——信封 from 的出示形态与本地账号 did 形态可不同。
  if (accountDidEq(from, my) && m.to && m.kind !== 'group-msg') from = m.to
  const payload = m.payload || {}
  const conv = (peer: string) => didSafe(peer)
  const base = { msgId: m.id, from, to: my, ts: m.ts, dir: 'in' as const, fromName: m.fromName || '' }
  switch (m.kind) {
    // 2026-10-07 好友去服务端化：三 kind 走 ingestFriendHandshake（chatPoll 异步链
    // ——验签+名册归属在彼处）；本同步状态机/对账 wire 路径不经好友握手（非会话
    // 消息），防御性丢弃。
    case 'friend-request': case 'friend-accept': case 'friend-remove':
      return false
    case 'group-create': {
      const gid = String(payload.groupId || '')
      if (!gid) return false
      // 批二：终态群（已解散/已被移出）不复活 members——迟到的 group-create（对账
      // 从持有方的群会话补齐）只补记录，不把死群拉回活跃。
      const existing = listGroups().find((x) => x.id === gid)
      if (!existing || !groupTerminalStatus(existing)) {
        upsertGroup(gid, String(payload.groupName || '群'), (payload.members as string[]) || [], payload.owner as string | undefined) // 第85轮：群主随建群到达
      }
      // 批二：group-create 落群会话（"群已创建"系统条 + 对账载体——离线成员靠对账
      // 补齐本条即得真 owner，自愈建群 ownerPending 解除；msgId 幂等）。
      appendMsg(gid, { ...base, to: gid, kind: 'group-create', payload: { groupId: gid, groupName: String(payload.groupName || '群'), members: (payload.members as string[]) || [], owner: payload.owner as string | undefined } })
      return true
    }
    // ── 第85轮：群管理五操作（治理闸：非群主操作拒收；单测覆盖） ──
    case 'group-invite': {
      const gid = String(payload.groupId || '')
      const g = listGroups().find((x) => x.id === gid)
      if (!g) return false
      const r = applyGroupUpdate(gid, from, (gg) => { gg.members = (payload.members as string[]) || gg.members; return null })
      if (!r.ok) return false
      for (const nm of ((payload.newMembers as string[]) || [])) {
        if (accountDidEq(nm, my)) appendMsg(gid, { msgId: m.id, from: nm, to: gid, kind: 'sys', payload: { text: '🎉 你被拉进了群聊' }, ts: m.ts, dir: 'in' })
      }
      return true
    }
    case 'group-rename': {
      const gid = String(payload.groupId || '')
      if (!listGroups().some((x) => x.id === gid)) return false
      const r = applyGroupUpdate(gid, from, (gg) => { gg.name = String(payload.newName || gg.name); return null })
      return r.ok
    }
    case 'group-leave': {
      const gid = String(payload.groupId || '')
      const g = listGroups().find((x) => x.id === gid)
      if (!g) return false
      // 批二：终态群的 leave 拒收——群主退群=解散场景 compat group-leave 随
      // group-disband 一并发出，新端只认 disband（防重复系统条）。
      if (groupTerminalStatus(g)) return false
      const list = listGroups()
      const t = list.find((x) => x.id === gid)
      if (t) t.members = t.members.filter((mm) => !accountDidEq(mm, from))
      writeArr(K.groups(), list)
      appendMsg(gid, { msgId: m.id, from, to: gid, kind: 'sys', payload: { text: `${m.fromName || '成员'} 退出了群聊` }, ts: m.ts, dir: 'in' })
      return true
    }
    // 批二（2026-09-28）：群主退群=解散。接收端：群会话保留只读（历史可回查）、
    // members 清空、系统条"群已被解散"。旧版本收到=未知 kind 丢弃不崩（优雅降级，
    // compat group-leave 随发兜底一条"退出了群聊"系统条）。
    case 'group-disband': {
      const gid = String(payload.groupId || '')
      if (!gid) return false
      const g0 = listGroups().find((x) => x.id === gid)
      if (!g0) return false // 档案不存在（重复投递/未知群）→ 丢弃
      if (!accountDidEq(from, groupOwnerOf(g0))) return false // 治理闸：只认真群主（公钥级）
      const gname = String(payload.groupName || g0.name || '群')
      markGroupTerminal(gid, 'disbanded', `群「${gname}」已被群主解散`, m.id, m.ts, from)
      return true
    }
    case 'group-kick': {
      const gid = String(payload.groupId || '')
      const target = String(payload.targetDid || '')
      // 治理闸先行（防非群主伪 kick）：本机档案存在时按 owner 校验；
      // 档案不存在（我已被踢后重复投递）→ 无从校验，丢弃。
      const g0 = listGroups().find((x) => x.id === gid)
      if (!g0) return false
      const owner = groupOwnerOf(g0)
      if (!accountDidEq(from, owner)) return false
      if (accountDidEq(target, my)) {
        // 批二：被踢的是我——不再静默删群：群会话保留只读（历史可回查）+ 系统条
        // "你已被移出群「X」" + 档案 status=kicked（UI 灰色行+输入区禁用+toast）。
        markGroupTerminal(gid, 'kicked', `你已被移出群「${g0.name || '群'}」`, m.id, m.ts, from)
        return true
      }
      if (groupTerminalStatus(g0)) return false // 批二：终态群的 kick（他人被踢）拒收
      const r = applyGroupUpdate(gid, from, (gg) => {
        gg.members = (payload.members as string[]) || gg.members.filter((mm) => !accountDidEq(mm, target))
        mutedClear(gg, target)
        return null
      })
      return r.ok
    }
    case 'group-mute': {
      const gid = String(payload.groupId || '')
      const target = String(payload.targetDid || '')
      const until = Number(payload.mutedUntil || 0)
      const r = applyGroupUpdate(gid, from, (gg) => {
        gg.muted = gg.muted ?? {}
        if (until > 0) { mutedClear(gg, target); gg.muted[target] = until }
        else mutedClear(gg, target)
        return null
      })
      return r.ok
    }
    case 'text': {
      if (appendMsg(conv(from), { ...base, kind: 'text', payload })) fireIngest(conv(from), { ...base, kind: 'text', payload })
      return true
    }
    // ── 批四：撤回（recall，词表与 PC 批三对齐；payload.target=被撤 msgId） ──
    case 'recall': {
      const target = String(payload.target || '')
      if (!target) return false
      // 群撤回（payload.groupId）归位群会话；单聊按 from。对方撤自己的消息：
      // 删显示行（墓碑：convmeta.ids 保留防对账复活）+ 落系统条。
      const gid = typeof payload.groupId === 'string' && payload.groupId.startsWith('grp-') ? payload.groupId : ''
      const convTarget = gid || conv(from)
      deleteMsgLocal(convTarget, target)
      const who = gid ? (m.fromName || '成员') : '对方'
      appendMsg(convTarget, { msgId: `sys-recall-${target}`, from, to: gid || my, kind: 'sys', payload: { text: `${who}撤回了一条消息` }, ts: m.ts, dir: 'in' })
      return true
    }
    case 'image': case 'file': {
      const name = String(payload.name || 'file')
      const mime = String(payload.mime || 'application/octet-stream')
      const size = Number(payload.size || 0)
      const b64 = String(payload.b64 || '')
      if (b64) {
        // 第94轮：文件字节进 IndexedDB（10MB 级进 localStorage 必爆配额）；图片维持 localStorage。
        if (m.kind === 'file') void fileMediaPut(m.id, b64)
        else storeMedia(m.id, b64)
      }
      // 群文件/图片的对账副本（payload.groupId）归位到群会话——与 PC ingest 同规则，
      // 否则按单聊落盘会绕开按会话的幂等闸重复进直聊会话。
      const convTarget = typeof payload.groupId === 'string' && payload.groupId.startsWith('grp-')
        ? payload.groupId
        : conv(from)
      const stored = { ...base, to: payload.groupId ? String(payload.groupId) : my, kind: m.kind, payload: { name, mime, size, mediaId: b64 ? m.id : '' } }
      if (appendMsg(convTarget, stored)) fireIngest(convTarget, stored)
      return true
    }
    case 'group-msg': {
      const gid = String(payload.groupId || '')
      if (!gid) return false
      let grp = listGroups().find((g) => g.id === gid)
      if (!grp) {
        // 批二：兜底自愈建群 owner 未知 → ownerPending（治理全拒直到 group-create
        // 补齐真 owner），不再让字典序首成员冒充群主（各端认知分叉根因）。
        upsertGroupSelfheal(gid, String(payload.groupName || '群'), (payload.members as string[]) || [])
        grp = listGroups().find((g) => g.id === gid)
      }
      // 第85轮：禁言校验——被禁言成员的群消息丢弃（群主/自己豁免；公钥级判等）
      if (grp && !accountDidEq(from, my) && !accountDidEq(from, groupOwnerOf(grp)) && isMuted(grp, from, m.ts)) {
        return false
      }
      // 设备群（决策 D.1/D.2，2026-10-07）：群消息行级持久化 fromDevice/fromDeviceName
      // （对账 wire 原样带，普通群也无害）；设备群 dir 按 fromDevice 判——本机设备=
      // 本机消息经对账/多端回流 → out，他机（同事设备）→ in。普通群 dir 行为不变（in）。
      const devGroup = isDeviceGroup(grp ?? { id: gid })
      const dir: 'in' | 'out' = deviceGroupIngestDir(devGroup, currentIdentity()?.did, m.fromDevice)
      const devName = (m.fromDeviceName || '').trim()
      const devPatch = { fromDevice: m.fromDevice || undefined, fromDeviceName: devName || undefined, dir }
      const img = payload.image as { name?: string; mime?: string; b64?: string } | undefined
      const fileObj = payload.file as { name?: string; mime?: string; size?: number; b64?: string } | undefined
      if (img && img.b64) {
        storeMedia(m.id, img.b64)
        const g1 = { ...base, to: gid, kind: 'image', payload: { name: img.name || 'file', mime: img.mime || 'image/png', mediaId: m.id }, fromName: String(payload.fromName || ''), ...devPatch }
        if (appendMsg(gid, g1)) fireIngest(gid, g1)
      } else if (fileObj && fileObj.b64) {
        // 第94轮：群文件（file 嵌套对象）——kind=file 文件卡；text 字段是旧版本降级文案
        void fileMediaPut(m.id, fileObj.b64)
        const g2 = { ...base, to: gid, kind: 'file', payload: { groupId: gid, groupName: String(payload.groupName || (grp ? grp.name : '群')), name: String(fileObj.name || 'file'), mime: String(fileObj.mime || 'application/octet-stream'), size: Number(fileObj.size || 0), mediaId: m.id }, fromName: String(payload.fromName || ''), ...devPatch }
        if (appendMsg(gid, g2)) fireIngest(gid, g2)
      } else if (typeof payload.b64 === 'string' && payload.b64) {
        // 2026-09-28：对账回流的扁平图片副本（PC 落盘形态 name/mime/media→wire 展平成 b64）
        // ——不识别会当文本落盘渲染成空气泡
        storeMedia(m.id, payload.b64)
        const g3 = { ...base, to: gid, kind: 'image', payload: { name: String(payload.name || 'file'), mime: String(payload.mime || 'image/png'), mediaId: m.id }, fromName: String(payload.fromName || ''), ...devPatch }
        if (appendMsg(gid, g3)) fireIngest(gid, g3)
      } else {
        const g4 = { ...base, to: gid, kind: 'group-msg', payload, fromName: String(payload.fromName || ''), ...devPatch }
        if (appendMsg(gid, g4)) fireIngest(gid, g4)
      }
      return true
    }
    case 'task-share': {
      // 批二：群任务卡（payload.groupId=grp-*）落群会话——全员可见同一张卡；
      // 单聊分享行为不变（落与分享者的单聊会话）。
      const gid = typeof payload.groupId === 'string' && payload.groupId.startsWith('grp-') ? payload.groupId : ''
      if (gid && !listGroups().some((g) => g.id === gid)) {
        // 群档案未知（卡先于 group-create 到）：自愈（ownerPending）
        upsertGroupSelfheal(gid, String(payload.groupName || '群'), (payload.members as string[]) || [])
      }
      // ★ 2026-10-09（「真卡可点」最后一公里）：**设备群广播的卡嵌在 `payload.card`**
      //（PC 端 `chat_service::device_group_card_payload` 的 wire 形状
      //  `{groupId,groupName,members,fromName,status,card:{…}}`）——不摊平的话
      //  `title/shareId/sourceDevice` 全是 undefined：卡上没标题、也没有「打开」入口。
      //  摊平后落库（字段与桌面端 `upsert_device_group_task` 对齐），UI 与 shareCardOf
      //  都只面对**平铺一层**的形状。
      const flat = flattenTaskSharePayload(payload)
      const taskId = String(flat.taskId || '').trim()
      // 幂等键（收口）：taskId 优先，其次 shareId —— **同一张卡重复投递只留一条**
      // （设备群广播 + 单聊 + 对账回流三条路都可能带同一张卡回来）。
      const sid = String(flat.shareId || '').trim()
      // 2026-10-27：PC `/api/chat/tombstoneTasks` 广播的外层 status=revoked 是控制消息，
      // 不落空标题卡；同时删除本地任务并打墓碑，防对账/迟到历史卡复活（真机 O07 回灌案）。
      if (String(flat.status || '') === 'revoked') {
        const taskShareId = (t: PeerTask): string => {
          const parsed = taskShareCardOf(t)
          return String(t.shareId || parsed?.shareId || '').trim()
        }
        const tasks = listTasks()
        // O07 真案：历史污染可能是“无顶层 shareId、只有 action.url”的手工副本；
        // tombstone 必须按 taskId + 归一化 shareId 删掉所有副本，不能只删第一条。
        const anchor = tasks.find((t) => !!taskId && t.taskId === taskId)
        const canonicalSid = sid || (anchor ? taskShareId(anchor) : '')
        // 安全闸（2026-10-27 复核 blocker）：revoked 是永久删除/tombstone 控制消息，
        // 只允许本账号设备群同步，或本地已有任务的 owner 撤销；外部账号猜测 taskId/shareId 无效。
        const anchorOwner = anchor ? String(anchor.from || anchor.sourceAccount || '') : ''
        // task-share 的自回流在上方会把 from 归位成 to/groupId；撤销授权必须看信封原始账号。
        const revokeFrom = String(m.from || from || '')
        const revokeAllowed = accountDidEq(revokeFrom, my)
          || (!!anchor && !!anchorOwner && accountDidEq(revokeFrom, anchorOwner))
        if (!revokeAllowed) return false
        const victims = tasks.filter((t) =>
          (!!taskId && t.taskId === taskId) || (!!canonicalSid && taskShareId(t) === canonicalSid))
        const kept = tasks.filter((t) => !victims.includes(t))
        if (kept.length !== tasks.length) writeArr(K.tasks(), kept)
        for (const victim of victims) markTaskTombstoned(String(victim.taskId || ''), taskShareId(victim))
        markTaskTombstoned(taskId, canonicalSid)
        return true
      }
      if (taskTombstoned(taskId, sid)) return true
      const convTarget = gid || conv(from)
      appendMsg(convTarget, { ...base, to: gid || my, kind: 'task-share', payload: flat })
      if (!taskId) return true
      const tasks = listTasks()
      const idx = tasks.findIndex((t) => t.taskId === taskId || (!!sid && t.shareId === sid))
      const isMine = accountDidEq(from, my)
      const grant = (flat.grant && typeof flat.grant === 'object' && !Array.isArray(flat.grant))
        ? flat.grant as TaskGrantView : undefined
      const srcDevice = String(flat.sourceDevice || '')
      const srcAccount = String(flat.sourceAccount || '') || (isMine ? my : from)
      const patch: Partial<PeerTask> = {
        // 我的角色 / 我的权限 / 可不可转授（源设备随卡下发；缺省=协作者、不可转授——fail-closed）
        myRole: String(flat.myRole || (isMine ? 'owner' : 'collaborator')),
        remoteOrigin: !isMine,
        ...(sid ? { shareId: sid } : {}),
        ...(srcDevice ? { sourceDevice: srcDevice } : {}),
        ...(flat.sourceDeviceName ? { sourceDeviceName: String(flat.sourceDeviceName) } : {}),
        ...(srcAccount ? { sourceAccount: srcAccount } : {}),
        ...(grant ? { grant } : {}),
        // 转授闸：卡上没带就是 false（默认拒绝，绝不因为"字段缺失"白送转授权）
        canReshare: flat.canReshare === true,
        ...(typeof flat.reshareExp === 'number' ? { reshareExp: flat.reshareExp } : {}),
        ...(typeof flat.reshareVia === 'string' || flat.reshareVia === null ? { reshareVia: (flat.reshareVia as string | null) } : {}),
        ...(flat.action ? { action: flat.action as PeerTask['action'] } : {}),
        // 卡面 env（2026-10-23）：源设备随卡下发，**必须落库**——列表行的路由只认它
        // （有 env → 固定口直开；没有 → 原分享入口）。caps/owner 跟着 env 一起走，
        // 不单独覆盖老卡（老卡没有 env 时这三个键都不出现，行为与改造前一致）。
        ...(Array.isArray(flat.env) && flat.env.length > 0
          ? { env: flat.env as unknown[] }
          : {}),
        ...(Array.isArray(flat.env) && flat.env.length > 0 && flat.caps !== undefined
          ? { caps: flat.caps }
          : {}),
        ...(Array.isArray(flat.env) && flat.env.length > 0 && typeof flat.owner === 'string' && flat.owner.trim()
          ? { owner: flat.owner.trim() }
          : {}),
      }
      if (idx < 0) {
        tasks.push({
          taskId, title: String(flat.title || '任务'), desc: flat.desc as string | undefined,
          requirements: flat.requirements as string | undefined, rSpec: flat.r_spec as PeerTask['rSpec'],
          reward: flat.reward as string | undefined,
          from: String(flat.from || from), fromName: flat.fromName as string | undefined,
          createdAt: flat.createdAt as number | undefined, expiresAt: flat.expiresAt as number | undefined,
          participants: (flat.participants as TaskParticipant[]) || undefined, // 第83轮：分享者(owner) 随卡到达
          source: String(flat.source || 'peer'),
          status: isMine ? 'todo' : 'pending' /* 第89轮：同账号自动接受 */, convId: convTarget,
          ...patch,
        })
        writeArr(K.tasks(), tasks)
      } else {
        // 已存在：**只刷新"主人意愿"那些字段**（转授面/赠卡/来源），**绝不回退 status**
        // ——用户在本机推进过的进度（todo/doing/done）不被一条迟到的重投递打回 pending。
        tasks[idx] = { ...tasks[idx], ...patch }
        writeArr(K.tasks(), tasks)
      }
      return true
    }
    case 'task-accept': case 'task-done': {
      // 第83轮：payload 带 participants 全量 + name——本地任务库合并去重；
      // task-done → 本地置 done（shared/todo/doing 归一，"参与方可见"协作感）。
      // 批二：群任务回执（payload.groupId=grp-*）群广播——落群会话，全员可见
      // "谁接了/谁完成了"；单聊回执行为不变（落与对方的单聊）。
      const tid = String(payload.task_id || payload.taskId || '')
      const name = String(payload.name || '')
      const inc = (payload.participants as TaskParticipant[]) || []
      const tasks = listTasks()
      const t = tasks.find((x) => x.taskId === tid)
      let title = ''
      if (t) {
        title = t.title
        let changed = false
        if (inc.length) { t.participants = mergeParticipants(t.participants, inc); changed = true }
        if (m.kind === 'task-done' && t.status !== 'done') { t.status = 'done'; t.doneAt = m.ts; changed = true }
        if (changed) writeArr(K.tasks(), tasks)
      }
      const gid = typeof payload.groupId === 'string' && payload.groupId.startsWith('grp-') ? payload.groupId : ''
      appendMsg(gid || conv(from), { ...base, to: gid || my, kind: m.kind, payload: { task_id: tid, title, name, participants: inc } })
      return true
    }
    default:
      return false
  }
}

// ══════════════ 网络层（signedPost 设备钥签名） ══════════════

/** 我的好友锚：账号 did（主设备=rootDid；分身=attestation.rootDid）。 */
export function myAccountDid(): string | null {
  return getRootIdentity() ?? getAttestation()?.rootDid ?? null
}

function requireMy(): string {
  const my = myAccountDid()
  if (!my) throw new Error('未关联有灵账号')
  if (!currentIdentity()) throw new Error('身份未就绪')
  return my
}

function myName(): string {
  return currentYoulingName() || '好友'
}

function newMsgId(): string {
  try { return crypto.randomUUID() } catch { return `m${Date.now()}-${Math.random().toString(36).slice(2, 10)}` }
}

/** 第84轮：服务器信箱底座——只剩低频控制消息（friend-* 三握手 + group-create +
 *  第85轮群管理五操作）。正文 kind 服务器白名单已移除，走 p2pSendRaw。 */
async function srvSendRaw(to: string, kind: string, payload: Record<string, unknown>): Promise<{ msgId: string; ts: number }> {
  const my = requireMy()
  const msgId = newMsgId()
  const ts = Date.now()
  const body = { fromAccountDid: my, fromName: myName(), toAccountDid: to, kind, payload, msgId, ts }
  const r = await signalPost('/msg/send', body)
  if (!r.ok) throw new Error(`发送失败 (${r.status})`)
  return { msgId, ts }
}

/** 第84轮：P2P 直推底座——本地先落（调用方 appendOut），再直推对方在线设备。
 *  第95轮（离线队列，与 PC p2p_send_raw 同语义）：任一设备送达→sendState="sent"；
 *  全不可达→信封入 IndexedDB 待发队列→"sending"（对方上线自动补发，msgId 不变
 *  幂等）；队列溢出（单会话 200）→"failed"（长期不在线，UI 手动重发）。
 *  群（to=grp-*）按 payload.members 逐成员扇出（含自己其他设备）。
 *  返回 (msgId, ts, sendState)。 */
async function p2pSendRaw(to: string, kind: string, payload: Record<string, unknown>): Promise<{ msgId: string; ts: number; sendState: 'sent' | 'sending' | 'failed' }> {
  const msgId = newMsgId()
  const ts = Date.now()
  const { buildEnvelope, p2pDeliver } = await import('./p2p') // 动态 import 防模块环
  const envelope = buildEnvelope(to, kind, payload, msgId, ts)
  const targets: string[] = to.startsWith('grp-')
    ? ((payload.members as string[]) ?? []).filter((m) => typeof m === 'string' && m.startsWith('did:'))
    : [to]
  let delivered = false
  for (const t of targets) {
    if (await p2pDeliver(t, envelope).catch(() => false)) delivered = true
  }
  if (delivered) return { msgId, ts, sendState: 'sent' }
  // 第95轮：deliver 失败 → 本地待发队列（persistent，重启存活）
  const convId = to.startsWith('grp-') ? to : didSafe(to)
  const { enqueueOutbox } = await import('./outbox')
  const outcome = await enqueueOutbox(convId, targets, envelope)
  return { msgId, ts, sendState: outcome === 'queued' ? 'sending' : 'failed' }
}

// ══════════════ 2026-10-18 fast-ack 发送（点了就算发出） ══════════════
//
// 用户口径「发了半天不确认成功」的手机端根修：**appendOut 后立即返回**（本机确认
// ⏳→✓，M2），网络 P2P 投递全部后台。与 PC chat_service.rs 的 fast_ack_finish 对称：
//   · 本地只做校验 + 落库（sendState="sent"=本机已收下并开始投递）；
//   · 后台每目标并行 p2pDeliver（直连 1.5s/目标、总 4s 预算；超时=未达——接收端
//     msgId 幂等，补发环再投一遍无害）；群=成员并行扇出（M4）；
//   · 任一送达 → sent（✓）；全失败 → 信封入 outbox（pending，3s 起指数退避自动
//     重试）+ sendState="failed"（! 可重试，≤5s 可见，M5）；
//   · trace：send-ack / deliver-ok / deliver-fail（M2/M3/M4/M7）。
// 控制类 kind（task-accept/task-done/task-rename/recall/task-share 回执）仍走同步
// p2pSendRaw（调用方要真实结论/msgId），不在本次范围。

/** fast-ack 发送计划（纯本地，零网络）：msgId/ts 现生成、会话归一键、群=members 快照。 */
interface SendPlan {
  msgId: string
  ts: number
  convId: string
  to: string
  kind: string
  payload: Record<string, unknown>
  targets: string[]
}

function planOutSend(to: string, kind: string, payload: Record<string, unknown>): SendPlan {
  const msgId = newMsgId()
  const ts = Date.now()
  const convId = to.startsWith('grp-') ? to : didSafe(to)
  const targets = to.startsWith('grp-')
    ? ((payload.members as string[]) ?? []).filter((m) => typeof m === 'string' && m.startsWith('did:'))
    : [to]
  return { msgId, ts, convId, to, kind, payload, targets }
}

/** fast-ack 后台投递（void 触发，不阻塞调用方）：成功翻 sent；全失败入 outbox +
 *  翻 failed（补发环自动重试，成功后翻回 sent）。异常一律咽掉——发消息不能抛给 UI。 */
function dispatchOutSend(plan: SendPlan): void {
  void (async () => {
    try {
      const p2pMod = await import('./p2p') // 动态 import 防模块环
      const envelope = p2pMod.buildEnvelope(plan.to, plan.kind, plan.payload, plan.msgId, plan.ts)
      const results = await Promise.all(
        plan.targets.map(async (t) => {
          const s = Date.now()
          const ok = await p2pMod.p2pDeliver(t, envelope, { timeoutMs: 1_500, budgetMs: 4_000 }).catch(() => false)
          chatTrace(ok ? 'deliver-ok' : 'deliver-fail', plan.msgId, t, Date.now() - s)
          return ok
        }),
      )
      if (results.some(Boolean)) {
        updateSendState(plan.convId, plan.msgId, 'sent')
        p2pMod.notifyChatStateChanged()
        return
      }
      // 全失败：待发队列（pending=补发环自动接管）+ 立即标失败（M5：不长期挂 ⏳）
      const { enqueueOutbox } = await import('./outbox')
      await enqueueOutbox(plan.convId, plan.targets, envelope)
      updateSendState(plan.convId, plan.msgId, 'failed')
      p2pMod.notifyChatStateChanged()
      p2pMod.kickOutboxRetryNow() // 新失败消息：补发环立即重置节奏重试
    } catch {
      // 极端路径（动态 import 失败等）：至少让用户看到可重试的失败态
      updateSendState(plan.convId, plan.msgId, 'failed')
      try { (await import('./p2p')).notifyChatStateChanged() } catch { /* ignore */ }
    }
  })()
}

/** fast-ack 收尾：本地落库（sendState=sent=本机已收下）→ trace send-ack → 后台投递。 */
function finishFastAck(
  plan: SendPlan,
  my: string,
  localKind: string,
  localPayload: Record<string, unknown>,
  t0: number,
): void {
  appendOut(plan.convId, my, plan.to, localKind, localPayload, plan.msgId, plan.ts, 'sent')
  chatTrace('send-ack', plan.msgId, plan.to || plan.convId, Date.now() - t0)
  dispatchOutSend(plan)
}

/** 第84轮：本地存储形态 → wire 形态（跨设备对账传输）：去 dir；mediaId → b64 内联。
 *  第95轮：sendState 是端侧发送状态——不上 wire（对端无意义）。 */
export function wirePackMsg(m: ChatMsg): Record<string, unknown> {
  const w: Record<string, unknown> = { ...m }
  delete w.dir
  delete w.sendState
  const p = w.payload as Record<string, unknown>
  if (p && typeof p.mediaId === 'string') {
    const b64 = loadMediaB64(p.mediaId)
    if (b64) {
      const { mediaId, ...rest } = p
      void mediaId
      w.payload = { ...rest, b64 }
    }
  }
  return w
}

/** 第94轮：wire 形态（异步版）——文件媒体在 IndexedDB，对账上 wire 前补齐 b64。
 *  p2p 对账 batch 组装处用（syncWithDeviceInner 已是 async）；图片路径与 wirePackMsg 等价。 */
export async function wirePackMsgAsync(m: ChatMsg): Promise<Record<string, unknown>> {
  const w: Record<string, unknown> = { ...m }
  delete w.dir
  delete w.sendState
  const p = w.payload as Record<string, unknown>
  if (p && typeof p.mediaId === 'string') {
    const b64 = m.kind === 'file' ? await loadFileB64(p.mediaId) : loadMediaB64(p.mediaId)
    if (b64) {
      const { mediaId, ...rest } = p
      void mediaId
      w.payload = { ...rest, b64 }
    }
  }
  return w
}

function appendOut(convId: string, my: string, to: string, kind: string, payload: Record<string, unknown>, msgId: string, ts: number, sendState?: ChatMsg['sendState']): void {
  appendMsg(didSafe(convId), { msgId, from: my, to, kind, payload, ts, dir: 'out', sendState })
}

/** 发文本：**fast-ack（2026-10-18）**——本地先行上屏（sendState=sent=本机已收下）
 *  后立即返回；网络投递后台（成功/失败经 updateSendState + onSendStateChange 回写徽标）。 */
export async function chatSendText(to: string, text: string, extra?: { replyTo?: ChatMsg | null }): Promise<void> {
  const t0 = Date.now()
  const my = requireMy()
  if (!text.trim()) throw new Error('消息为空')
  const payload: Record<string, unknown> = { text, ...replyPatch(extra?.replyTo) }
  const plan = planOutSend(to, 'text', payload) // 第84轮 wire kind：text
  finishFastAck(plan, my, 'text', payload, t0)
}

/** 批四：引用回复 wire 补丁——replyTo=被引 msgId + 快照摘要（snippet/fromName）。
 *  摘要随消息走而非渲染期回查：被引消息可能被撤回/滚动清理，快照永真。 */
export function replyPatch(replyTo?: ChatMsg | null): Record<string, unknown> {
  if (!replyTo) return {}
  return {
    replyTo: replyTo.msgId,
    replySnippet: convPreview(replyTo).slice(0, 60),
    replyFromName: replyTo.dir === 'out' ? '' : (replyTo.fromName || ''),
  }
}

// ══════════════ 批四：撤回（recall——限时 2 分钟双向；词表与 PC 批三对齐） ══════════════

/** 撤回时限（微信语义 2 分钟）。 */
export const RECALL_WINDOW_MS = 120_000

/** 可撤回判定（纯函数，单测覆盖）：自己的内容类消息（文本/图片/文件/群消息）+ 时限内
 *  + 非乐观条（optimistic-* 未落 wire，撤了无意义——直接本地删即可）。 */
export function canRecall(m: ChatMsg, now = Date.now()): boolean {
  if (m.dir !== 'out') return false
  if (!['text', 'group-msg', 'image', 'file'].includes(m.kind)) return false
  if (String(m.msgId).startsWith('optimistic-')) return false
  return now - m.ts <= RECALL_WINDOW_MS
}

/** 长按菜单状态机（纯函数，单测覆盖；微信语义子集）：
 *  复制=文本类；引用=内容类；撤回=canRecall；删除=所有消息恒可（本地行删除）。 */
export type MsgMenuAction = 'copy' | 'reply' | 'recall' | 'delete'
export function msgMenuActions(m: ChatMsg, now = Date.now()): MsgMenuAction[] {
  const acts: MsgMenuAction[] = []
  if (m.kind === 'text' || m.kind === 'group-msg') acts.push('copy')
  if (['text', 'group-msg', 'image', 'file'].includes(m.kind)) acts.push('reply')
  if (canRecall(m, now)) acts.push('recall')
  acts.push('delete')
  return acts
}

/** 撤回一条自己发出的消息：本地删行（墓碑保留）+ 对端发 recall 控制消息 +
 *  本地落系统条"你撤回了一条消息"。超限时 UI 层不该调（msgMenuActions 已拦），调用方仍兜底。 */
export async function chatRecall(convId: string, msgId: string): Promise<void> {
  const my = requireMy()
  const row = loadConv(convId).find((m) => m.msgId === msgId)
  if (!row) throw new Error('消息不存在（可能已被清理）')
  if (!canRecall(row)) throw new Error('超过 2 分钟，不能撤回了')
  const isGrp = convId.startsWith('grp-') || String(row.to).startsWith('grp-')
  const gid = isGrp ? (convId.startsWith('grp-') ? convId : String(row.to)) : ''
  const payload: Record<string, unknown> = { target: msgId }
  if (gid) {
    const g = listGroups().find((x) => x.id === gid)
    payload.groupId = gid
    payload.members = g?.members ?? []
  }
  // 先删本地（撤回即时生效），再通知对端（失败不挡本地——对端靠离线队列补投）
  deleteMsgLocal(convId, msgId)
  appendMsg(convId, { msgId: `sys-recall-${msgId}`, from: my, to: convId, kind: 'sys', payload: { text: '你撤回了一条消息' }, ts: Date.now(), dir: 'out' })
  await p2pSendRaw(isGrp ? gid : String(row.to || convId), 'recall', payload)
}

/** 发图（≤2MB；b64 上线 + 本地媒体键存档）。fast-ack：本地存档+上屏后立即返回。 */
export async function chatSendImage(to: string, name: string, mime: string, b64: string): Promise<void> {
  const t0 = Date.now()
  const my = requireMy()
  if (b64.length > 2_800_000) throw new Error('图片超过 2MB')
  const plan = planOutSend(to, 'image', { name, mime, b64 }) // 第84轮 wire kind：image
  storeMedia(plan.msgId, b64)
  finishFastAck(plan, my, 'image', { name, mime, mediaId: plan.msgId }, t0)
}

/** 第94轮：发任意文件（≤10MB；kind=file，本地媒体进 IndexedDB）。fast-ack 同上。 */
export async function chatSendFile(to: string, name: string, mime: string, size: number, b64: string): Promise<void> {
  const t0 = Date.now()
  const my = requireMy()
  if (size > FILE_MAX_BYTES || b64.length > FILE_B64_MAX) throw new Error('文件过大（>10MB），暂不支持')
  const plan = planOutSend(to, 'file', { name, mime, size, b64 })
  await fileMediaPut(plan.msgId, b64) // 本地存档先落（本机立即可见）
  finishFastAck(plan, my, 'file', { name, mime, size, mediaId: plan.msgId }, t0)
}

/** 群消息发送（fast-ack 2026-10-18）：本地落库即返回；成员**并行**扇出在后台
 *  （M4 群 10 人 P95 目标 ≤1.5s），全失败入 outbox + 翻 failed（可重试）。 */
export async function chatSendGroup(groupId: string, core: { text?: string } | { name: string; mime: string; b64: string; size?: number }, extra?: { replyTo?: ChatMsg | null }): Promise<void> {
  const t0 = Date.now()
  const my = requireMy()
  const g = listGroups().find((x) => x.id === groupId)
  if (!g) throw new Error('群不存在')
  // 批二：终态群（已解散/已被移出）只读——发送拒绝（UI 输入区已禁用，这是数据层兜底）
  if (groupTerminalStatus(g) === 'disbanded') throw new Error('群已被群主解散，仅可查看历史')
  if (groupTerminalStatus(g) === 'kicked') throw new Error('你已被移出该群，仅可查看历史')
  const isImg = 'b64' in core && String(core.mime || '').startsWith('image/')
  if (isImg && (core as { b64: string }).b64.length > 2_800_000) throw new Error('图片超过 2MB')
  if (!isImg && 'b64' in core) {
    const size = (core as { size?: number }).size ?? 0
    if (size > FILE_MAX_BYTES || (core as { b64: string }).b64.length > FILE_B64_MAX) throw new Error('文件过大（>10MB），暂不支持')
  }
  // 第94轮：群文件走 file 嵌套 + text 降级文案（旧版本收 group-msg 渲染纯文本不崩）；
  // 群图片维持 image 嵌套（既有形态，对账/旧端兼容不动）。
  const payload = isImg
    ? { groupId, groupName: g.name, fromName: myName(), members: g.members, image: { name: (core as { name: string }).name, mime: (core as { mime: string }).mime, b64: (core as { b64: string }).b64 } }
    : 'b64' in core
      ? { groupId, groupName: g.name, fromName: myName(), members: g.members,
          text: `[文件] ${(core as { name: string }).name}`,
          file: { name: (core as { name: string }).name, mime: (core as { mime: string }).mime, size: (core as { size?: number }).size ?? 0, b64: (core as { b64: string }).b64 } }
      : { groupId, groupName: g.name, fromName: myName(), members: g.members, text: core.text, ...replyPatch(extra?.replyTo) }
  if (!isImg && !('b64' in core) && !String(core.text || '').trim()) throw new Error('消息为空')
  const plan = planOutSend(groupId, 'group-msg', payload) // 第84轮：P2P 端侧逐成员扇出
  if (isImg) {
    storeMedia(plan.msgId, (core as { b64: string }).b64)
    finishFastAck(plan, my, 'image', { groupId, groupName: g.name, members: g.members, name: (core as { name: string }).name, mime: (core as { mime: string }).mime, mediaId: plan.msgId }, t0)
  } else if ('b64' in core) {
    await fileMediaPut(plan.msgId, (core as { b64: string }).b64)
    finishFastAck(plan, my, 'file', { groupId, groupName: g.name, members: g.members, name: (core as { name: string }).name, mime: (core as { mime: string }).mime, size: (core as { size?: number }).size ?? 0, mediaId: plan.msgId }, t0)
  } else {
    // 2026-09-28：落盘副本带 members——对账拉走本副本的设备用它兜底建群（人数正确）
    finishFastAck(plan, my, 'group-msg', { groupId, groupName: g.name, members: g.members, text: core.text, ...replyPatch(extra?.replyTo) }, t0)
  }
}

/** 第95轮：手动重发一条失败/发送中的消息（UI 失败徽标点按；与 PC chat_retry_msg 同语义）。
 *  路径：① 在队（pending/failed）→ 复位 pending 立即补发一次；
 *        ② 不在队（溢出从未入队）→ 从本地行重建信封+目标立即直发，
 *           失败则重新入队（pending——自动补发管线重新接管）。
 *  返回重发后的 sendState（UI 据返回值即时刷新徽标）。 */
export async function retrySend(convId: string, msgId: string): Promise<ChatMsg['sendState']> {
  const ob = await import('./outbox')
  const { p2pDeliver } = await import('./p2p') // 动态 import 防模块环
  const existing = await ob.getOutboxItem(msgId)
  if (existing) {
    await ob.requeueOutbox(msgId)
    // 手动重试也走紧预算（1.5s/目标、总 4s）：点了就快点给结论（与 PC chat_retry_msg 同语义）。
    const sent = await ob.flushOne(msgId, (t, e) => p2pDeliver(t, e, { timeoutMs: 1_500, budgetMs: 4_000 }))
    const state: ChatMsg['sendState'] = sent ? 'sent' : 'failed'
    // 手动重试失败=用户已接管：停自动补发（第95轮语义，微信同款；等下次手动/上线）。
    if (!sent) await ob.markOutboxFailed(msgId, '对方长期不在线，消息未送达')
    updateSendState(convId, msgId, state)
    return state
  }
  // 不在队：从会话行重建（溢出失败态的消息；文件媒体从 IndexedDB 补 b64）
  const row = loadConv(convId).find((m) => m.msgId === msgId)
  if (!row) throw new Error('消息不存在（可能已被清理）')
  if (row.dir !== 'out') throw new Error('只有发出的消息需要重发')
  const envelope = row.kind === 'file' ? await wirePackMsgAsync(row) : wirePackMsg(row)
  const to = row.to || convId
  const targets: string[] = String(to).startsWith('grp-')
    ? (listGroups().find((g) => g.id === to)?.members ?? []).filter((m) => m.startsWith('did:'))
    : [to]
  let delivered = false
  for (const t of targets) {
    if (await p2pDeliver(t, envelope).catch(() => false)) delivered = true
  }
  if (delivered) {
    updateSendState(convId, msgId, 'sent')
    return 'sent'
  }
  // 仍未达：重新入队（pending——presence 上线/对账周期自动补发接管）
  const outcome = await ob.enqueueOutbox(convId, targets, envelope)
  const state: ChatMsg['sendState'] = outcome === 'queued' ? 'sending' : 'failed'
  updateSendState(convId, msgId, state)
  return state
}

/** 第95轮：某账号上线（或对账建立）→ 补发其待发队列；成功条目消息行翻 "sent"。
 *  返回补发成功的 (msgId, convId) 列表（UI 重渲依据）。 */
export async function flushOutboxFor(account: string): Promise<{ msgId: string; convId: string }[]> {
  const ob = await import('./outbox')
  if (!(await ob.hasPendingForAccount(account))) return [] // 快路径：无待发零开销
  const { p2pDeliver } = await import('./p2p')
  const sent = await ob.flushAccount(account, p2pDeliver)
  for (const item of sent) updateSendState(item.convId, item.msgId, 'sent')
  return sent.map((i) => ({ msgId: i.msgId, convId: i.convId }))
}

/** 第95轮：全量兜底 flush（60s 对账循环/回前台）——有 pending 的账号逐个试。 */
export async function flushOutboxAll(): Promise<number> {
  const ob = await import('./outbox')
  const accts = await ob.pendingAccounts()
  let n = 0
  for (const a of accts) n += (await flushOutboxFor(a)).length
  return n
}

/** 拉信箱入库，返回入库条数（好友握手状态迁移也算 1——FriendsPanel 的 5s 轮询
 *  据此重渲）。2026-10-07 好友去服务端化：三 kind 走 ingestFriendHandshake
 * （验签+名册归属+状态机），其余走同步 ingestMsg。 */
export async function chatPoll(): Promise<number> {
  const my = requireMy()
  // 内置小灵好友（幂等补缺；每次 poll 检查一次，成本=一次 localStorage 读）
  ensureOfficialFriend()
  const r = await signalPost('/msg/poll', { accountDid: my })
  if (!r.ok) throw new Error(`拉取失败 (${r.status})`)
  const d = (await r.json()) as { data?: { msgs?: ServerMsg[] } }
  let n = 0
  for (const m of d.data?.msgs ?? []) {
    if (isFriendHandshakeKind(m.kind)) {
      if (await ingestFriendHandshake(my, m)) n += 1
    } else if (ingestMsg(my, m)) {
      n += 1
    }
  }
  // 官方通知自愈同步（3s 节流；多设备抢同一账号信箱时由 /official/pending 兜底补投）
  if (Date.now() - _lastOfficialSyncMs > 3000) {
    _lastOfficialSyncMs = Date.now()
    void syncOfficialPending(my).catch(() => {})
  }
  return n
}

/** 昵称解析：GET /root/{did} → data.name（查不到 null）。 */
export async function resolveName(did: string): Promise<string | null> {
  try {
    const base = (await import('./identity')).DID_BASE
    const r = await fetch(`${base}/root/${encodeURIComponent(did)}`)
    if (!r.ok) return null
    const d = (await r.json()) as { data?: { name?: string } }
    return d.data?.name || null
  } catch { return null }
}

/** 加好友（2026-10-07 去服务端化）：本地乐观落行（返回即"已发送"态）+ 签名握手
 *  friend-request 投递（P2P 直推优先→信箱兜底）。互加即好友：对方先加过我（本地
 *  in-pending）时直接转 ok（对端握手把它收敛）；已 ok/out-pending 幂等重发（只刷名）。 */
export async function addFriend(did: string, name?: string): Promise<void> {
  const my = requireMy()
  if (accountDidEq(did, my)) throw new Error('不能加自己为好友')
  if (!did.startsWith('did:')) throw new Error('DID 格式不对（应以 did:youling: 或 did:myco: 开头）')
  const cur = listFriends().find((f) => accountDidEq(f.did, did))
  if (!cur) {
    const nm = name || (await resolveName(did)) || `…${did.slice(-4)}`
    upsertFriend(did, nm, 'out-pending')
  } else if (fstOf(cur) === 'in-pending') {
    // 互加即好友：本地直接 ok（对端握手回执把它收敛）
    upsertFriend(did, cur.name || name || '有灵账号', 'ok')
  } else if (name && fstOf(cur) !== 'ok') {
    upsertFriend(did, name, fstOf(cur)) // out-pending 重发带名 → 刷名（rank 同级可写）
  }
  await friendDeliver(did, 'friend-request')
}

/** 接受好友请求（去服务端化）：本地 in-pending → ok + 发 friend-accept 握手（发起方
 *  out-pending → ok 并落"你们已成为好友"系统条）。行已是 ok 也放行——投递失败后的
 *  重试路径（accept 幂等，对端 ok 态重收无副作用）。 */
export async function acceptFriend(did: string): Promise<void> {
  requireMy()
  const cur = listFriends().find((f) => accountDidEq(f.did, did))
  if (!cur) throw new Error('没有来自该账号的好友请求')
  if (fstOf(cur) === 'out-pending') throw new Error('请求由你发起，等待对方通过')
  upsertFriend(did, cur.name || '有灵账号', 'ok')
  await friendDeliver(did, 'friend-accept')
}

/** 忽略好友请求（=拒绝）：本地清待确认行 + 发 friend-remove（发起方 out-pending 行
 *  随之删除——"对方未通过"由行消失表达，与旧服务器双删语义一致）。 */
export async function ignoreFriend(did: string): Promise<void> {
  requireMy()
  removePendingFriend(did)
  await friendDeliver(did, 'friend-remove')
}

export async function createGroup(name: string, members: string[]): Promise<string> {
  const my = requireMy()
  const gid = `grp-${Date.now().toString(36)}`
  const all = [...new Set([my, ...members])]
  const nm = name || '新群聊'
  upsertGroup(gid, nm, all, my) // 第85轮：建群者=群主（owner）
  // 批二：建群记录落自己群会话（"群已创建"系统条 + 对账载体——其他成员的对账可从
  // 任一持有本条的设备补齐真 owner；msgId 与扇出信封同，幂等）。
  appendMsg(gid, { msgId: `grp-create-${gid}`, from: my, to: gid, kind: 'group-create',
    payload: { groupId: gid, groupName: nm, members: all, owner: my }, ts: Date.now(), dir: 'out', fromName: myName() })
  // 第89轮（2026-09-28 对齐 PC f767066）：group-create 不走服务器信箱——P2P 逐成员
  // 扇出（best-effort，信封带 fromDevice 过 auth_gate）。无直连面的设备（对方手机）
  // 收不到直推，靠群消息 payload 兜底建群 + 60s 对账补齐（chatSendGroup 的落盘
  // payload 已带 members）。
  // 批二：信封 msgId 固定 grp-create-{gid}（与 PC 同式）——直推/对账/本地落条三路径
  // 同 msgId 幂等，"群已创建"系统条不重复。
  const payload: Record<string, unknown> = { groupId: gid, groupName: nm, members: all, fromName: myName(), owner: my }
  const { buildEnvelope, p2pDeliver } = await import('./p2p') // 动态 import 防模块环
  const envelope = buildEnvelope('', 'group-create', payload, `grp-create-${gid}`, Date.now())
  let anyDelivered = false
  for (const m of members) {
    if (accountDidEq(m, my)) continue
    if (await p2pDeliver(m, envelope).catch(() => false)) anyDelivered = true
  }
  const others = members.filter((m) => !accountDidEq(m, my))
  if (!anyDelivered && others.length) {
    // 全体不可达 → 入待发队列（任一成员上线即补扇出；group-create 按 groupId/msgId 幂等无害）
    const { enqueueOutbox } = await import('./outbox')
    await enqueueOutbox(gid, others, envelope)
  }
  return gid
}

/** 分享任务卡（conv=好友 did 或群 id；群逐成员单发）。 */
export async function shareTask(conv: string, card: { title: string; desc?: string; requirements?: string; reward?: string; expiresDays?: number }): Promise<void> {
  const my = requireMy()
  if (!card.title.trim()) throw new Error('任务标题不能为空')
  const taskId = `peer-task-${Date.now().toString(36)}`
  const payload: Record<string, unknown> = {
    taskId, title: card.title.trim().slice(0, 48), desc: (card.desc || '').trim().slice(0, 400),
    from: my, fromName: myName(), createdAt: Date.now(), source: 'peer',
    // 第83轮：分享者自动进 participants（role=owner）——多人协作可见
    participants: [{ did: my, name: myName(), role: 'owner' }],
  }
  if (card.requirements?.trim()) payload.requirements = card.requirements.trim().slice(0, 400)
  if (card.reward?.trim()) payload.reward = card.reward.trim().slice(0, 32)
  if (card.expiresDays && card.expiresDays > 0) payload.expiresAt = Date.now() + card.expiresDays * 86_400_000
  const targets = conv.startsWith('grp-')
    ? (listGroups().find((g) => g.id === conv)?.members ?? []).filter((m) => !accountDidEq(m, my))
    : [conv]
  if (conv.startsWith('grp-')) {
    const g = listGroups().find((x) => x.id === conv)
    if (!g) throw new Error('群不存在（可能已被清理，重进好友分区刷新）')
    if (groupTerminalStatus(g)) throw new Error('群已解散或你已被移出，无法分享任务卡') // 批二：终态只读
  }
  if (!targets.length) throw new Error('没有可分享的成员')
  // 批二：群 conv → 群会话一条 task-share（to=grp-*，p2pSendRaw 按 members 端侧扇出，
  // 含自己其他设备）——接收端 ingest 落群会话（全员可见同一张卡），不再逐成员单发。
  // 单聊分享行为不变（逐目标直推，失败自动入离线队列）。
  let agg: ChatMsg['sendState'] = 'failed'
  if (conv.startsWith('grp-')) {
    const g = listGroups().find((x) => x.id === conv)!
    payload.groupId = conv
    payload.groupName = g.name
    payload.members = g.members
    const { sendState } = await p2pSendRaw(conv, 'task-share', payload)
    agg = sendState
  } else {
    for (const t of targets) {
      const { sendState } = await p2pSendRaw(t, 'task-share', payload)
      agg = sendState === 'sent' ? 'sent' : agg !== 'sent' ? sendState : agg
    }
  }
  appendOut(conv, my, conv, 'task-share', payload, taskId, Date.now(), agg)
  // 分享出登记本地库（status=shared）：task-accept/done 回执的系统条靠它取真实标题。
  // 批五：任务页不再过滤 shared——自己的卡按 peerTaskView 创建者视角（「我发起的」）展示。
  registerSharedTask(conv, my, myName(), payload)
}

/** 批五（2026-09-29 用户实测）：分享者自己的任务卡登记（从 shareTask 抽出，可单测）。
 *  幂等：同 taskId 已存在（对账/多设备回流入过库）不重复推。 */
export function registerSharedTask(conv: string, my: string, myNm: string, payload: Record<string, unknown>): PeerTask {
  const tasks = listTasks()
  const taskId = String(payload.taskId || '')
  const hit = tasks.find((t) => t.taskId === taskId)
  if (hit) return hit
  const t: PeerTask = { taskId, title: String(payload.title || '任务'), desc: payload.desc as string | undefined,
    requirements: payload.requirements as string | undefined, rSpec: payload.r_spec as PeerTask['rSpec'],
    reward: payload.reward as string | undefined, from: my, fromName: myNm,
    createdAt: payload.createdAt as number, expiresAt: payload.expiresAt as number | undefined,
    participants: payload.participants as TaskParticipant[], source: 'peer',
    status: 'shared', convId: didSafe(conv) }
  tasks.push(t)
  writeArr(K.tasks(), tasks)
  return t
}

/** 批五：任务行视图模型（纯函数，单测覆盖）——创建者视角 vs 接受者视角。
 *  背景：分享者自己的卡 status=shared 此前被任务页整体过滤（"自己发的任务卡看不见"
 *  根因）；现在自己的卡也进列表，但语义必须是「我发起的」而非「待我做」。
 *  mine=true（from===自己）→ statusKey 归约：
 *    done=已完成；有人接了（participants 出现 owner 以外 did）或同账号自动接受（todo）/doing
 *    =进行中；否则（shared 无人接）=待接受。
 *  mine=false → statusKey 原样透传（pending/todo/doing/done，标签映射在渲染层）。 */
export function peerTaskView(t: PeerTask, my: string | null): { mine: boolean; statusKey: string } {
  const mine = !!my && accountDidEq(t.from, my)
  if (t.status === 'done') return { mine, statusKey: 'done' }
  if (mine) {
    const someoneAccepted = (t.participants ?? []).some((p) => p.did && p.did !== t.from)
    const active = someoneAccepted || t.status === 'todo' || t.status === 'doing'
    return { mine, statusKey: active ? 'doing' : 'pending' }
  }
  return { mine, statusKey: t.status }
}

/** 我的任务列表里**可点开的那张分享卡**（喂给 `openTaskShare` 的坐标）。
 *  三个坐标缺一不可（shareId + 源设备 + 源账号）：缺了就没有可打开的入口——
 *  宁可返回 null（UI 不显示"打开"），也不给一个点了必然失败的假入口。
 *  2026-10-10 兜底：顶层缺坐标时从 `action.url` 的 query 抠（remoteOpen 入口
 *  本就带着 shareId/device/account 三坐标）——老卡/缺字段的卡不再误判"打不开"。 */
export function taskShareCardOf(t: PeerTask): {
  shareId: string; sourceDevice: string; sourceAccount: string; sourceDeviceName?: string; title?: string
} | null {
  const urlQ = actionShareCoords(t as unknown as Record<string, unknown>)
  const shareId = String(t.shareId || '').trim() || urlQ.shareId
  const sourceDevice = String(t.sourceDevice || '').trim() || urlQ.device
  const sourceAccount = (String(t.sourceAccount || t.from || '').trim() || urlQ.account)
  if (!shareId || !sourceDevice || !sourceAccount) return null
  return {
    shareId, sourceDevice, sourceAccount,
    sourceDeviceName: t.sourceDeviceName || t.fromName || undefined,
    title: t.title || undefined,
  }
}

const SPACE_LABEL: Record<string, string> = { machine: '整机', project: '这个项目', session: '指定会话' }

/** **我的权限**摘要（人话，一行）——"我在这个任务里能做什么"：
 *  只读/读写 + 可见范围（空间档 + 时间窗），owner 单独一档。
 *  赠卡缺失时**不猜**（说"权限未知"而不是默认给全权）。 */
export function taskPermLabel(t: PeerTask): string {
  if (t.myRole === 'owner' || (!t.grant && !t.remoteOrigin)) return '我的（全权）'
  const g = t.grant
  if (!g) return '权限未知（让对方重新分享一次）'
  const rw = g.ro ? '只读' : '可看可说'
  const sp = g.visibility?.space ? (SPACE_LABEL[g.visibility.space] ?? '') : ''
  const win = typeof g.visibility?.windowMs === 'number' ? g.visibility.windowMs
    : (typeof g.windowMs === 'number' ? g.windowMs : null)
  const winTxt = win && win > 0 ? `最近${Math.max(1, Math.round(win / 3_600_000))}小时` : ''
  return [rw, sp, winTxt].filter(Boolean).join(' · ') || '按任务默认'
}

/** **能不能转给第三人**（§3.23 的本地那一半；真相与判定仍在源设备）。 */
export function taskCanReshare(t: PeerTask, now = Date.now()): boolean {
  if (t.myRole === 'owner' || (!t.remoteOrigin && !t.shareId)) return true
  if (t.canReshare !== true) return false
  return typeof t.reshareExp === 'number' && t.reshareExp > now
}

/** 转授批示入库（`reshare-grant` 的落点）：按 shareId 找到本机那张卡，刷新转授面。
 *  **不新增卡、不落气泡**——主人改了主意不该变成一条聊天记录。 */
export function applyReshareUpdate(p: Record<string, unknown>): boolean {
  const sid = String(p.shareId || '').trim()
  if (!sid) return false
  const tasks = listTasks()
  let hit = false
  for (const t of tasks) {
    if (t.shareId !== sid) continue
    t.canReshare = p.canReshare === true
    if (typeof p.reshareExp === 'number') t.reshareExp = p.reshareExp
    if (typeof p.reshareVia === 'string' || p.reshareVia === null) t.reshareVia = (p.reshareVia as string | null)
    hit = true
  }
  if (hit) writeArr(K.tasks(), tasks)
  return hit
}

/** 接受任务卡：pending→todo + 回发 task-accept（HBL 词表 claim）。 * 第83轮：接受者进 participants（role=member），回执带全量 participants（对端合并去重）。
 * 批二：群任务的回执群广播（convId=grp-*）——所有成员的群会话落"X 一起接了任务《Y》"。 */
export async function acceptTask(taskId: string): Promise<void> {
  const my = requireMy()
  const tasks = listTasks()
  const t = tasks.find((x) => x.taskId === taskId)
  if (!t) throw new Error('任务卡不存在')
  const nm = myName()
  if (t.status === 'pending') {
    if (taskExpired(t)) throw new Error('任务卡已过期')
    t.status = 'todo'
    t.acceptedAt = Date.now()
  }
  t.participants = mergeParticipants(t.participants, [{ did: my, name: nm, role: 'member', acceptedAt: Date.now() }])
  writeArr(K.tasks(), tasks)
  if (t.convId.startsWith('grp-')) {
    // 批二：群广播（to=群 id 按 members 端侧扇出）+ 本地落回执（自己屏幕可见，幂等）
    const members = listGroups().find((g) => g.id === t.convId)?.members ?? []
    const { msgId, ts, sendState } = await p2pSendRaw(t.convId, 'task-accept', {
      event: 'claim', task_id: taskId, worker_did: my, from: my, ts: Date.now(),
      name: nm, participants: t.participants, groupId: t.convId, members,
    })
    appendOut(t.convId, my, t.convId, 'task-accept', { task_id: taskId, title: t.title, name: nm, participants: t.participants }, msgId, ts, sendState)
    return
  }
  await p2pSendRaw(t.from, 'task-accept', { // 第84轮：P2P 直推
    event: 'claim', task_id: taskId, worker_did: my, from: my, ts: Date.now(),
    name: nm, participants: t.participants,
  })
}

/** 任务状态机 todo→doing→done；done 回发 task-done（HBL 词表 submit）。
 * 第83轮：done 时自己在 participants 里标 done + 回执带全量（"N 人协作完成"数据源）。 */
export async function setTaskStatus(taskId: string, status: string): Promise<void> {
  const my = requireMy()
  if (!['todo', 'doing', 'done'].includes(status)) throw new Error('非法状态')
  const tasks = listTasks()
  const t = tasks.find((x) => x.taskId === taskId)
  if (!t) throw new Error('任务不存在')
  const was = t.status
  t.status = status
  const nm = myName()
  let parts: TaskParticipant[] | undefined
  if (status === 'done') {
    t.doneAt = Date.now()
    t.participants = mergeParticipants(t.participants, [{ did: my, name: nm, status: 'done', doneAt: Date.now() }])
    parts = t.participants
  }
  writeArr(K.tasks(), tasks)
  if (status === 'done' && was !== 'done') {
    if (t.convId.startsWith('grp-')) {
      // 批二：群任务的 task-done 群广播——所有成员的群会话落"X 完成了任务《Y》"。
      const members = listGroups().find((g) => g.id === t.convId)?.members ?? []
      const { msgId, ts, sendState } = await p2pSendRaw(t.convId, 'task-done', {
        event: 'submit', task_id: taskId, worker_did: my, from: my, ts: Date.now(),
        name: nm, participants: parts ?? [], groupId: t.convId, members,
      })
      appendOut(t.convId, my, t.convId, 'task-done', { task_id: taskId, title: t.title, name: nm, participants: parts ?? [] }, msgId, ts, sendState)
      return
    }
    await p2pSendRaw(t.from, 'task-done', { // 第84轮：P2P 直推
      event: 'submit', task_id: taskId, worker_did: my, from: my, ts: Date.now(),
      name: nm, participants: parts ?? [],
    })
  }
}

// ══════════════ 任务卡改名（task-rename，2026-10-11） ══════════════
// 设计定稿口径：「没任务卡片的，不是建任务方的人也没机会接触到这个功能」——
// owner 单向广播的标题终局同步。wire：kind='task-rename'，payload={taskId,title(≤64),ts}
// （群任务另带 groupId/members 扇出锚），签名随行（p2pSendRaw 底座与现有 chat 消息一致）。
// 老端不认识 → ingestMsg default 丢弃：不崩、不入库。

/** 改名本地核（校验 + 任务库落盘 + 投递计划）——纯本地可单测（不碰网络）。
 *  返回 { payload, convId, sendTo }：sendTo grp-*=群扇出（payload 已带 members）/
 *  账号 did=单聊直推 / 空串=仅本地（convId 不可还原为 did 时跳过发送，设备群载体行
 *  仍保证 owner 多端同步）。 */
export function taskRenameApply(my: string, taskId: string, newTitle: string, ts = Date.now()): { payload: Record<string, unknown>; convId: string; sendTo: string } {
  const title = newTitle.trim().slice(0, 64) // wire 上限 64 字
  if (!title) throw new Error('任务标题不能为空')
  const tasks = listTasks()
  const t = tasks.find((x) => x.taskId === taskId)
  if (!t) throw new Error('任务不存在')
  // owner 闸（UI 入口只给 owner 看见；这里是强制校验——越权调用直接拒）
  if (!t.from || !accountDidEq(t.from, my)) throw new Error('只有任务发起人可以改名')
  t.title = title
  t.titleTs = ts // 冲突裁决锚：ts 大者生效（多端并发改名收敛到最新那条）
  writeArr(K.tasks(), tasks)
  const convId = t.convId || ''
  const payload: Record<string, unknown> = { taskId, title, ts }
  let sendTo = ''
  if (convId.startsWith('grp-')) {
    if (isDeviceGroup({ id: convId })) {
      // 任务会话就是本账号设备群（dsh-share 卡）：不外发，设备群载体行即同步
    } else {
      const g = listGroups().find((x) => x.id === convId)
      payload.groupId = convId
      payload.members = g?.members ?? []
      sendTo = convId
    }
  } else if (convId) {
    // 单聊：任务库 convId 是 did_safe 形态——还原原始对端 did 再直推
    // （还原不出=软 did/存量怪档：跳过发送，本地+设备群载体行照样生效）
    sendTo = restoreDidSafe(convId) ?? ''
  }
  return { payload, convId, sendTo }
}

/** owner 端改名入口（任务卡长按菜单「改名」）：本地更新 → P2P 发 task-rename 到任务
 *  会话 → 会话留痕行（对账载体：参与者手机从 owner 端拉）→ 设备群载体行（owner 自己
 *  多端同步：本账号对账服务面恒含设备群，不依赖对端在线/版本）。 */
export async function renameTask(taskId: string, newTitle: string): Promise<void> {
  const my = requireMy()
  const ts = Date.now()
  const { payload, convId, sendTo } = taskRenameApply(my, taskId, newTitle, ts)
  let msgId = newMsgId()
  let agg: ChatMsg['sendState'] = 'failed'
  if (sendTo) {
    const r = await p2pSendRaw(sendTo, 'task-rename', payload)
    msgId = r.msgId
    agg = r.sendState
  }
  // 任务会话留痕行（系统条 + 对账载体；msgId 与信封同——对端幂等键一致）
  if (convId) appendOut(convId, my, sendTo || convId, 'task-rename', payload, msgId, ts, sendTo ? agg : undefined)
  // 设备群载体行（owner 多端）：不落气泡（渲染层过滤 grp-dev-* 的 task-rename）
  const dgid = ensureDeviceGroup()
  if (dgid && dgid !== convId) {
    appendMsg(dgid, {
      msgId, from: my, to: dgid, kind: 'task-rename',
      payload: { ...payload, groupId: dgid }, ts, dir: 'out',
      fromDevice: currentIdentity()?.did ?? undefined, fromDeviceName: 'myco-phone',
    })
  }
}

// ══════════════ 后台轮询单例（第81轮补） ══════════════
// FriendsPanel 挂在身份 Tab 内——停在任务 Tab 时信箱无人拉。这里给 App 层一个
// 进程级单例轮询（5s），身份就绪即启；有新消息回调订阅者（好友列表红点/任务页刷新）。
// 2026-10-18 fast-ack 提速：**前台 1.5s / 后台 5s**（M7 收消息上屏更快；后台省电）。
type PollListener = (n: number) => void
const pollListeners = new Set<PollListener>()
let pollTimer: ReturnType<typeof setTimeout> | null = null
export function ensureBackgroundPoll(listener?: PollListener): () => void {
  if (listener) pollListeners.add(listener)
  if (!pollTimer) {
    const tick = (): void => {
      const interval = isForeground() ? 1_500 : 5_000
      pollTimer = setTimeout(() => {
        chatPoll()
          .then((n) => { if (n > 0) pollListeners.forEach((l) => l(n)) })
          .catch(() => { /* 断网/未登录静默，下一拍再试 */ })
          .finally(tick)
      }, interval)
    }
    tick()
  }
  return () => { if (listener) pollListeners.delete(listener) }
}

// ══════════════ 分享源桥（渲染层数据，零侵入任务逻辑） ══════════════
// TaskList 装载任务看板时侧写扁平清单；FriendsPanel 的"分享我的任务"读取。
// 只是数据搬运——youling 平台任务逻辑零改动。
let boardTasksCache: { title: string; projectName: string }[] = []
export function setBoardTasks(list: { title: string; projectName: string }[]): void { boardTasksCache = list }
export function getBoardTasks(): { title: string; projectName: string }[] { return boardTasksCache }

// ── E2E/dev 钩子（2026-10-20，与 dsh-open-runtime 里的 openShare 同款开关）────────────
// 目的：聊天类 R 指标（R1/R2/R6/R8）需要"手机真机发一条消息"，而 UI 自动化（点 tab、
// 填 textarea、按 Enter）在 WebView 里点不动。这里在 localStorage.myco_eval === '1'
// 时暴露最小发送钩子（等价用户点发送）；生产未设 flag 完全不可见。
try {
  if (typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('myco_eval') === '1') {
    const g = window as unknown as Record<string, unknown>
    const prev = (g.__mycoEval as Record<string, unknown> | undefined) ?? {}
    g.__mycoEval = {
      ...prev,
      /** 发一条文本到会话（to = convId：好友 did 或 grp-dev-* 群 id） */
      sendText: (to: string, text: string) =>
        (to.startsWith('grp-') ? chatSendGroup(to, { text }) : chatSendText(to, text))
          .then(() => 'ok').catch((e) => String(e)),
    }
  }
} catch { /* ignore */ }
