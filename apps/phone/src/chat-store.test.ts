// chat-store.test.ts — 手机好友聊天 store 单测（第81轮；照 FineState.test.ts 风格）。
// 存储层注入内存实现——纯逻辑测试零 localStorage 依赖；网络层不在本测范围（E2E 覆盖）。
// 好友握手链（2026-10-07 去服务端化）：fetch 全局 stub（名册归属闸）+ 真设备钥签名——零真网。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as ed from '@noble/ed25519'
// bs58 import 已删（2026-10-10）：06b3119 canonical-only 后夹具改字面量，此导入
// 成未使用——tsc -b noUnusedLocals 挡发版构建（vitest 不跑 tsc 故测试期未暴露）。
import {
  _setStorageForTest, ingestMsg, appendMsg, loadConv, upsertFriend, listFriends,
  upsertGroup, listGroups, listTasks, removePendingFriend, storeMedia, loadMediaB64,
  convPreview, CONV_MAX, type ServerMsg, type ChatStorage, taskExpired,
  mergeParticipants, type TaskParticipant, type PeerTask,
  friendIngest, ingestFriendHandshake, isFriendHandshakeKind,
  renderOrderMsgs,
  fmtFileSize, assertFileSize, FILE_MAX_BYTES, FILE_B64_MAX,
  fileMediaPut, loadFileB64, wirePackMsg, wirePackMsgAsync, type ChatMsg,
  sortConvMsgs, updateSendState, retrySend, migrateLegacyChatKeys,
  // 批四：撤回/草稿/偏好/未读/排序/时间分隔/长按菜单/删除
  getDraft, setDraft, convPref, setConvPinned, setConvMuted, deleteConv, deleteMsgLocal,
  unreadCount, unreadTotal, sortConvRows, needTimeSep, isSameDay, fmtConvTime, TIME_SEP_GAP_MS,
  canRecall, msgMenuActions, RECALL_WINDOW_MS, replyPatch, loadConvMeta,
  // 批二：群语义（owner 判定/终态/自愈建群）
  groupOwnerOf, groupOwnerPending, groupTerminalStatus, upsertGroupSelfheal,
  // 批五：自己的任务卡（创建者视角）
  registerSharedTask, peerTaskView,
  // 2026-10-09：设备群广播的嵌套卡摊平（真卡可点）+ 设备群 id 派生
  flattenTaskSharePayload, deviceGroupId,
  // §3.23 任务卡进「我的任务列表」+ 转授闸（canReshare）
  taskShareCardOf, taskPermLabel, taskCanReshare, applyReshareUpdate,
  // 2026-10-11 任务卡改名（task-rename）
  taskRenameApply,
  // 2026-10-18对账重放治理：wire msgId 内存去重索引
  wireMsgSeen, markWireMsgSeen, seedWireMsgSeen, seedWireMsgSeenFromStorage, _resetWireSeenForTest,
  // 2026-10-18渲染风暴治理：读库结果增量合并
  mergeConvView, } from './chat-store'
import { shareCardOf } from './share-entry'
import { friendSignMaterial } from './identity'
import { didFromPubkey } from './didUtil'

const MY = 'did:youling:AAA'
const PEER = 'did:youling:BBB'
const EVIL = 'did:youling:EVIL'

function memStorage(): ChatStorage & { dump: Map<string, string> } {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v) },
    del: (k) => { m.delete(k) },
    dump: m,
  }
}

// 第84轮：id 默认递增（appendMsg 已按 msgId 幂等——固定 id 的连续消息会被
// 当重复丢弃；显式传 id 的用例不受影响）
let srvSeq = 0
const S = (over: Partial<ServerMsg> = {}): ServerMsg => ({
  seq: 1, id: `srv-${++srvSeq}`, from: PEER, fromName: '好友B', fromDevice: 'did:myco:X',
  kind: 'text', payload: { text: '你好' }, ts: Date.now(), ...over,
})

let st: ReturnType<typeof memStorage>
beforeEach(() => { st = memStorage(); _setStorageForTest(st) })

describe('ingestMsg 入库状态机', () => {
  it('text → 入好友会话 dir=in', () => {
    expect(ingestMsg(MY, S())).toBe(true)
    const conv = loadConv(PEER)
    expect(conv).toHaveLength(1)
    expect(conv[0].dir).toBe('in')
    expect(conv[0].payload.text).toBe('你好')
  })

  it('friend-* kind 不进同步状态机（2026-10-07 去服务端化：chatPoll 分流去 ingestFriendHandshake）', () => {
    // 握手走异步验签链（验签+名册归属+状态机）；ingestMsg/对账 wire 同步路径防御性丢弃
    expect(isFriendHandshakeKind('friend-request')).toBe(true)
    expect(isFriendHandshakeKind('friend-accept')).toBe(true)
    expect(isFriendHandshakeKind('friend-remove')).toBe(true)
    expect(isFriendHandshakeKind('text')).toBe(false)
    expect(ingestMsg(MY, S({ kind: 'friend-request', payload: { fromName: '旧路径' } }))).toBe(false)
    expect(listFriends().length).toBe(0)
    expect(ingestMsg(MY, S({ kind: 'friend-accept', payload: {} }))).toBe(false)
    expect(ingestMsg(MY, S({ kind: 'friend-remove', payload: {} }))).toBe(false)
  })

  it('group-create → 建群档案；group-msg(文本) → 群会话', () => {
    ingestMsg(MY, S({ kind: 'group-create', payload: { groupId: 'grp-1', groupName: '测试群', members: [MY, PEER] } }))
    expect(listGroups()[0]).toMatchObject({ id: 'grp-1', name: '测试群' })
    ingestMsg(MY, S({ kind: 'group-msg', payload: { groupId: 'grp-1', groupName: '测试群', fromName: '好友B', members: [MY, PEER], text: '群消息' } }))
    const conv = loadConv('grp-1')
    // 批二：group-create 也落群会话（"群已创建"系统条 + 对账载体）→ 2 条
    expect(conv).toHaveLength(2)
    expect(conv[1].kind).toBe('group-msg')
    expect(convPreview(conv[1])).toBe('群消息')
  })

  it('group-msg(图片) → media 键存档 + 会话 mediaId 引用', () => {
    ingestMsg(MY, S({ id: 'img-1', kind: 'group-msg', payload: { groupId: 'grp-1', groupName: 'g', image: { name: 'a.png', mime: 'image/png', b64: 'QUJD' } } }))
    expect(loadMediaB64('img-1')).toBe('QUJD')
    const conv = loadConv('grp-1')
    expect(conv[0].kind).toBe('image')
    expect(conv[0].payload).toMatchObject({ name: 'a.png', mediaId: 'img-1' })
  })

  it('2026-09-28：group-msg 兜底建群带 members（人数正确）+ 扁平 b64 图片（对账回流 PC 落盘形态）→ image', () => {
    // 兜底建群：群档案未知时首条 group-msg 带 members 秒建（PC 建群直推对手机不可达的补偿路径）
    ingestMsg(MY, S({ kind: 'group-msg', payload: { groupId: 'grp-9', groupName: '兜底群', members: [MY, PEER], text: 'hi' }, ts: 1000 }))
    const g = listGroups().find((x) => x.id === 'grp-9')
    expect(g?.members).toEqual([MY, PEER])
    // 扁平 b64（PC 落盘 name/mime/media → wire_pack 展平成 b64）——不识别会当文本落成空气泡
    // 第95轮：显式 ts——loadConv 已按 (ts,msgId) 排序（同 ms 时不再保插入序）
    ingestMsg(MY, S({ id: 'img-2', kind: 'group-msg', payload: { groupId: 'grp-9', groupName: '兜底群', members: [MY, PEER], name: 'b.png', mime: 'image/png', b64: 'REVG' }, ts: 2000 }))
    expect(loadMediaB64('img-2')).toBe('REVG')
    const conv = loadConv('grp-9')
    expect(conv).toHaveLength(2)
    expect(conv[1].kind).toBe('image')
    expect(conv[1].payload).toMatchObject({ name: 'b.png', mediaId: 'img-2' })
  })

  it('task-share → 会话+任务库 pending；task-accept/task-done → 系统条带标题', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-1', title: '写文档', desc: '介绍', from: PEER, fromName: '好友B', createdAt: 1 } }))
    expect(listTasks()).toEqual([expect.objectContaining({ taskId: 'peer-task-1', title: '写文档', status: 'pending' })])
    ingestMsg(MY, S({ kind: 'task-accept', payload: { event: 'claim', task_id: 'peer-task-1', worker_did: PEER } }))
    ingestMsg(MY, S({ kind: 'task-done', payload: { event: 'submit', task_id: 'peer-task-1' } }))
    const conv = loadConv(PEER)
    expect(conv.map((m) => m.kind)).toEqual(['task-share', 'task-accept', 'task-done'])
    expect(convPreview(conv[1])).toBe('已接受任务《写文档》')
    expect(convPreview(conv[2])).toBe('已完成任务《写文档》')
  })

  it('2026-10-27：task-share 外层 status=revoked → 手机任务卡 tombstone，历史卡不得回灌', () => {
    const gid = 'grp-dev-tombstone'
    const card = { taskId: 'peer-task-share-sh-x', title: '旧测试卡', shareId: 'sh-x', from: MY, fromName: 'CJ26', status: 'todo' }
    ingestMsg(MY, S({ from: MY, kind: 'task-share', to: gid, payload: { groupId: gid, groupName: '设备群', members: [MY], status: 'todo', card } }))
    expect(listTasks()).toEqual([expect.objectContaining({ taskId: card.taskId, shareId: 'sh-x' })])
    // O07 真机回灌形状：本地调试曾绕过 ingestMsg 直写任务库，留下无顶层 shareId、
    // 只有 action.url 的手工副本；这里同样直写存储模拟该历史污染。
    const taskKey = [...st.dump.keys()].find((k) => k.endsWith('.tasks'))
    expect(taskKey).toBeTruthy()
    const polluted = JSON.parse(st.get(taskKey!) as string) as PeerTask[]
    polluted.push({ taskId: 'task-o07-x', title: '旧测试卡副本', from: MY, status: 'pending', convId: gid, action: { kind: 'open-url', label: '打开', url: 'http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-x&device=did:myco:pc&account=did:youling:x' } })
    // 复核 blocker 形状：污染副本必须排在 anchor 前，暴露 tombstone upsert 少补 taskId 的顺序依赖。
    polluted.unshift(polluted.pop()!)
    st.set(taskKey!, JSON.stringify(polluted))
    expect(listTasks()).toHaveLength(2)
    // PC /api/chat/tombstoneTasks 的广播形态：外层 status=revoked，card 只带 taskId。
    const ok = ingestMsg(MY, S({ from: MY, kind: 'task-share', to: gid, payload: { groupId: gid, groupName: '设备群', members: [MY], status: 'revoked', card: { taskId: card.taskId, title: '' } } }))
    expect(ok).toBe(true)
    expect(listTasks().some((t) => t.taskId === card.taskId || t.taskId === 'task-o07-x' || t.shareId === 'sh-x')).toBe(false)
    // 迟到的历史卡重放也不能复活（手机端本地 tombstone）。
    ingestMsg(MY, S({ from: MY, kind: 'task-share', to: gid, payload: { groupId: gid, groupName: '设备群', members: [MY], status: 'todo', card } }))
    expect(listTasks().some((t) => t.taskId === card.taskId || t.taskId === 'task-o07-x' || t.shareId === 'sh-x')).toBe(false)
    // blocker 形状：anchor 卡迟到重放且 wire 缺 shareId/action.url——tombstone 必须已补 taskId。
    ingestMsg(MY, S({ from: MY, kind: 'task-share', to: gid, payload: { groupId: gid, groupName: '设备群', members: [MY], status: 'todo', card: { taskId: card.taskId, title: '旧测试卡', from: MY } } }))
    expect(listTasks().some((t) => t.taskId === card.taskId)).toBe(false)
  })

  it('2026-10-27 安全闸：非本账号/非任务 owner 的 status=revoked 不得删卡或污染 tombstone', () => {
    ingestMsg(MY, S({ from: PEER, kind: 'task-share', payload: { taskId: 'peer-task-owner-x', title: '好友卡', shareId: 'sh-owner-x', from: PEER, fromName: '好友B' } }))
    expect(listTasks()).toHaveLength(1)
    const evil = ingestMsg(MY, S({ from: EVIL, kind: 'task-share', payload: { taskId: 'peer-task-owner-x', title: '', status: 'revoked' } }))
    expect(evil).toBe(false)
    expect(listTasks()).toHaveLength(1)
    // owner 自己的 revoke 才生效。
    expect(ingestMsg(MY, S({ from: PEER, kind: 'task-share', payload: { taskId: 'peer-task-owner-x', title: '', status: 'revoked' } }))).toBe(true)
    expect(listTasks()).toHaveLength(0)
  })

  it('未知 kind 丢弃（返回 false）', () => {
    expect(ingestMsg(MY, S({ kind: 'unknown-x' }))).toBe(false)
  })
})

describe('会话滚动与媒体 FIFO', () => {
  it(`单会话 ${CONV_MAX} 条上限，超限丢最老`, () => {
    for (let i = 0; i < CONV_MAX + 20; i++) {
      appendMsg(PEER, { msgId: `m${i}`, from: PEER, to: MY, kind: 'text', payload: { text: String(i) }, ts: i, dir: 'in' })
    }
    const conv = loadConv(PEER)
    expect(conv).toHaveLength(CONV_MAX)
    expect(conv[0].payload.text).toBe('20') // 最老 20 条被挤掉
  })

  it('媒体键 FIFO 淘汰（防 localStorage 撑爆）', () => {
    for (let i = 0; i < 30; i++) storeMedia(`media-${i}`, 'X'.repeat(10))
    expect(loadMediaB64('media-0')).toBeNull()
    expect(loadMediaB64('media-29')).not.toBeNull()
  })
})

describe('杂项', () => {
  it('removePendingFriend 只删待确认行', () => {
    upsertFriend(PEER, 'B', 'in-pending')
    upsertFriend('did:youling:CCC', 'C', 'ok')
    removePendingFriend(PEER)
    expect(listFriends().map((f) => f.did)).toEqual(['did:youling:CCC'])
  })

  it('upsertGroup 更新不重复', () => {
    upsertGroup('g', '旧名', [MY])
    upsertGroup('g', '新名', [MY, PEER])
    expect(listGroups()).toHaveLength(1)
    expect(listGroups()[0].name).toBe('新名')
  })

  it('taskExpired 判定', () => {
    expect(taskExpired({ expiresAt: Date.now() - 1 })).toBe(true)
    expect(taskExpired({ expiresAt: Date.now() + 1000 })).toBe(false)
    expect(taskExpired({})).toBe(false)
  })
})

describe('第83轮：participants 合并与任务卡协作流', () => {
  it('mergeParticipants 按 did 去重：incoming 覆盖 role/时间戳、status 只在有值时覆盖、name 只补空', () => {
    const cur: TaskParticipant[] = [
      { did: 'did:a', name: '阿甲', role: 'owner', status: 'done', doneAt: 9 },
    ]
    const out = mergeParticipants(cur, [
      { did: 'did:a', role: 'member', acceptedAt: 5 },          // 覆盖 role；不带 status → 保留 done
      { did: 'did:b', name: '阿乙', role: 'member', acceptedAt: 5 }, // 新 did → 追加
      { did: '', name: '空 did 不入库', role: 'member' },        // 空 did 丢弃
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ did: 'did:a', name: '阿甲', role: 'member', status: 'done', acceptedAt: 5 })
    expect(out[1]).toMatchObject({ did: 'did:b', name: '阿乙', role: 'member' })
    // 纯函数：不改入参
    expect(cur[0].role).toBe('owner')
    // name 空时用 incoming 补
    const out2 = mergeParticipants([{ did: 'did:a', role: 'owner' }], [{ did: 'did:a', name: '新名' }])
    expect(out2[0].name).toBe('新名')
    expect(out2[0].role).toBe('owner') // incoming 无 role → 不覆盖
  })

  it('task-share 带 participants(owner) 入库；task-accept 带 participants 全量 → 本地合并出双方', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: {
      taskId: 'peer-task-p1', title: '协作任务', from: PEER, fromName: '好友B',
      participants: [{ did: PEER, name: '好友B', role: 'owner' }],
    } }))
    const t0 = listTasks().find((t) => t.taskId === 'peer-task-p1')
    expect(t0).toMatchObject({ status: 'pending' })
    expect(t0?.participants).toEqual([{ did: PEER, name: '好友B', role: 'owner' }])
    // 接受回执（带全量 participants + name）：本地合并去重
    ingestMsg(MY, S({ kind: 'task-accept', payload: {
      event: 'claim', task_id: 'peer-task-p1', name: '好友B',
      participants: [
        { did: PEER, name: '好友B', role: 'owner' },
        { did: MY, name: '我', role: 'member', acceptedAt: 1 },
      ],
    } }))
    const t1 = listTasks().find((t) => t.taskId === 'peer-task-p1')
    expect((t1?.participants ?? []).map((p) => p.did).sort()).toEqual([MY, PEER].sort())
    // 回执气泡带 name（"一起"语系）
    const conv1 = loadConv(PEER)
    expect(convPreview(conv1[conv1.length - 1])).toBe('好友B 一起接了任务《协作任务》')
  })

  it('task-done 带 participants → 任务置 done + 参与方全部标完成（"N 人协作完成"数据源）', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: {
      taskId: 'peer-task-p2', title: '完结任务', from: PEER,
      participants: [{ did: PEER, name: '好友B', role: 'owner' }],
    } }))
    ingestMsg(MY, S({ kind: 'task-done', payload: {
      event: 'submit', task_id: 'peer-task-p2', name: '好友B',
      participants: [
        { did: PEER, name: '好友B', role: 'owner', status: 'done', doneAt: 2 },
        { did: MY, name: '我', role: 'member', status: 'done', doneAt: 2 },
      ],
    } }))
    const t = listTasks().find((x) => x.taskId === 'peer-task-p2')
    expect(t?.status).toBe('done')
    expect(t?.doneAt).toBeTruthy()
    expect(t?.participants).toHaveLength(2)
    expect(t?.participants?.every((p) => p.status === 'done')).toBe(true)
    const conv2 = loadConv(PEER)
    expect(convPreview(conv2[conv2.length - 1])).toBe('好友B 完成了任务《完结任务》')
  })

  it('旧版回执（无 participants/name）向后兼容：仅落会话条，任务库不动', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-p3', title: '旧卡', from: PEER, participants: [{ did: PEER, name: '好友B', role: 'owner' }] } }))
    ingestMsg(MY, S({ kind: 'task-done', payload: { event: 'submit', task_id: 'peer-task-p3' } }))
    const t = listTasks().find((x) => x.taskId === 'peer-task-p3')
    expect(t?.status).toBe('done') // 无 participants 也置 done（done 归一不依赖 participants）
    expect(t?.participants).toEqual([{ did: PEER, name: '好友B', role: 'owner' }]) // participants 不变
    const conv3 = loadConv(PEER)
    expect(convPreview(conv3[conv3.length - 1])).toBe('已完成任务《旧卡》') // 无 name → 老文案
  })
})

describe('批二（2026-09-28）：群语义修正——群卡落群/解散/被踢/owner 自愈', () => {
  const ALICE = 'did:youling:ALICE' // 群主
  const BOB = 'did:youling:BOB'     // 普通成员

  it('批1：群任务卡落群会话（全员可见）+ 接受/完成回执群广播落群；单聊行为不变', () => {
    const gid = 'grp-p1'
    ingestMsg(MY, S({ id: 'gc-p1', from: ALICE, kind: 'group-create', payload: { groupId: gid, groupName: '任务群', members: [MY, ALICE, BOB], owner: ALICE }, ts: 1000 }))
    // 群任务卡（payload.groupId=grp-*）→ 落群会话；任务库 convId=群 id
    ingestMsg(MY, S({ id: 'ts-p1', from: ALICE, kind: 'task-share', payload: {
      taskId: 'peer-task-g1', title: '群周报', from: ALICE, fromName: '爱丽丝', createdAt: 1001,
      groupId: gid, groupName: '任务群', members: [MY, ALICE, BOB],
      participants: [{ did: ALICE, name: '爱丽丝', role: 'owner' }],
    }, ts: 1001 }))
    const gconv = loadConv(gid)
    expect(gconv.map((m) => m.kind)).toContain('task-share')
    const t = listTasks().find((x) => x.taskId === 'peer-task-g1')
    expect(t).toMatchObject({ convId: gid, status: 'pending' })
    // 不落与分享者的单聊
    expect(loadConv(ALICE).every((m) => m.kind !== 'task-share')).toBe(true)
    // 回执群广播（BOB 接了/完成了）→ 落群会话 + 任务库合并
    ingestMsg(MY, S({ id: 'ta-p1', from: BOB, kind: 'task-accept', payload: {
      event: 'claim', task_id: 'peer-task-g1', worker_did: BOB, groupId: gid, name: '鲍勃',
      participants: [{ did: ALICE, role: 'owner' }, { did: BOB, name: '鲍勃', role: 'member', acceptedAt: 1002 }],
    }, ts: 1002 }))
    ingestMsg(MY, S({ id: 'td-p1', from: BOB, kind: 'task-done', payload: {
      event: 'submit', task_id: 'peer-task-g1', worker_did: BOB, groupId: gid, name: '鲍勃',
      participants: [{ did: ALICE, role: 'owner' }, { did: BOB, name: '鲍勃', status: 'done', doneAt: 1003 }],
    }, ts: 1003 }))
    const kinds = loadConv(gid).map((m) => m.kind)
    expect(kinds).toContain('task-accept')
    expect(kinds).toContain('task-done')
    const t2 = listTasks().find((x) => x.taskId === 'peer-task-g1')
    expect(t2?.status).toBe('done')
    expect(t2?.participants).toHaveLength(2)
    // 回执不落与 BOB 的单聊
    expect(loadConv(BOB)).toHaveLength(0)
    // 单聊分享行为不变（无 groupId → 落单聊）
    ingestMsg(MY, S({ id: 'ts-d1', from: BOB, kind: 'task-share', payload: { taskId: 'peer-task-d1', title: '单聊卡', from: BOB, createdAt: 1004 }, ts: 1004 }))
    expect(loadConv(BOB).map((m) => m.kind)).toContain('task-share')
    expect(listTasks().find((x) => x.taskId === 'peer-task-d1')).toMatchObject({ convId: BOB.replace(/[:/]/g, '_') })
    // 回执预览文案（"一起"语系）在群会话可见
    const acceptMsg = loadConv(gid).find((m) => m.kind === 'task-accept')!
    expect(convPreview(acceptMsg)).toBe('鲍勃 一起接了任务《群周报》')
  })

  it('批1+批4：群任务卡先于 group-create 到达 → 自愈建群 ownerPending', () => {
    const gid = 'grp-p1b'
    ingestMsg(MY, S({ id: 'ts-p1b', from: ALICE, kind: 'task-share', payload: {
      taskId: 'peer-task-g1b', title: '自愈卡', from: ALICE, groupId: gid, groupName: '自愈群', members: [MY, ALICE, BOB],
    }, ts: 1000 }))
    const g = listGroups().find((x) => x.id === gid)
    expect(g).toBeTruthy()
    expect(groupOwnerPending(g!)).toBe(true)
    expect(g?.members).toHaveLength(3)
    expect(loadConv(gid).map((m) => m.kind)).toContain('task-share')
  })

  it('批2：群主退群=解散——治理闸/终态语义/compat leave 不双条/幂等', () => {
    const gid = 'grp-p2'
    ingestMsg(MY, S({ id: 'gc-p2', from: ALICE, kind: 'group-create', payload: { groupId: gid, groupName: '解散群', members: [MY, ALICE, BOB], owner: ALICE }, ts: 1000 }))
    ingestMsg(MY, S({ id: 'gm-p2', from: ALICE, kind: 'group-msg', payload: { groupId: gid, groupName: '解散群', members: [MY, ALICE, BOB], text: '历史消息' }, ts: 1001 }))
    // 非群主的 disband 拒收（防伪造）
    expect(ingestMsg(MY, S({ id: 'gd-p2-fake', from: BOB, kind: 'group-disband', payload: { groupId: gid, groupName: '解散群' }, ts: 1002 }))).toBe(false)
    expect(groupTerminalStatus(listGroups().find((x) => x.id === gid)!)).toBe('')
    // 群主 disband → 终态：status=disbanded + members 清空 + 系统条 + 历史保留
    expect(ingestMsg(MY, S({ id: 'gd-p2', from: ALICE, kind: 'group-disband', payload: { groupId: gid, groupName: '解散群' }, ts: 1003 }))).toBe(true)
    const g = listGroups().find((x) => x.id === gid)
    expect(g).toBeTruthy() // 档案保留（只读）
    expect(groupTerminalStatus(g!)).toBe('disbanded')
    expect(g?.members).toHaveLength(0)
    const msgs = loadConv(gid)
    expect(msgs.some((m) => m.payload.text === '历史消息')).toBe(true) // 聊天历史保留
    const sys = msgs.filter((m) => m.kind === 'sys')
    expect(sys).toHaveLength(1)
    expect(String(sys[0].payload.text)).toContain('已被群主解散')
    // compat group-leave（老端降级用，随 disband 一并发出）→ 终态闸拒收，不双系统条
    expect(ingestMsg(MY, S({ id: 'gl-p2', from: ALICE, kind: 'group-leave', payload: { groupId: gid }, ts: 1004 }))).toBe(false)
    expect(loadConv(gid).filter((m) => m.kind === 'sys')).toHaveLength(1)
    // 终态群治理消息拒收（改名）
    expect(ingestMsg(MY, S({ id: 'gr-p2', from: ALICE, kind: 'group-rename', payload: { groupId: gid, newName: '诈尸' }, ts: 1005 }))).toBe(false)
    // 重复 disband 幂等（不重复落条）
    expect(ingestMsg(MY, S({ id: 'gd-p2-dup', from: ALICE, kind: 'group-disband', payload: { groupId: gid, groupName: '解散群' }, ts: 1006 }))).toBe(true)
    expect(loadConv(gid).filter((m) => m.kind === 'sys')).toHaveLength(1)
    // 未知群的 disband（无档案无从校验）→ 丢弃
    expect(ingestMsg(MY, S({ id: 'gd-p2x', from: ALICE, kind: 'group-disband', payload: { groupId: 'grp-p2x' }, ts: 1007 }))).toBe(false)
    // 迟到的 group-create（对账从持有方群会话补齐）→ 终态群不复活 members
    expect(ingestMsg(MY, S({ id: 'gc-p2-late', from: ALICE, kind: 'group-create', payload: { groupId: gid, groupName: '解散群', members: [MY, ALICE, BOB], owner: ALICE }, ts: 1008 }))).toBe(true)
    const g3 = listGroups().find((x) => x.id === gid)!
    expect(groupTerminalStatus(g3)).toBe('disbanded')
    expect(g3.members).toHaveLength(0)
  })

  it('批3：被踢=群会话保留只读+系统条"你已被移出群"（不再静默删群）', () => {
    const gid = 'grp-p3'
    ingestMsg(MY, S({ id: 'gc-p3', from: ALICE, kind: 'group-create', payload: { groupId: gid, groupName: '踢人群', members: [MY, ALICE, BOB], owner: ALICE }, ts: 1000 }))
    ingestMsg(MY, S({ id: 'gm-p3', from: BOB, kind: 'group-msg', payload: { groupId: gid, groupName: '踢人群', members: [MY, ALICE, BOB], text: '被踢前的聊天' }, ts: 1001 }))
    // 非群主伪 kick 拒收
    expect(ingestMsg(MY, S({ id: 'gk-p3-fake', from: BOB, kind: 'group-kick', payload: { groupId: gid, targetDid: MY }, ts: 1002 }))).toBe(false)
    // 群主踢我 → 终态 kicked：档案保留+系统条+历史保留+members 清空
    expect(ingestMsg(MY, S({ id: 'gk-p3', from: ALICE, kind: 'group-kick', payload: { groupId: gid, targetDid: MY, members: [ALICE, BOB] }, ts: 1003 }))).toBe(true)
    const g = listGroups().find((x) => x.id === gid)
    expect(g).toBeTruthy() // 档案保留（只读）
    expect(groupTerminalStatus(g!)).toBe('kicked')
    expect(g?.members).toHaveLength(0)
    const msgs = loadConv(gid)
    expect(msgs.some((m) => m.payload.text === '被踢前的聊天')).toBe(true)
    const sysTexts = msgs.filter((m) => m.kind === 'sys').map((m) => String(m.payload.text))
    expect(sysTexts.some((t) => t.includes('你已被移出群「踢人群」'))).toBe(true)
    // 重复投递幂等（不双条）
    expect(ingestMsg(MY, S({ id: 'gk-p3-dup', from: ALICE, kind: 'group-kick', payload: { groupId: gid, targetDid: MY }, ts: 1004 }))).toBe(true)
    expect(loadConv(gid).filter((m) => m.kind === 'sys')).toHaveLength(1)
  })

  it('批4：自愈建群 ownerPending 治理全拒 → group-create 落会话补齐真 owner 收敛', () => {
    const gid = 'grp-p4'
    // 离线期建的群：先收到群消息 → 自愈建群 ownerPending（不再首成员冒充群主）
    ingestMsg(MY, S({ id: 'gm-p4', from: BOB, kind: 'group-msg', payload: { groupId: gid, groupName: '自愈群', members: [BOB, ALICE, MY], text: 'hi' }, ts: 1000 }))
    const g0 = listGroups().find((x) => x.id === gid)
    expect(g0).toBeTruthy()
    expect(groupOwnerPending(g0!)).toBe(true)
    expect(groupOwnerOf(g0!)).toBe('') // BOB 是首成员但不是群主
    // 治理全拒：改名消息（含首成员 BOB 发的）拒收
    expect(ingestMsg(MY, S({ id: 'gr-p4-fake', from: BOB, kind: 'group-rename', payload: { groupId: gid, newName: '伪改名' }, ts: 1001 }))).toBe(false)
    expect(ingestMsg(MY, S({ id: 'gr-p4-fake2', from: ALICE, kind: 'group-rename', payload: { groupId: gid, newName: '伪改名2' }, ts: 1002 }))).toBe(false)
    expect(listGroups().find((x) => x.id === gid)?.name).toBe('自愈群')
    // group-create 补齐（直推或对账——批二起 group-create 落群会话参与对账）→ 真 owner 到达
    expect(ingestMsg(MY, S({ id: 'gc-p4', from: ALICE, kind: 'group-create', payload: { groupId: gid, groupName: '自愈群', members: [BOB, ALICE, MY], owner: ALICE }, ts: 1003 }))).toBe(true)
    const g1 = listGroups().find((x) => x.id === gid)!
    expect(groupOwnerPending(g1)).toBe(false)
    expect(groupOwnerOf(g1)).toBe(ALICE)
    // group-create 记录落在群会话（对账载体的凭据）
    expect(loadConv(gid).map((m) => m.kind)).toContain('group-create')
    // 治理恢复：真群主改名放行，非群主仍拒
    expect(ingestMsg(MY, S({ id: 'gr-p4', from: ALICE, kind: 'group-rename', payload: { groupId: gid, newName: '正名' }, ts: 1004 }))).toBe(true)
    expect(ingestMsg(MY, S({ id: 'gr-p4-b', from: BOB, kind: 'group-rename', payload: { groupId: gid, newName: '伪名' }, ts: 1005 }))).toBe(false)
    expect(listGroups().find((x) => x.id === gid)?.name).toBe('正名')
    // 同 msgId 重复 ingest（直推+对账双路径）→ 幂等只有一条 group-create
    expect(ingestMsg(MY, S({ id: 'gc-p4', from: ALICE, kind: 'group-create', payload: { groupId: gid, groupName: '自愈群', members: [BOB, ALICE, MY], owner: ALICE }, ts: 1003 }))).toBe(true)
    expect(loadConv(gid).filter((m) => m.kind === 'group-create')).toHaveLength(1)
  })

  it('批4 纯函数：groupOwnerOf/ownerPending/终态 + upsertGroupSelfheal 幂等', () => {
    // ownerPending → 无群主不兜底；owner 补齐 → 权威优先
    upsertGroupSelfheal('grp-p5', '自愈群', [BOB, ALICE, MY])
    const g = listGroups().find((x) => x.id === 'grp-p5')!
    expect(groupOwnerPending(g)).toBe(true)
    expect(groupOwnerOf(g)).toBe('')
    // 已有档案再 selfheal 不动（members 不覆盖）
    upsertGroupSelfheal('grp-p5', '别的名', [MY])
    expect(listGroups().find((x) => x.id === 'grp-p5')?.name).toBe('自愈群')
    // owner 到达（upsertGroup）→ ownerPending 清除
    upsertGroup('grp-p5', '自愈群', [BOB, ALICE, MY], ALICE)
    const g2 = listGroups().find((x) => x.id === 'grp-p5')!
    expect(groupOwnerPending(g2)).toBe(false)
    expect(groupOwnerOf(g2)).toBe(ALICE)
    // 老群（无 owner 无 ownerPending，第81-84轮存量）→ 首成员兜底兼容
    upsertGroup('grp-p5-legacy', '老群', [BOB, MY])
    expect(groupOwnerOf(listGroups().find((x) => x.id === 'grp-p5-legacy')!)).toBe(BOB)
    // 终态判定
    expect(groupTerminalStatus({ ...g2, status: 'disbanded' })).toBe('disbanded')
    expect(groupTerminalStatus({ ...g2, status: 'kicked' })).toBe('kicked')
    expect(groupTerminalStatus(g2)).toBe('')
    // group-create 预览人话
    expect(convPreview({ msgId: 'x', from: ALICE, to: 'grp-p5', kind: 'group-create', payload: { groupName: '自愈群' }, ts: 1, dir: 'in' })).toBe('群「自愈群」已创建')
  })
})

describe('2026-10-07 好友去服务端化——friendIngest 状态机 + ingestFriendHandshake 接收链', () => {
  // ── 纯函数：12 格全表（设计 §3.4；与 PC friend_ingest 同表）──
  it('friendIngest：request 无行→in-pending / out-pending→ok（互加）/ 其余幂等', () => {
    expect(friendIngest('friend-request', null)).toEqual({ act: 'status', status: 'in-pending' })
    expect(friendIngest('friend-request', 'out-pending')).toEqual({ act: 'status', status: 'ok' })
    expect(friendIngest('friend-request', 'in-pending')).toEqual({ act: 'keep' })
    expect(friendIngest('friend-request', 'ok')).toEqual({ act: 'keep' })
  })
  it('friendIngest：accept 无行→drop / 两 pending→ok / ok 幂等；remove 恒删', () => {
    expect(friendIngest('friend-accept', null)).toEqual({ act: 'drop' })
    expect(friendIngest('friend-accept', 'out-pending')).toEqual({ act: 'status', status: 'ok' })
    expect(friendIngest('friend-accept', 'in-pending')).toEqual({ act: 'status', status: 'ok' })
    expect(friendIngest('friend-accept', 'ok')).toEqual({ act: 'keep' })
    for (const cur of [null, 'out-pending', 'in-pending', 'ok'] as const) {
      expect(friendIngest('friend-remove', cur)).toEqual({ act: 'remove' })
    }
    expect(friendIngest('group-kick', 'ok')).toEqual({ act: 'drop' })
    expect(friendIngest('', null)).toEqual({ act: 'drop' })
  })

  // ── 接收链全路径：真设备钥签名 + fetch stub（名册归属闸）──
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i + 7) % 256)
  const devPub = ed.getPublicKey(seed)
  // canonical 设备 did（2026-10-10 canonical-only：legacy 裸 base58 已废止，
  // fromDevice 只认 canonical —— 与 pubkeyB64FromDid / accountDidEq 同一口径）
  const DEV_DID = didFromPubkey(devPub, 'myco')
  const b64Of = (u8: Uint8Array) => btoa(String.fromCharCode(...Array.from(u8)))
  const DEV_PUB_B64 = b64Of(devPub)

  afterEach(() => { vi.unstubAllGlobals() })

  /** 名册 stub：/root/{from} → devices（默认含本测试设备）。 */
  const stubRoster = (devices: { pubkeyB64: string; revoked: number }[] = [{ pubkeyB64: DEV_PUB_B64, revoked: 0 }]) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { devices } }) })))
  }

  /** 造一条已签名握手（payload.sig 材料字段序红线）。 */
  const H = (kind: string, over: Partial<ServerMsg> = {}): ServerMsg => {
    const ts = Date.now()
    const nonce = `nonce-${kind}`
    const material = friendSignMaterial(kind, PEER, MY, DEV_DID, ts, nonce)
    const payload: Record<string, unknown> = {
      to: MY, nonce, sig: b64Of(ed.sign(new TextEncoder().encode(material), seed)), name: '好友B',
    }
    return { seq: 1, id: `hs-${kind}`, from: PEER, fromName: '好友B', fromDevice: DEV_DID, kind, payload, ts, ...over }
  }

  it('合法 request → 落 in-pending 行 + true；重发幂等（keep 不翻状态）', async () => {
    stubRoster()
    const m = H('friend-request')
    expect(await ingestFriendHandshake(MY, m)).toBe(true)
    const fs = listFriends()
    expect(fs).toHaveLength(1)
    expect(fs[0]).toMatchObject({ did: PEER, status: 'in-pending', name: '好友B' })
    expect(await ingestFriendHandshake(MY, m)).toBe(false)
    expect(listFriends()[0].status).toBe('in-pending')
  })

  it('三件套反例：坏 sig / 过期 ts / 错投 to / 名册外设备 → 全拒零落行', async () => {
    stubRoster()
    const bad = H('friend-request')
    bad.payload = { ...bad.payload, sig: b64Of(new Uint8Array(64).fill(1)) }
    expect(await ingestFriendHandshake(MY, bad)).toBe(false)
    const stale = H('friend-request', { ts: Date.now() - 8 * 24 * 3600_000 })
    expect(await ingestFriendHandshake(MY, stale)).toBe(false)
    const misroute = H('friend-request')
    misroute.payload = { ...misroute.payload, to: 'did:youling:SomeoneElse' }
    expect(await ingestFriendHandshake(MY, misroute)).toBe(false)
    // 名册外设备（换把钥匙冒充）：归属闸 fail-closed
    const ghostSeed = Uint8Array.from({ length: 32 }, (_, i) => (i + 99) % 256)
    const ghostDid = didFromPubkey(ed.getPublicKey(ghostSeed), 'myco')
    const ts = Date.now()
    const material = friendSignMaterial('friend-request', PEER, MY, ghostDid, ts, 'n')
    const forged = H('friend-request', { fromDevice: ghostDid, ts, payload: { to: MY, nonce: 'n', sig: b64Of(ed.sign(new TextEncoder().encode(material), ghostSeed)), name: '冒充' } })
    expect(await ingestFriendHandshake(MY, forged)).toBe(false)
    expect(listFriends()).toHaveLength(0)
  })

  // 2026-10-07 广度测试补：ts 窗是对称绝对值——未来件（时钟偏差/重放企图）同样拒；
  // kind 词表严格大小写敏感（'Friend-Request' 落 default 分支 drop，不串合法路径）。
  it('边界补：未来 ts 超 7 天窗 → 拒；kind 大小写不敏感的变体 → drop', async () => {
    stubRoster()
    // 签名材料用未来 ts 本身（材料一致验签会过——被拒的只能是 ts 窗）
    const fts = Date.now() + 8 * 24 * 3600_000
    const m = H('friend-request', { ts: fts })
    const material = friendSignMaterial('friend-request', PEER, MY, DEV_DID, fts, 'nonce-friend-request')
    m.payload = { ...m.payload, sig: b64Of(ed.sign(new TextEncoder().encode(material), seed)) }
    expect(await ingestFriendHandshake(MY, m)).toBe(false)
    // 窗内近未来（1h）不拒——NTP 漂移容差
    const near = Date.now() + 3600_000
    const m2 = H('friend-request', { ts: near })
    const material2 = friendSignMaterial('friend-request', PEER, MY, DEV_DID, near, 'nonce-friend-request')
    m2.payload = { ...m2.payload, sig: b64Of(ed.sign(new TextEncoder().encode(material2), seed)) }
    expect(await ingestFriendHandshake(MY, m2)).toBe(true)
    // 大小写变体不落状态机合法分支
    expect(friendIngest('Friend-Request', null)).toEqual({ act: 'drop' })
    expect(friendIngest(' friend-request', null)).toEqual({ act: 'drop' })
  })

  it('accept 转正：out-pending → ok + 你们已成为好友系统条', async () => {
    stubRoster()
    upsertFriend(PEER, '好友B', 'out-pending')
    expect(await ingestFriendHandshake(MY, H('friend-accept'))).toBe(true)
    expect(listFriends()[0].status).toBe('ok')
    const conv = loadConv(PEER)
    expect(conv).toHaveLength(1)
    expect(conv[0].msgId).toBe(`sys-friend-ok-${PEER}`)
    expect(conv[0].payload.text).toBe('你们已成为好友，开始聊天吧')
    // ok 态重收 = keep（false）且系统条不重复
    expect(await ingestFriendHandshake(MY, H('friend-accept'))).toBe(false)
    expect(loadConv(PEER)).toHaveLength(1)
  })

  it('互加竞态：out-pending 期间收到 request → 直接 ok + 凭据条（对端回执异步吞错）', async () => {
    stubRoster()
    upsertFriend(PEER, '好友B', 'out-pending')
    expect(await ingestFriendHandshake(MY, H('friend-request'))).toBe(true)
    expect(listFriends()[0].status).toBe('ok')
    expect(loadConv(PEER)).toHaveLength(1)
  })

  it('remove：清行+清会话；无行重投幂等成功', async () => {
    stubRoster()
    upsertFriend(PEER, '好友B', 'ok')
    appendMsg(PEER, { msgId: 't-1', from: PEER, to: MY, kind: 'text', payload: { text: 'hi' }, ts: Date.now(), dir: 'in' })
    expect(loadConv(PEER)).toHaveLength(1)
    expect(await ingestFriendHandshake(MY, H('friend-remove'))).toBe(true)
    expect(listFriends()).toHaveLength(0)
    expect(loadConv(PEER)).toHaveLength(0)
    expect(await ingestFriendHandshake(MY, H('friend-remove'))).toBe(true)
  })

  it('accept 无行（从未发过请求）→ drop 零副作用', async () => {
    stubRoster()
    expect(await ingestFriendHandshake(MY, H('friend-accept'))).toBe(false)
    expect(listFriends()).toHaveLength(0)
  })
})

describe('2026-09-29 Bug1：渲染序（column-reverse 容器约定，最新贴底）', () => {
  it('存储正序追加（旧→新）→ renderOrderMsgs 倒序（DOM 新→旧）→ 视觉旧→新、最新贴底部输入框', () => {
    // 三条不同时间戳消息依次入库（发送=appendOut、接收=ingest 都是 push 追加）
    for (let i = 1; i <= 3; i++) {
      appendMsg(PEER, { msgId: `order-m${i}`, from: i === 2 ? MY : PEER, to: i === 2 ? PEER : MY, kind: 'text', payload: { text: `t${i}` }, ts: 1000 * i, dir: i === 2 ? 'out' : 'in' })
    }
    const stored = loadConv(PEER)
    // 存储层正序（旧→新，ts 升序）——排序键=入库时间序（ts）
    expect(stored.map((m) => m.payload.text)).toEqual(['t1', 't2', 't3'])
    // 渲染层：DOM 序=时间倒序（ChatScreen 的滚动容器 .chat-scroll 是 column-reverse，
    // DOM 首个孩子渲染在视觉底部）→ 视觉自上而下 t1 t2 t3，最新 t3 贴在输入框上方
    const dom = renderOrderMsgs(stored)
    expect(dom.map((m) => m.payload.text)).toEqual(['t3', 't2', 't1'])
  })

  it('不改动原数组（渲染倒序不能污染存储序）', () => {
    appendMsg(PEER, { msgId: 'ro-a', from: PEER, to: MY, kind: 'text', payload: { text: 'a' }, ts: 1, dir: 'in' })
    appendMsg(PEER, { msgId: 'ro-b', from: MY, to: PEER, kind: 'text', payload: { text: 'b' }, ts: 2, dir: 'out' })
    const stored = loadConv(PEER)
    renderOrderMsgs(stored)
    expect(stored.map((m) => m.payload.text)).toEqual(['a', 'b'])
  })
})

describe('第94轮：任意文件（kind=file）', () => {
  it('fmtFileSize 大小格式化（文件卡显示口径）', () => {
    expect(fmtFileSize(0)).toBe('')
    expect(fmtFileSize(undefined)).toBe('')
    expect(fmtFileSize(512)).toBe('512 B')
    expect(fmtFileSize(2048)).toBe('2.0 KB')
    expect(fmtFileSize(150 * 1024)).toBe('150 KB')
    expect(fmtFileSize(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(fmtFileSize(50 * 1024 * 1024)).toBe('50 MB')
  })

  it('超限拦截：>10MB 抛错（前端提示"文件过大"）', () => {
    expect(() => assertFileSize(FILE_MAX_BYTES)).not.toThrow()
    expect(() => assertFileSize(FILE_MAX_BYTES + 1)).toThrow('文件过大（>10MB），暂不支持')
    // b64 上限与二进制上限同档（10MB → ~13.4M b64 字符，14M 留裕量）
    expect(FILE_B64_MAX).toBeGreaterThanOrEqual(Math.ceil(FILE_MAX_BYTES / 3) * 4)
  })

  it('单聊 file 入库：kind=file + size + mediaId（字节走文件媒体库）', async () => {
    expect(ingestMsg(MY, S({ id: 'f-1', kind: 'file', payload: { name: '报告.pdf', mime: 'application/pdf', size: 204800, b64: 'QUJD' } }))).toBe(true)
    const conv = loadConv(PEER)
    expect(conv).toHaveLength(1)
    expect(conv[0].kind).toBe('file')
    expect(conv[0].payload).toMatchObject({ name: '报告.pdf', mime: 'application/pdf', size: 204800, mediaId: 'f-1' })
    expect(convPreview(conv[0])).toBe('[文件] 报告.pdf')
    // 字节进文件媒体库（测试环境无 indexedDB → 内存退路）
    await expect(loadFileB64('f-1')).resolves.toBe('QUJD')
  })

  it('群 file 入库（group-msg + file 嵌套）→ kind=file 落群会话；旧版本降级文案不崩', async () => {
    ingestMsg(MY, S({ kind: 'group-create', payload: { groupId: 'grp-f', groupName: '文件群', members: [MY, PEER] } }))
    expect(ingestMsg(MY, S({ id: 'gf-1', kind: 'group-msg', payload: {
      groupId: 'grp-f', groupName: '文件群', fromName: '好友B', members: [MY, PEER],
      text: '[文件] 合同.docx', // 旧版本降级文案（新版本忽略）
      file: { name: '合同.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 5242880, b64: 'REVG' },
    } }))).toBe(true)
    const conv = loadConv('grp-f')
    // 批二：group-create 也落群会话（对账载体）→ 2 条（同 ts 按 msgId 排，按 kind 找）
    expect(conv).toHaveLength(2)
    const fileMsg = conv.find((m) => m.kind === 'file')!
    expect(fileMsg.payload).toMatchObject({ name: '合同.docx', size: 5242880, mediaId: 'gf-1' })
    await expect(loadFileB64('gf-1')).resolves.toBe('REVG')
    // 同 msgId 幂等（直推+对账双份）
    expect(ingestMsg(MY, S({ id: 'gf-1', kind: 'group-msg', payload: { groupId: 'grp-f', members: [MY, PEER], file: { name: '合同.docx', b64: 'REVG' } } }))).toBe(true)
    expect(loadConv('grp-f')).toHaveLength(2)
  })

  it('群 file 对账副本（kind=file + payload.groupId）归位群会话，不落单聊', () => {
    ingestMsg(MY, S({ kind: 'group-create', payload: { groupId: 'grp-r', groupName: '回流群', members: [MY, PEER] } }))
    expect(ingestMsg(MY, S({ id: 'rf-1', kind: 'file', payload: { groupId: 'grp-r', groupName: '回流群', name: 'x.zip', mime: 'application/zip', size: 1024, b64: 'Wkla' } }))).toBe(true)
    // 批二：group-create 落群会话（对账载体）+ file 副本 = 2 条
    expect(loadConv('grp-r')).toHaveLength(2)
    expect(loadConv(PEER).length).toBe(0) // 不落单聊会话
  })

  it('wirePackMsgAsync：file 媒体补 b64 上 wire（对账可拉走文件字节）', async () => {
    await fileMediaPut('wf-1', 'QUJD')
    appendMsg(PEER, { msgId: 'wf-1', from: PEER, to: MY, kind: 'file', payload: { name: 'a.pdf', mime: 'application/pdf', size: 3, mediaId: 'wf-1' }, ts: 1, dir: 'in' } as ChatMsg)
    const w = await wirePackMsgAsync(loadConv(PEER)[0])
    expect((w.payload as Record<string, unknown>).b64).toBe('QUJD')
    expect((w.payload as Record<string, unknown>).mediaId).toBeUndefined()
    expect(w.dir).toBeUndefined()
  })

  it('文件媒体 FIFO 与图片同队淘汰（MEDIA_MAX 共享索引）', async () => {
    for (let i = 0; i < 30; i++) await fileMediaPut(`fm-${i}`, 'X')
    await expect(loadFileB64('fm-0')).resolves.toBeNull() // 最老被淘汰
    await expect(loadFileB64('fm-29')).resolves.toBe('X')
  })
})

// ══════════════ 第95轮：合并排序 + 发送状态（离线队列配套） ══════════════

describe('第95轮：sortConvMsgs 合并排序三态', () => {
  const m = (msgId: string, ts: number, dir: 'in' | 'out' = 'in'): ChatMsg =>
    ({ msgId, from: PEER, to: MY, kind: 'text', payload: { text: msgId }, ts, dir })

  it('纯历史：对账灌入的旧消息物理在尾部 → 按 ts 归位（时间序单调）', () => {
    const out = sortConvMsgs([m('new-phys-tail', 100), m('old-1', 10), m('old-2', 20)])
    expect(out.map((x) => x.msgId)).toEqual(['old-1', 'old-2', 'new-phys-tail'])
  })

  it('混合：本地 [a(10),b(20)] + 对账 [c(15),d(5)] → d,a,c,b（历史插到正确位置）', () => {
    const out = sortConvMsgs([m('a', 10), m('b', 20), m('c', 15), m('d', 5)])
    expect(out.map((x) => x.msgId)).toEqual(['d', 'a', 'c', 'b'])
  })

  it('本地新消息位置稳定：同步进行中发的消息（ts=now）合并前后恒在历史之后', () => {
    // 第一轮：本地 [h1(10)] + 用户新发 mine(100)
    expect(sortConvMsgs([m('h1', 10), m('mine', 100, 'out')]).map((x) => x.msgId)).toEqual(['h1', 'mine'])
    // 对账灌入更多历史 h0(5)/h2(50)（物理尾）→ 重排 mine 仍末尾（不被冲掉不跳变）
    const v2 = sortConvMsgs([m('h1', 10), m('mine', 100, 'out'), m('h2', 50), m('h0', 5)])
    expect(v2.map((x) => x.msgId)).toEqual(['h0', 'h1', 'h2', 'mine'])
    // 对方实时新消息（ts 更大）按时间戳并入 mine 之后（时间序语义正确）
    const v3 = sortConvMsgs([m('h1', 10), m('mine', 100, 'out'), m('peer-live', 120)])
    expect(v3.map((x) => x.msgId)).toEqual(['h1', 'mine', 'peer-live'])
  })

  it('同 msgId 去重（首见保留）；同 ts 按 msgId 字典序（双端确定一致）', () => {
    const out = sortConvMsgs([m('dup', 10), m('other', 20), m('dup', 30)])
    expect(out.map((x) => x.msgId)).toEqual(['dup', 'other'])
    const tie = sortConvMsgs([m('mb', 10), m('ma', 10), m('mc', 10)])
    expect(tie.map((x) => x.msgId)).toEqual(['ma', 'mb', 'mc'])
  })

  it('loadConv 返回已排序（存储物理乱序→渲染前权威序）', () => {
    appendMsg(PEER, m('z-new', 100))
    appendMsg(PEER, m('a-old', 10)) // 对账灌入的旧消息（物理尾）
    const conv = loadConv(PEER)
    expect(conv.map((x) => x.msgId)).toEqual(['a-old', 'z-new'])
  })
})

describe('第95轮：sendState 发送状态', () => {
  const m = (msgId: string, ts: number, sendState?: ChatMsg['sendState']): ChatMsg =>
    ({ msgId, from: MY, to: PEER, kind: 'text', payload: { text: msgId }, ts, dir: 'out', sendState })

  it('updateSendState 回写 + loadConv 带出（徽标数据源）', () => {
    appendMsg(PEER, m('m1', 1, 'sending'))
    expect(loadConv(PEER)[0].sendState).toBe('sending')
    expect(updateSendState(PEER, 'm1', 'sent')).toBe(true)
    expect(loadConv(PEER)[0].sendState).toBe('sent')
    // 不存在返回 false（不炸）
    expect(updateSendState(PEER, 'nope', 'sent')).toBe(false)
  })

  it('wirePackMsg/wirePackMsgAsync 剥离 sendState（端侧状态不上 wire）', async () => {
    const w = wirePackMsg(m('m1', 1, 'sending'))
    expect(w.sendState).toBeUndefined()
    expect(w.dir).toBeUndefined()
    const wa = await wirePackMsgAsync(m('m2', 2, 'failed'))
    expect(wa.sendState).toBeUndefined()
  })

  it('retrySend 在队路径：复位 pending → 补发（离线 mock deliver 全不可达 → failed）', async () => {
    // 直接在 outbox 注入一条（模拟发送时 deliver 失败已入队）
    const ob = await import('./outbox')
    ob._setOutboxStoreForTest(ob.memOutboxStore())
    appendMsg(PEER, m('m-q', 1, 'sending'))
    await ob.enqueueOutbox(PEER, [PEER], { msgId: 'm-q', from: MY, to: PEER, kind: 'text', payload: { text: 'x' }, ts: 1 })
    await ob.markOutboxFailed('m-q', '对方长期不在线，消息未送达')
    // 测试环境无身份（identity null）→ p2pDeliver 全不可达 → 复位后仍 failed + 回写消息行
    const state = await retrySend(PEER, 'm-q')
    expect(state).toBe('failed')
    expect(loadConv(PEER)[0].sendState).toBe('failed')
    // 条目复位后又被标 failed（等下次手动/上线）
    expect((await ob.getOutboxItem('m-q'))?.status).toBe('failed')
  })

  it('retrySend 不在队路径：从消息行重建信封入队（pending——自动补发接管）', async () => {
    const ob = await import('./outbox')
    ob._setOutboxStoreForTest(ob.memOutboxStore())
    appendMsg(PEER, m('m-r', 1, 'failed')) // 溢出失败态（从未入队）
    const state = await retrySend(PEER, 'm-r')
    expect(state).toBe('sending') // 不可达 → 重新入队 pending
    expect(loadConv(PEER)[0].sendState).toBe('sending')
    const item = await ob.getOutboxItem('m-r')
    expect(item?.status).toBe('pending')
    expect(item?.targets).toEqual([PEER])
    expect(item?.envelope.msgId).toBe('m-r') // 原 msgId 幂等重建
  })
})


// ══════════════ 批四：撤回（recall）/ 草稿 / 会话偏好 / 未读 / 排序 / 时间分隔 / 长按菜单 ══════════════

describe('批四：撤回 ingest（recall 控制消息，词表与 PC 批三对齐）', () => {
  it('收到对方 recall → 目标消息删行 + 落"对方撤回了一条消息"系统条', () => {
    ingestMsg(MY, S({ id: 'rc-1', kind: 'text', payload: { text: '说错的话' }, ts: 1000 }))
    expect(loadConv(PEER)).toHaveLength(1)
    expect(ingestMsg(MY, S({ kind: 'recall', payload: { target: 'rc-1' }, ts: 2000 }))).toBe(true)
    const conv = loadConv(PEER)
    expect(conv).toHaveLength(1)
    expect(conv[0].kind).toBe('sys')
    expect(conv[0].payload.text).toBe('对方撤回了一条消息')
  })

  it('墓碑语义：撤回只删显示行，convmeta.ids 保留该 msgId——对账 diff 不会把对端副本再拉回来（撤回复活）', () => {
    ingestMsg(MY, S({ id: 'rc-2', kind: 'text', payload: { text: 'x' }, ts: 1000 }))
    ingestMsg(MY, S({ kind: 'recall', payload: { target: 'rc-2' }, ts: 2000 }))
    const meta = loadConvMeta(PEER)
    expect(meta.ids.some(([id]) => id === 'rc-2')).toBe(true) // 墓碑保留
    expect(loadConv(PEER).some((m) => m.msgId === 'rc-2')).toBe(false) // 显示行已删
    // 对账把同一 msgId 再推一次 → appendMsg 幂等丢弃，行不复活
    expect(appendMsg(PEER, { msgId: 'rc-2', from: PEER, to: MY, kind: 'text', payload: { text: 'x' }, ts: 1000, dir: 'in' })).toBe(false)
    expect(loadConv(PEER).some((m) => m.msgId === 'rc-2')).toBe(false)
  })

  it('群撤回（payload.groupId）归位群会话 + 系统条带操作者名', () => {
    ingestMsg(MY, S({ kind: 'group-create', payload: { groupId: 'grp-rc', groupName: '撤回群', members: [MY, PEER] } }))
    ingestMsg(MY, S({ id: 'grc-1', kind: 'group-msg', payload: { groupId: 'grp-rc', groupName: '撤回群', members: [MY, PEER], fromName: '好友B', text: '群消息' }, ts: 1000 }))
    // 批二：group-create 落群会话参与对账——conv 里含建群卡+群消息两行
    expect(loadConv('grp-rc').filter((m) => m.kind !== 'group-create')).toHaveLength(1)
    ingestMsg(MY, S({ kind: 'recall', fromName: '好友B', payload: { target: 'grc-1', groupId: 'grp-rc' }, ts: 2000 }))
    const conv = loadConv('grp-rc')
    expect(conv.some((m) => m.msgId === 'grc-1')).toBe(false)
    // 撤回系统条按 msgId 定位（批二 group-create 落群会话带真实 ts，尾行不再是系统条）
    expect(conv.find((m) => m.msgId === 'sys-recall-grc-1')?.payload.text).toBe('好友B撤回了一条消息')
  })

  it('recall 缺 target → 丢弃（返回 false）', () => {
    expect(ingestMsg(MY, S({ kind: 'recall', payload: {} }))).toBe(false)
  })

  it('canRecall 判定：自己的内容类消息 + 2 分钟内 + 非乐观条', () => {
    const mine = (kind: string, ts: number, msgId = 'm-x'): ChatMsg => ({ msgId, from: MY, to: PEER, kind, payload: {}, ts, dir: 'out' })
    const now = 1_000_000
    expect(canRecall(mine('text', now - 60_000), now)).toBe(true)
    expect(canRecall(mine('image', now - RECALL_WINDOW_MS), now)).toBe(true)  // 恰在边界
    expect(canRecall(mine('text', now - RECALL_WINDOW_MS - 1), now)).toBe(false) // 超时
    expect(canRecall(mine('task-share', now - 1000), now)).toBe(false)          // 非内容类
    expect(canRecall({ ...mine('text', now - 1000), dir: 'in' as const }, now)).toBe(false) // 别人的消息
    expect(canRecall(mine('text', now - 1000, 'optimistic-1'), now)).toBe(false) // 乐观条
  })
})

describe('批四：长按菜单状态机（msgMenuActions）', () => {
  const now = 1_000_000
  const m = (kind: string, dir: 'in' | 'out', ts: number): ChatMsg => ({ msgId: 'mm-1', from: PEER, to: MY, kind, payload: { text: 't' }, ts, dir })

  it('文本消息（对方）→ 复制+引用+删除（无撤回——不是自己的）', () => {
    expect(msgMenuActions(m('text', 'in', now - 1000), now)).toEqual(['copy', 'reply', 'delete'])
  })
  it('自己的文本 2 分钟内 → 复制+引用+撤回+删除', () => {
    expect(msgMenuActions(m('text', 'out', now - 60_000), now)).toEqual(['copy', 'reply', 'recall', 'delete'])
  })
  it('自己的文本超时 → 无撤回', () => {
    expect(msgMenuActions(m('text', 'out', now - RECALL_WINDOW_MS - 1), now)).toEqual(['copy', 'reply', 'delete'])
  })
  it('图片消息 → 引用+删除（无复制——非文本）；自己的限时内可撤回', () => {
    expect(msgMenuActions(m('image', 'in', now - 1000), now)).toEqual(['reply', 'delete'])
    expect(msgMenuActions(m('image', 'out', now - 1000), now)).toEqual(['reply', 'recall', 'delete'])
  })
  it('sys/任务卡 → 仅删除', () => {
    expect(msgMenuActions(m('sys', 'in', now - 1000), now)).toEqual(['delete'])
    expect(msgMenuActions(m('task-share', 'in', now - 1000), now)).toEqual(['delete'])
  })
})

describe('批四：草稿保留（按 convId 持久化）', () => {
  it('写-读-清 全链路；会话间隔离', () => {
    setDraft(PEER, '没写完的话')
    setDraft('did:youling:CCC', '另一会话草稿')
    expect(getDraft(PEER)).toBe('没写完的话')
    expect(getDraft('did:youling:CCC')).toBe('另一会话草稿')
    setDraft(PEER, '') // 空串=删键（发送成功不残留）
    expect(getDraft(PEER)).toBe('')
    expect(getDraft('did:youling:CCC')).toBe('另一会话草稿') // 不影响别的会话
  })
})

describe('批四：会话偏好（置顶/免打扰）+ 会话单独删除', () => {
  it('setConvPinned/setConvMuted 往返；deleteConv 清消息+草稿+meta 但不动好友', () => {
    upsertFriend(PEER, '好友B', 'ok')
    appendMsg(PEER, { msgId: 'd1', from: PEER, to: MY, kind: 'text', payload: { text: 'hi' }, ts: 1, dir: 'in' })
    setDraft(PEER, '草稿')
    setConvPinned(PEER, true)
    setConvMuted(PEER, true)
    expect(convPref(PEER)).toMatchObject({ pinned: expect.any(Number), muted: true })
    setConvMuted(PEER, false)
    expect(convPref(PEER).muted).toBeUndefined()
    expect(convPref(PEER).pinned).toBeTruthy() // 置顶保留
    deleteConv(PEER)
    expect(loadConv(PEER)).toHaveLength(0)
    expect(getDraft(PEER)).toBe('')
    expect(loadConvMeta(PEER).ids).toHaveLength(0) // 会话删除是对账级重来（meta 同清）
    expect(listFriends()).toHaveLength(1) // 好友行不动
  })

  it('deleteMsgLocal 删单行；不存在返回 false', () => {
    appendMsg(PEER, { msgId: 'dm-1', from: PEER, to: MY, kind: 'text', payload: { text: 'a' }, ts: 1, dir: 'in' })
    appendMsg(PEER, { msgId: 'dm-2', from: PEER, to: MY, kind: 'text', payload: { text: 'b' }, ts: 2, dir: 'in' })
    expect(deleteMsgLocal(PEER, 'dm-1')).toBe(true)
    expect(loadConv(PEER).map((x) => x.msgId)).toEqual(['dm-2'])
    expect(deleteMsgLocal(PEER, 'dm-1')).toBe(false) // 已删
  })
})

describe('批四：未读计数（数字化；免打扰不进 App 总数）', () => {
  it('unreadCount 数 dir=in 且晚于 seen 的条数；免打扰不进 unreadTotal', () => {
    appendMsg(PEER, { msgId: 'u1', from: PEER, to: MY, kind: 'text', payload: { text: '1' }, ts: 1000, dir: 'in' })
    appendMsg(PEER, { msgId: 'u2', from: MY, to: PEER, kind: 'text', payload: { text: '我发的' }, ts: 1001, dir: 'out' })
    appendMsg(PEER, { msgId: 'u3', from: PEER, to: MY, kind: 'text', payload: { text: '2' }, ts: 1002, dir: 'in' })
    expect(unreadCount(PEER)).toBe(2) // out 不计
    expect(unreadTotal()).toBe(0) // PEER 还不是 ok 好友——不计
    upsertFriend(PEER, '好友B', 'ok')
    expect(unreadTotal()).toBe(2)
    setConvMuted(PEER, true) // 免打扰 → App 总数不计（微信语义）
    expect(unreadTotal()).toBe(0)
    expect(unreadCount(PEER)).toBe(2) // 会话自身计数不受影响（列表灰显）
  })
})

describe('批四：会话行排序（sortConvRows 置顶优先）', () => {
  it('置顶优先（先置顶的在前）+ 其余按 lastTs 倒序', () => {
    const rows = [
      { id: 'a', lastTs: 100 },
      { id: 'b', lastTs: 300, pinned: true, pinTs: 50 },
      { id: 'c', lastTs: 200 },
      { id: 'd', lastTs: 50, pinned: true, pinTs: 60 }, // 后置顶 → 排在 b 后
    ]
    expect(sortConvRows(rows).map((r) => r.id)).toEqual(['b', 'd', 'c', 'a'])
  })
  it('不改动原数组', () => {
    const rows = [{ id: 'a', lastTs: 1 }, { id: 'b', lastTs: 2 }]
    sortConvRows(rows)
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
  })
})

describe('批四：时间分隔（needTimeSep / fmtConvTime / isSameDay）', () => {
  it('首条恒显；≤5min 不显；>5min 断开显示', () => {
    expect(needTimeSep(null, 1000)).toBe(true)
    expect(needTimeSep(0, TIME_SEP_GAP_MS)).toBe(false) // 恰好 5min 不断开
    expect(needTimeSep(0, TIME_SEP_GAP_MS + 1)).toBe(true)
    expect(needTimeSep(undefined, 5000)).toBe(true)
  })
  it('isSameDay 本地日历日判定', () => {
    const d1 = new Date(2026, 8, 28, 23, 59).getTime()
    const d2 = new Date(2026, 8, 29, 0, 1).getTime()
    expect(isSameDay(d1, d1 + 1000)).toBe(true)
    expect(isSameDay(d1, d2)).toBe(false)
  })
  it('fmtConvTime 微信规则：今天=时分；昨天；本年=月日；跨年=年月日；withTime 补时分', () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 5).getTime()
    expect(fmtConvTime(today)).toBe('09:05')
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 21, 30).getTime()
    expect(fmtConvTime(yesterday)).toBe('昨天')
    expect(fmtConvTime(yesterday, true)).toBe('昨天 21:30')
    const sameYear = new Date(now.getFullYear(), Math.max(0, now.getMonth() - 2), 3, 8, 0).getTime()
    if (now.getMonth() >= 2) expect(fmtConvTime(sameYear)).toBe(`${new Date(sameYear).getMonth() + 1}月3日`)
    const prevYear = new Date(now.getFullYear() - 1, 5, 15, 8, 0).getTime()
    expect(fmtConvTime(prevYear)).toBe(`${now.getFullYear() - 1}/6/15`)
    expect(fmtConvTime(prevYear, true)).toContain(`${now.getFullYear() - 1}年6月15日`)
  })
})

describe('批四：引用回复 wire 补丁（replyPatch）', () => {
  it('replyTo=被引 msgId + 快照摘要（截 60）+ 对方名（自己的消息名留空）', () => {
    const quoted: ChatMsg = { msgId: 'q-1', from: PEER, to: MY, kind: 'text', payload: { text: '被引用的原文' }, ts: 1, dir: 'in', fromName: '好友B' }
    expect(replyPatch(quoted)).toEqual({ replyTo: 'q-1', replySnippet: '被引用的原文', replyFromName: '好友B' })
    const quotedMine: ChatMsg = { msgId: 'q-2', from: MY, to: PEER, kind: 'text', payload: { text: '我自己的话' }, ts: 1, dir: 'out' }
    expect(replyPatch(quotedMine)).toMatchObject({ replyTo: 'q-2', replySnippet: '我自己的话', replyFromName: '' })
    expect(replyPatch(null)).toEqual({})
    expect(replyPatch(undefined)).toEqual({})
  })
  it('引用图片/文件消息 → 摘要为 [图片]/[文件] 预览词（convPreview 口径）', () => {
    const img: ChatMsg = { msgId: 'q-3', from: PEER, to: MY, kind: 'image', payload: { name: 'p.png' }, ts: 1, dir: 'in', fromName: '好友B' }
    expect(replyPatch(img).replySnippet).toBe('[图片]')
  })
})

// ══════════════ 第96轮（修复1）：账号分桶键 ══════════════

describe('账号分桶键（youling.chat.<safeDid>.*）', () => {
  const withKeys = (m: ReturnType<typeof memStorage>): ChatStorage => ({ ...m, keys: () => [...m.dump.keys()] })

  it('旧全局键整体 move 进空账号桶（幂等）', () => {
    const m = memStorage()
    m.set('youling.chat.friends', '[]')
    m.set('youling.chat.conv.did_youling_BBB', '[1]')
    m.set('youling.chat.convmeta.did_youling_BBB', '{}')
    m.set('youling.chat.media.m1', 'b64')
    m.set('youling.chat.media.index', '[]')
    m.set('youling.chat.friendsMigrated86', '1')
    m.set('youling.other', 'x') // 无关键不动
    const moved = migrateLegacyChatKeys(withKeys(m), 'youling.chat.did_youling_AAA')
    expect(moved).toBe(6)
    expect(m.get('youling.chat.did_youling_AAA.friends')).toBe('[]')
    expect(m.get('youling.chat.did_youling_AAA.conv.did_youling_BBB')).toBe('[1]')
    expect(m.get('youling.chat.did_youling_AAA.convmeta.did_youling_BBB')).toBe('{}')
    expect(m.get('youling.chat.did_youling_AAA.media.m1')).toBe('b64')
    expect(m.get('youling.chat.did_youling_AAA.media.index')).toBe('[]')
    expect(m.get('youling.chat.did_youling_AAA.friendsMigrated86')).toBe('1')
    // 旧位置干净；无关键原样；再跑一次=0（幂等）
    expect(m.get('youling.chat.friends')).toBeNull()
    expect(m.get('youling.chat.conv.did_youling_BBB')).toBeNull()
    expect(m.get('youling.other')).toBe('x')
    expect(migrateLegacyChatKeys(withKeys(m), 'youling.chat.did_youling_AAA')).toBe(0)
  })

  it('桶非空 → 不迁移（不覆盖新数据）', () => {
    const m = memStorage()
    m.set('youling.chat.friends', '[old]')
    m.set('youling.chat.did_youling_AAA.friends', '[new]')
    expect(migrateLegacyChatKeys(withKeys(m), 'youling.chat.did_youling_AAA')).toBe(0)
    expect(m.get('youling.chat.friends')).toBe('[old]') // 旧负载原样留（人工处置）
  })

  it('读写落到当前账号桶（未登录测试环境=_guest）', () => {
    upsertFriend(PEER, '好友B', 'ok')
    expect(st.dump.has('youling.chat._guest.friends')).toBe(true)
    expect(st.dump.has('youling.chat.friends')).toBe(false)
    appendMsg(PEER, { msgId: 'm-bk', from: PEER, to: MY, kind: 'text', payload: { text: 'x' }, ts: 1, dir: 'in' })
    expect(st.dump.has('youling.chat._guest.conv.did_youling_BBB')).toBe(true)
    expect(st.dump.has('youling.chat._guest.convmeta.did_youling_BBB')).toBe(true)
  })
})

// ══════════════ 批五（2026-09-29 用户实测）：自己的任务卡进「我的任务」 ══════════════

describe('批五：分享者自己的任务卡（registerSharedTask + peerTaskView 创建者视角）', () => {
  const P = (over: Record<string, unknown> = {}) => ({
    taskId: 'peer-task-self-1', title: '我发的任务', from: MY, fromName: '我',
    createdAt: 100, participants: [{ did: MY, name: '我', role: 'owner' }], ...over,
  })

  it('registerSharedTask：自己的卡登记 status=shared，回执取标题语义保留', () => {
    const t = registerSharedTask(PEER, MY, '我', P())
    expect(t.status).toBe('shared')
    expect(t.from).toBe(MY)
    expect(t.title).toBe('我发的任务')
    expect(t.convId).toBe('did_youling_BBB') // didSafe
    expect(listTasks().some((x) => x.taskId === 'peer-task-self-1')).toBe(true)
  })

  it('2026-11-11：registerSharedTask 透传 env/caps/action（手机建「ADB 调试」环境卡的入库路径）', () => {
    const gid = 'grp-dev-adb1'
    const payload = {
      taskId: 'peer-task-adb-x1', title: 'ADB 调试',
      env: [{ kind: 'adb', device: 'did:myco:zPhoneDev', port: 5555, localPort: 15555 }],
      caps: ['vnet.forward'],
      action: { env: [{ kind: 'adb', device: 'did:myco:zPhoneDev', port: 5555, localPort: 15555 }] },
      createdAt: 1,
    }
    const t = registerSharedTask(gid, MY, '我', payload)
    expect(t.env).toEqual(payload.env)
    expect(t.caps).toEqual(payload.caps)
    expect(t.action?.env).toEqual(payload.action.env)
    // 无 env 的普通卡不受影响（字段缺省不落）
    const plain = registerSharedTask(gid, MY, '我', { taskId: 'peer-task-plain-x2', title: '普通卡', createdAt: 2 })
    expect(plain.env).toBeUndefined()
    expect(plain.caps).toBeUndefined()
  })

  it('registerSharedTask 幂等：同 taskId 再登记不重复（对账/多端回流安全）', () => {
    registerSharedTask(PEER, MY, '我', P())
    registerSharedTask(PEER, MY, '我', P({ title: '别的标题' }))
    expect(listTasks().filter((x) => x.taskId === 'peer-task-self-1')).toHaveLength(1)
    expect(listTasks()[0].title).toBe('我发的任务') // 先入为准
  })

  it('peerTaskView：自己的 shared（无人接）→ mine + 待接受', () => {
    const t = registerSharedTask(PEER, MY, '我', P())
    expect(peerTaskView(t, MY)).toEqual({ mine: true, statusKey: 'pending' })
  })

  it('peerTaskView：自己的卡有人接了（participants 出现非 owner did）→ 进行中', () => {
    const t = registerSharedTask(PEER, MY, '我', P({
      participants: [{ did: MY, name: '我', role: 'owner' }, { did: PEER, name: '好友B', role: 'member' }],
    }))
    expect(peerTaskView(t, MY)).toEqual({ mine: true, statusKey: 'doing' })
  })

  it('peerTaskView：同账号任务自动接受（from===my 且 status=todo，第89轮语义）→ mine + 进行中而非「待我做」', () => {
    const t = registerSharedTask(PEER, MY, '我', P({ taskId: 'peer-task-self-2' }))
    const asTodo = { ...t, status: 'todo' }
    expect(peerTaskView(asTodo, MY)).toEqual({ mine: true, statusKey: 'doing' })
  })

  it('peerTaskView：自己的卡 done → 已完成（视角标记仍是 mine）', () => {
    const t = registerSharedTask(PEER, MY, '我', P({ taskId: 'peer-task-self-3' }))
    expect(peerTaskView({ ...t, status: 'done' }, MY)).toEqual({ mine: true, statusKey: 'done' })
  })

  it('peerTaskView：好友发来的卡 → 非 mine，状态原样透传（接受者视角不变）', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: {
      taskId: 'peer-task-f1', title: '好友的卡', from: PEER, fromName: '好友B',
      participants: [{ did: PEER, name: '好友B', role: 'owner' }],
    } }))
    const t = listTasks().find((x) => x.taskId === 'peer-task-f1')!
    expect(peerTaskView(t, MY)).toEqual({ mine: false, statusKey: 'pending' })
    expect(peerTaskView({ ...t, status: 'todo' }, MY)).toEqual({ mine: false, statusKey: 'todo' })
  })

  it('peerTaskView：my 为 null（未关联账号）保守按非 mine', () => {
    const t = registerSharedTask(PEER, MY, '我', P({ taskId: 'peer-task-self-4' }))
    expect(peerTaskView(t, null).mine).toBe(false)
  })
})

// ═══ 2026-10-11 任务卡改名（task-rename）——设计稿 §5 验收清单同口径 ═══
// wire：kind='task-rename'，payload={taskId,title(≤64字),ts}；签名随行（p2pSendRaw 底座）。
// 老端不认识 → ingestMsg default 丢弃（不崩不入库，既有「未知 kind 丢弃」锁定）。
describe('任务卡改名（task-rename）', () => {
  // 验收①：owner 改名 → 本地 title 更新 + wire 形状断言（payload 字段）
  it('owner 改名本地核：title/titleTs 更新 + wire payload 恰三键 + 单聊 sendTo 还原 canonical did', () => {
    const PEER_C = didFromPubkey(new Uint8Array(32).fill(7), 'youling')
    registerSharedTask(PEER_C, MY, '我', { taskId: 'peer-task-rn1', title: '旧名', from: MY, participants: [{ did: MY, name: '我', role: 'owner' }] })
    const r = taskRenameApply(MY, 'peer-task-rn1', '  新名  ', 5000)
    expect(r.payload).toEqual({ taskId: 'peer-task-rn1', title: '新名', ts: 5000 }) // trim 后、恰三键
    expect(r.convId).toBe(PEER_C.replace(/[:/]/g, '_'))
    expect(r.sendTo).toBe(PEER_C) // did_safe 形态 convId 还原回原始对端 did
    const t = listTasks().find((x) => x.taskId === 'peer-task-rn1')!
    expect(t.title).toBe('新名')
    expect(t.titleTs).toBe(5000)
  })

  it('群任务：payload 带 groupId/members 扇出锚，sendTo=群 id', () => {
    upsertGroup('grp-rn', '改名群', [MY, PEER], MY)
    registerSharedTask('grp-rn', MY, '我', { taskId: 'peer-task-rn3', title: '群卡', from: MY })
    const r = taskRenameApply(MY, 'peer-task-rn3', '群卡新名', 6000)
    expect(r.sendTo).toBe('grp-rn')
    expect(r.convId).toBe('grp-rn')
    expect(r.payload).toMatchObject({ taskId: 'peer-task-rn3', title: '群卡新名', ts: 6000, groupId: 'grp-rn', members: [MY, PEER] })
  })

  // 验收②：参与者收到 owner 的 task-rename → 本地 title 更新 + 会话落留痕行
  it('参与者收到 owner 的 task-rename → title 更新 + 落系统条行', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-rn4', title: '旧名', from: PEER, createdAt: 1 } }))
    expect(ingestMsg(MY, S({ id: 'trn-4', kind: 'task-rename', payload: { taskId: 'peer-task-rn4', title: '新名', ts: 2000 }, ts: 2000 }))).toBe(true)
    const t = listTasks().find((x) => x.taskId === 'peer-task-rn4')!
    expect(t.title).toBe('新名')
    expect(t.titleTs).toBe(2000)
    const rows = loadConv(PEER).filter((m) => m.kind === 'task-rename')
    expect(rows).toHaveLength(1)
    expect(rows[0].dir).toBe('in')
    expect(rows[0].payload).toMatchObject({ taskId: 'peer-task-rn4', title: '新名', ts: 2000 })
    expect(convPreview(rows[0])).toBe('✏️ 任务卡改名为「新名」')
  })

  // 验收③：非 owner 发的 rename → 拒收（安全闸，伪造无效）
  it('安全闸：非 owner 的 rename 拒收——title 不变、不落行', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-rn5', title: '旧名', from: PEER, createdAt: 1 } }))
    const THIRD = 'did:youling:CCC'
    // 旁观者伪造
    expect(ingestMsg(MY, S({ from: THIRD, kind: 'task-rename', payload: { taskId: 'peer-task-rn5', title: '伪造', ts: 3000 } }))).toBe(false)
    // 我自己也不是 owner（参与者设备上 from==my 的伪 rename 同样拒）
    expect(ingestMsg(MY, S({ from: MY, to: PEER, kind: 'task-rename', payload: { taskId: 'peer-task-rn5', title: '自导', ts: 3001 } }))).toBe(false)
    expect(listTasks().find((x) => x.taskId === 'peer-task-rn5')!.title).toBe('旧名')
    expect(loadConv(PEER).every((m) => m.kind !== 'task-rename')).toBe(true)
  })

  // 验收④：老端安全忽略——未知 kind 不崩、不入库、不碰任务库（default 分支既有语义）
  it('陌生 kind/未知任务：不崩不入库（老端收到 task-rename 即走此路径）', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-rn6', title: '旧名', from: PEER } }))
    // 老端视角：task-rename 是未知 kind → default 丢弃；这里锁"未知 kind 不碰任务库"
    expect(ingestMsg(MY, S({ kind: 'future-kind-9', payload: { taskId: 'peer-task-rn6', title: 'X' } }))).toBe(false)
    expect(listTasks().find((x) => x.taskId === 'peer-task-rn6')!.title).toBe('旧名')
    // 新端但本地无此卡 → 丢弃不落行（不落 meta，对账会再带——卡到齐即收敛）
    expect(ingestMsg(MY, S({ kind: 'task-rename', payload: { taskId: 'peer-task-ghost', title: 'X', ts: 1 } }))).toBe(false)
    expect(loadConv(PEER).every((m) => m.kind !== 'task-rename')).toBe(true)
  })

  // 验收⑤：幂等（重复投递只生效一次）+ ts 冲突（大者覆盖、小者丢弃）
  it('幂等 + ts 冲突：同 msgId 双份只落一行；ts 大者生效', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-rn7', title: '旧名', from: PEER } }))
    const wire = S({ id: 'trn-7', kind: 'task-rename', payload: { taskId: 'peer-task-rn7', title: '名A', ts: 2000 }, ts: 2000 })
    expect(ingestMsg(MY, wire)).toBe(true)
    expect(ingestMsg(MY, wire)).toBe(true) // 直推+对账双份
    expect(loadConv(PEER).filter((m) => m.kind === 'task-rename')).toHaveLength(1)
    // ts 小的迟到 → 不覆盖
    expect(ingestMsg(MY, S({ id: 'trn-7b', kind: 'task-rename', payload: { taskId: 'peer-task-rn7', title: '旧值回潮', ts: 1500 }, ts: 1500 }))).toBe(true)
    expect(listTasks().find((x) => x.taskId === 'peer-task-rn7')!.title).toBe('名A')
    // ts 大的后到 → 覆盖
    expect(ingestMsg(MY, S({ id: 'trn-7c', kind: 'task-rename', payload: { taskId: 'peer-task-rn7', title: '名B', ts: 2500 }, ts: 2500 }))).toBe(true)
    const t = listTasks().find((x) => x.taskId === 'peer-task-rn7')!
    expect(t.title).toBe('名B')
    expect(t.titleTs).toBe(2500)
  })

  // 验收⑥：超 64 字截断（接收侧防御——不信任 wire 长度）
  it('超 64 字截断（接收侧）', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-rn8', title: '旧名', from: PEER } }))
    expect(ingestMsg(MY, S({ kind: 'task-rename', payload: { taskId: 'peer-task-rn8', title: '字'.repeat(70), ts: 2000 } }))).toBe(true)
    expect(listTasks().find((x) => x.taskId === 'peer-task-rn8')!.title).toHaveLength(64)
  })

  // owner 多端：自同步回流（from==my 的 out 副本经对账拉回）→ 应用 + 归位 dir=out
  it('自同步回流：from==my 的 rename 归位到与对方的会话且 dir=out', () => {
    registerSharedTask(PEER, MY, '我', { taskId: 'peer-task-rn9', title: '旧名', from: MY })
    expect(ingestMsg(MY, S({ id: 'trn-9', from: MY, to: PEER, kind: 'task-rename', payload: { taskId: 'peer-task-rn9', title: '多端名', ts: 5000 }, ts: 5000 }))).toBe(true)
    expect(listTasks().find((x) => x.taskId === 'peer-task-rn9')!.title).toBe('多端名')
    const rows = loadConv(PEER).filter((m) => m.kind === 'task-rename')
    expect(rows).toHaveLength(1)
    expect(rows[0].dir).toBe('out')
  })

  // owner 多端：设备群载体行（payload.groupId=grp-dev-*）→ 落设备群会话 + title 应用
  it('设备群载体行：落设备群会话 + title 应用（渲染层过滤在 FriendsPanel）', () => {
    registerSharedTask(PEER, MY, '我', { taskId: 'peer-task-rn10', title: '旧名', from: MY })
    const dgid = deviceGroupId(MY)
    expect(ingestMsg(MY, S({ id: 'trn-10', from: MY, to: dgid, kind: 'task-rename', payload: { taskId: 'peer-task-rn10', title: '载体名', ts: 6000, groupId: dgid }, ts: 6000 }))).toBe(true)
    expect(listTasks().find((x) => x.taskId === 'peer-task-rn10')!.title).toBe('载体名')
    expect(loadConv(dgid).some((m) => m.kind === 'task-rename')).toBe(true)
  })

  // owner 闸（发送侧强制校验）：非 owner/未知任务/空标题全拒；发送侧也截断 64
  it('owner 闸（发送侧）：非 owner/未知任务/空标题全拒 + 发送侧截断', () => {
    ingestMsg(MY, S({ kind: 'task-share', payload: { taskId: 'peer-task-rn11', title: '别人的卡', from: PEER } }))
    expect(() => taskRenameApply(MY, 'peer-task-rn11', '越权')).toThrow('只有任务发起人可以改名')
    expect(() => taskRenameApply(MY, 'peer-task-ghost', 'x')).toThrow('任务不存在')
    registerSharedTask(PEER, MY, '我', { taskId: 'peer-task-rn12', title: '我的卡', from: MY })
    expect(() => taskRenameApply(MY, 'peer-task-rn12', '   ')).toThrow('任务标题不能为空')
    const r = taskRenameApply(MY, 'peer-task-rn12', '长'.repeat(70), 7000)
    expect((r.payload.title as string)).toHaveLength(64)
  })
})

// ═══ agent 分身态账号分桶（2026-10-07 三端互测矩阵 m4 实锤修复）═══
// 事故：accPrefix 此前只看 getRootIdentity()（vault 根钥）——分身态（仅 attestation）
// 为 null → 全部 chat 落 _guest 桶，与 myAccountDid() 回退语义及 PC chat_dir()
// （agent 态=账号桶）都不一致。修后统一走 myAccountDid()。
describe('agent 分身态账号分桶（m4 矩阵回归）', () => {
  const ROOT = 'did:youling:zAgentRootDid6Mk'
  const attest = { rootDid: ROOT, devicePubkeyB64: 'cHVi', issuedAt: 1, attestSigB64: 'c2ln' }
  const stubLs = (entries: Record<string, string>) => {
    const m = new Map(Object.entries(entries))
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v) },
      removeItem: (k: string) => { m.delete(k) },
    })
    return m
  }

  afterEach(() => vi.unstubAllGlobals())

  it('仅 attestation（无根钥 vault）→ ingest 落账号桶而非 _guest', () => {
    stubLs({ 'youling.attestation': JSON.stringify(attest) })
    expect(ingestMsg(ROOT, S())).toBe(true)
    const keys = [...st.dump.keys()]
    expect(keys.some((k) => k.startsWith(`youling.chat.${ROOT.replace(/[:/]/g, '_')}.conv.`))).toBe(true)
    expect(keys.some((k) => k.startsWith('youling.chat._guest.conv.'))).toBe(false)
  })

  it('无 attestation 也无根钥（未关联）→ 仍 _guest 桶（原语义不变）', () => {
    stubLs({})
    expect(ingestMsg(MY, S())).toBe(true)
    const keys = [...st.dump.keys()]
    expect(keys.some((k) => k.startsWith('youling.chat._guest.conv.'))).toBe(true)
  })

  it('有根钥（embodiment）→ 根 did 桶（回归锚：不因修复偏移）', () => {
    stubLs({
      'youling.vault': JSON.stringify({ mode: 'plain', keyB64: 'a2V5', rootSeedB64: 'c2VlZA==', rootDid: ROOT }),
    })
    expect(ingestMsg(ROOT, S())).toBe(true)
    const keys = [...st.dump.keys()]
    expect(keys.some((k) => k.startsWith(`youling.chat.${ROOT.replace(/[:/]/g, '_')}.conv.`))).toBe(true)
    expect(keys.some((k) => k.startsWith('youling.chat._guest.conv.'))).toBe(false)
  })
})



// ══════════════ 2026-10-09：设备群广播的**嵌套卡摊平**（「真卡可点」最后一公里） ══════════════
// 真形状来自 PC 端：`chat_service::device_group_card_payload`（外层信封）
// × `dsh_share::sync_share_task`（card 记录）。**嵌在 payload.card 里**——
// 不摊平的话手机上 title/shareId/sourceDevice 全是 undefined：卡上没标题、
// 也没有「打开」入口（本轮真机缺口 L6）。
describe('2026-10-09：设备群嵌套卡摊平（真卡可点）', () => {
  // 桌面端建卡时写进 peer-tasks.json 的那条记录（字段逐字对齐 sync_share_task）
  const CARD: Record<string, unknown> = {
    taskId: 'peer-task-sh-dg1',
    title: '重构分享网关',
    desc: 'myco 分享 · 会话（读写：看 + 说） · 入口 https://myco.youling.cc/gw/sh-dg1/',
    from: MY,
    fromName: '我·abcd',
    createdAt: 1759900000000,
    source: 'dsh-share',
    shareId: 'sh-dg1',
    granularity: 'session',
    participants: [{ did: MY, name: '我·abcd', role: 'owner' }],
    status: 'todo',
    sourceDevice: 'did:myco:zOfficePc',
    sourceDeviceName: 'OFFICE-PC',
    action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/open?shareId=sh-dg1', label: '打开', target: 'window' },
  }
  // 设备群广播的 wire（外层信封）
  const wire = (card: Record<string, unknown>, status = 'todo'): Record<string, unknown> => ({
    groupId: deviceGroupId(MY),
    groupName: '设备群',
    members: [MY],
    fromName: 'OFFICE-PC',
    status,
    card,
  })

  it('flattenTaskSharePayload：card 摊平 + 外层信封键补齐 + 外层 status 权威', () => {
    const flat = flattenTaskSharePayload(wire(CARD))
    expect(flat.title).toBe('重构分享网关')
    expect(flat.shareId).toBe('sh-dg1')
    expect(flat.sourceDevice).toBe('did:myco:zOfficePc')
    expect(flat.sourceDeviceName).toBe('OFFICE-PC')
    // 外层信封键补齐（路由/账号坐标不能丢）
    expect(flat.groupId).toBe(deviceGroupId(MY))
    expect(flat.members).toEqual([MY])
    expect(flat.sourceAccount).toBe(MY)
    // 交付状态以**外层**为准（PC 端同口径：分享下线同步 done）
    expect(flattenTaskSharePayload(wire(CARD, 'done')).status).toBe('done')
  })

  it('平铺形态原样返回（单聊/群里的老形态任务卡不误伤）', () => {
    const flatCard = { taskId: 't1', title: '平铺卡', from: PEER }
    expect(flattenTaskSharePayload(flatCard)).toBe(flatCard)
    // card 不是对象（脏数据）→ 原样
    const dirty = { taskId: 't2', card: 'oops' }
    expect(flattenTaskSharePayload(dirty)).toBe(dirty)
  })

  it('2026-10-10：卡顶层缺 shareId/sourceDevice（真机事故形状）→ 摊平时从 action.url 抠齐', () => {
    // 真实广播/同步链丢字段的卡：顶层只有 sourceDeviceName，坐标全在 action.url 里
    const broken: Record<string, unknown> = { ...CARD, action: {
      kind: 'open-url',
      url: `http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-dg1&device=did:myco:zOfficePc&account=${MY}`,
      label: '打开', target: 'window',
    } }
    delete broken.shareId
    delete broken.sourceDevice
    const flat = flattenTaskSharePayload(wire(broken))
    expect(flat.shareId).toBe('sh-dg1')
    expect(flat.sourceDevice).toBe('did:myco:zOfficePc')
    expect(flat.sourceAccount).toBe(MY)
    // 双保险：shareCardOf 直接认这张"缺字段"卡也成（UI 上可点）
    const c = shareCardOf(flat)
    expect(c).toEqual({
      shareId: 'sh-dg1',
      sourceDevice: 'did:myco:zOfficePc',
      sourceAccount: MY,
      sourceDeviceName: 'OFFICE-PC',
      title: '重构分享网关',
    })
    // 卡里已有的坐标不被 URL 覆盖（顶层优先）
    const flat2 = flattenTaskSharePayload(wire(CARD))
    expect(flat2.sourceDevice).toBe('did:myco:zOfficePc')
  })

  it('★ 真形状嵌套卡落进手机会话 → payload 摊平 → shareCardOf 认得出（UI 上可点）', () => {
    const gid = deviceGroupId(MY)
    expect(
      ingestMsg(MY, S({ kind: 'task-share', from: MY, fromDevice: 'did:myco:zOfficePc', to: gid, payload: wire(CARD), ts: 1759900000000 })),
    ).toBe(true)
    const msgs = loadConv(gid)
    const msg = msgs.find((m) => m.kind === 'task-share')
    expect(msg).toBeTruthy()
    // 落库的就是**摊平后**的 payload（UI 读它渲染卡片 + 判断有没有「打开」入口）
    expect((msg!.payload as { shareId?: string }).shareId).toBe('sh-dg1')
    expect((msg!.payload as { title?: string }).title).toBe('重构分享网关')
    // UI 的判据（FriendsPanel.openTask → isShareCard → shareCardOf）必须成立
    const card = shareCardOf(msg!.payload)
    expect(card).toEqual({
      shareId: 'sh-dg1',
      sourceDevice: 'did:myco:zOfficePc',
      sourceAccount: MY,
      sourceDeviceName: 'OFFICE-PC',
      title: '重构分享网关',
    })
    // 任务库也落了同一张卡（同 taskId 幂等：重复投递只一条）
    ingestMsg(MY, S({ kind: 'task-share', from: MY, fromDevice: 'did:myco:zOfficePc', to: gid, payload: wire(CARD), ts: 1759900000001 }))
    const tasks = listTasks().filter((t) => t.taskId === 'peer-task-sh-dg1')
    expect(tasks.length).toBe(1)
    expect(tasks[0].title).toBe('重构分享网关')
  })
})

/* ═════════ §3.23 任务卡进「我的任务列表」+ 转授闸（canReshare） ═════════
 * 用户口径：「在手机点卡片……我希望这个任务卡片，当其他设备或好友接受，能出现在我的
 * 任务列表中，后面可以直接在那里点。但要处理好权限问题：好友再次分享给他人就不行吧，
 * 要经主人同意」。
 * 这几条钉住：① 卡**持久化进任务列表**（不依赖那条消息还在不在）；② 重复投递**幂等**
 * （不会两张）；③ 列表随时可点（`taskShareCardOf` 给全三个坐标）；④ 我的角色/权限可读；
 * ⑤ 转授闸默认 false + 主人批示能把 canReshare 翻上去。 */
describe('§3.23 任务卡进任务列表 + 转授闸', () => {
  const A = 'did:youling:zAlice'          // 分享者（源账号）
  const A_DEV = 'did:youling:zAlicePc'    // 源设备
  const card = (over: Record<string, unknown> = {}) => ({
    taskId: 'peer-task-sh-resh1', title: '重构分享网关', desc: '把卡落到任务列表',
    from: A, fromName: '爱丽丝', createdAt: 1759900000000, source: 'peer',
    shareId: 'sh-resh1', sourceDevice: A_DEV, sourceDeviceName: '爱丽丝的电脑',
    myRole: 'collaborator',
    grant: { role: 'collaborator', ro: false, caps: { 'session.read': true, 'session.input': true }, visibility: { space: 'project', windowMs: null }, canReshare: false, reshareExp: 0 },
    canReshare: false, reshareExp: 0, reshareVia: null,
    participants: [{ did: A, name: '爱丽丝', role: 'owner' }],
    ...over,
  })
  const wire = (p: Record<string, unknown>) => ({ ...p })
  const share = (p: Record<string, unknown>, fromDevice = A_DEV, ts = Date.now()) =>
    ingestMsg(MY, S({ kind: 'task-share', from: A, fromName: '爱丽丝', fromDevice, payload: wire(p), ts }))

  it('① 卡持久化进任务列表：会话行删掉也还在，且随时可点', () => {
    expect(share(card())).toBe(true)
    const t = listTasks().find((x) => x.taskId === 'peer-task-sh-resh1')!
    expect(t).toBeTruthy()
    // 谁分享的 / 我的角色 / 我的权限 / 可不可转授 —— 列表项要能标清这四件
    expect(t.sourceDevice).toBe(A_DEV)
    expect(t.sourceDeviceName).toBe('爱丽丝的电脑')
    expect(t.sourceAccount).toBe(A)
    expect(t.myRole).toBe('collaborator')
    expect(t.remoteOrigin).toBe(true)
    expect(taskPermLabel(t)).toBe('可看可说 · 这个项目')
    expect(taskCanReshare(t)).toBe(false) // 默认拒绝
    // 随时可点 = 三个坐标齐全（缺一个就没有入口，UI 不显示「打开」）
    expect(taskShareCardOf(t)).toEqual({
      shareId: 'sh-resh1', sourceDevice: A_DEV, sourceAccount: A,
      sourceDeviceName: '爱丽丝的电脑', title: '重构分享网关',
    })
    // **不依赖那条消息**：把会话删干净，卡与入口仍在
    deleteConv(A)
    expect(loadConv(A)).toHaveLength(0)
    const again = listTasks().find((x) => x.taskId === 'peer-task-sh-resh1')!
    expect(taskShareCardOf(again)).not.toBeNull()
  })

  it('①＋ 老卡顶层缺 sourceDevice → taskShareCardOf 从 action.url 兜底（不再误报"缺少来源设备信息"）', () => {
    // 2026-10-10 真机事故：任务列表点「打开」报"这张任务卡缺少来源设备信息"——
    // 卡的 action.url 明明带着三坐标，顶层却只有 sourceDeviceName。
    const legacy = {
      taskId: 'peer-task-share-sh-url1', title: '老卡', from: A, status: 'todo', convId: A,
      shareId: 'sh-url1', sourceDeviceName: '爱丽丝的电脑',
      action: { kind: 'open-url', url: `http://127.0.0.1:3102/api/dshShare/remoteOpen?shareId=sh-url1&device=${A_DEV}&account=${A}` },
    } as unknown as PeerTask
    expect(taskShareCardOf(legacy)).toEqual({
      shareId: 'sh-url1', sourceDevice: A_DEV, sourceAccount: A,
      sourceDeviceName: '爱丽丝的电脑', title: '老卡',
    })
    // 真·无坐标卡依然 null（不松口：不给点了必然失败的假入口）
    expect(
      taskShareCardOf({ taskId: 'x', title: 'x', from: A, status: 'todo', convId: A } as PeerTask),
    ).toBeNull()
    // URL 也不带 device 的卡（源设备 /open 只有 shareId）→ 顶层缺 sourceDevice 时仍 null
    expect(
      taskShareCardOf({
        taskId: 'y', title: 'y', from: A, status: 'todo', convId: A, shareId: 'sh-y',
        action: { kind: 'open-url', url: 'http://127.0.0.1:3102/api/dshShare/open?shareId=sh-y' },
      } as PeerTask),
    ).toBeNull()
  })

  it('② 重复投递幂等：同一 taskId / 同一 shareId 只留一张，且不回退本机进度', () => {
    share(card())
    share(card({ title: '重构分享网关（改了标题）' }), A_DEV, Date.now() + 1)
    // 换一份不同的 taskId、但同一个 shareId —— 仍必须收口到同一张卡
    share(card({ taskId: 'peer-task-sh-resh1-dup' }), A_DEV, Date.now() + 2)
    const list = listTasks().filter((x) => x.shareId === 'sh-resh1')
    expect(list).toHaveLength(1)
    expect(list[0].taskId).toBe('peer-task-sh-resh1')
    // 本机已推进到 doing → 迟到的重投递不得打回 pending
    const tasksKey = [...st.dump.keys()].find((k) => k.endsWith('.tasks'))!
    const raw = JSON.parse(st.dump.get(tasksKey)!) as { taskId: string; status: string }[]
    raw[0].status = 'doing'
    st.set(tasksKey, JSON.stringify(raw))
    share(card(), A_DEV, Date.now() + 3)
    expect(listTasks()[0].status).toBe('doing')
  })

  it('③ 主人批示（reshare-grant）→ 卡的转授面刷新，且不落气泡', () => {
    share(card())
    const before = loadConv(A).length
    expect(ingestMsg(MY, S({
      kind: 'reshare-grant', from: A, fromDevice: A_DEV,
      payload: { shareId: 'sh-resh1', requestId: 'rr-1', ok: true, canReshare: true, reshareExp: Date.now() + 86_400_000, reshareVia: '小B', targetDid: 'did:youling:zCarol' },
    }))).toBe(true)
    const t = listTasks().find((x) => x.taskId === 'peer-task-sh-resh1')!
    expect(t.canReshare).toBe(true)
    expect(t.reshareVia).toBe('小B')
    expect(taskCanReshare(t)).toBe(true)
    expect(loadConv(A).length).toBe(before) // 控制消息不落会话
    // 过期即失效（转授权是有寿命的；继承纪律：exp ≤ 原 grant exp）
    expect(taskCanReshare({ ...t, reshareExp: Date.now() - 1 })).toBe(false)
    // 直接对未入库的 shareId 下发 → 不改任何东西
    expect(applyReshareUpdate({ shareId: 'sh-none', canReshare: true })).toBe(false)
  })

  it('④ 权限缺失 fail-closed：赠卡没有/字段缺失 → 不可转授 + 权限未知（不白送全权）', () => {
    share({ taskId: 'peer-task-sh-bare', title: '裸卡', from: A, shareId: 'sh-bare', sourceDevice: A_DEV })
    const t = listTasks().find((x) => x.taskId === 'peer-task-sh-bare')!
    expect(t.myRole).toBe('collaborator')
    expect(taskCanReshare(t)).toBe(false)
    expect(taskPermLabel(t)).toContain('权限未知')
    // 只读 + 时间窗 → 人话里都要体现
    expect(taskPermLabel({
      ...t,
      grant: { ro: true, visibility: { space: 'session', windowMs: 6 * 3_600_000 } },
    })).toBe('只读 · 指定会话 · 最近6小时')
  })

  it('⑤ 自己设备群同步来的卡 → 我的角色=主人（同账号设备=分享即授权，不受转授闸限制）', () => {
    const gid = deviceGroupId(MY)
    // 本机设备发的卡：from 也是本机账号；fromDevice 是**另一台**设备（真跨设备）
    ingestMsg(MY, S({
      kind: 'task-share', from: MY, fromDevice: 'did:myco:zOtherPc', to: gid,
      payload: { groupId: gid, groupName: '设备群', members: [MY], fromName: '书房的电脑', status: 'todo', card: { taskId: 'peer-task-sh-mine', title: '我的任务', shareId: 'sh-mine', from: MY, sourceDevice: 'did:myco:zOtherPc', sourceDeviceName: '书房的电脑' } },
    }))
    // 自己发的卡（同账号设备群）在 peerTaskView 里是 mine → 不受"协作者"的转授限制
    const t = listTasks().find((x) => x.taskId === 'peer-task-sh-mine')!
    expect(peerTaskView(t, MY).mine).toBe(true)
  })
})

// ══════════════ 2026-10-18：wire msgId 内存去重索引（对账重放/渲染风暴治理） ══════════════

describe('wire msgId 严格去重索引', () => {
  beforeEach(() => { _resetWireSeenForTest() })

  it('首见 true / 重复 false（幂等，O(1) Set）', () => {
    expect(wireMsgSeen('m1')).toBe(false)
    expect(markWireMsgSeen('m1')).toBe(true)
    expect(wireMsgSeen('m1')).toBe(true)
    expect(markWireMsgSeen('m1')).toBe(false) // 重复不再"首次见"
    expect(markWireMsgSeen('m2')).toBe(true)
  })

  it('空 msgId 不登记（无幂等键的怪信封不下发去重结论）', () => {
    expect(wireMsgSeen('')).toBe(false)
    expect(markWireMsgSeen('')).toBe(false)
    expect(wireMsgSeen('')).toBe(false)
  })

  it('seedWireMsgSeen 批量预热：对账读 meta 后历史 msgId 全部视为已见（重启不重放）', () => {
    seedWireMsgSeen(['a1', 'a2', 'a3'])
    expect(wireMsgSeen('a1')).toBe(true)
    expect(wireMsgSeen('a3')).toBe(true)
    expect(wireMsgSeen('a4')).toBe(false) // 真缺口仍需 ingest
    // 重复预热幂等
    seedWireMsgSeen(['a1', 'a2'])
    expect(wireMsgSeen('a1')).toBe(true)
  })

  it('seedWireMsgSeenFromStorage：进程重启后从本桶全部会话摘要全局预热（含落错会话键的同批 msgId）', () => {
    const m = new Map<string, string>()
    _setStorageForTest({
      get: (k) => m.get(k) ?? null,
      set: (k, v) => { m.set(k, v) },
      del: (k) => { m.delete(k) },
      keys: () => [...m.keys()],
    })
    ingestMsg(MY, S({ id: 'seed-a' }))
    ingestMsg(MY, S({ id: 'seed-b', kind: 'group-msg', payload: { groupId: 'grp-seed', groupName: 'g', members: [MY, PEER], text: 'x' } }))
    _resetWireSeenForTest() // 模拟重启：内存索引清空，localStorage 仍在
    expect(wireMsgSeen('seed-a')).toBe(false)
    const added = seedWireMsgSeenFromStorage()
    expect(added).toBeGreaterThanOrEqual(2)
    expect(wireMsgSeen('seed-a')).toBe(true)
    expect(wireMsgSeen('seed-b')).toBe(true)
    expect(seedWireMsgSeenFromStorage()).toBe(0) // 同桶幂等：之后 O(1) 空转
    // 存储无 keys() 枚举能力 → 安全返回 0（不抛）
    _setStorageForTest({ get: () => null, set: () => {}, del: () => {} })
    expect(seedWireMsgSeenFromStorage()).toBe(0)
  })
})

// ══════════════ 2026-10-18：聊天屏读库→视图增量合并（渲染风暴治理） ══════════════

describe('mergeConvView 增量渲染', () => {
  const mk = (id: string, sendState?: ChatMsg['sendState']): ChatMsg => ({
    msgId: id, from: 'did:youling:A', to: 'did:youling:B', kind: 'text', payload: { text: id }, ts: id.length, dir: 'out', sendState,
  })

  it('完全一致 → 原引用返回（React 不重渲）', () => {
    const prev = [mk('a'), mk('b')]
    const next = [mk('a'), mk('b')]
    expect(mergeConvView(prev, next)).toBe(prev)
  })

  it('纯尾部追加 → 增量 append，老气泡引用保持不变（滚动稳定）', () => {
    const a = mk('a')
    const b = mk('b')
    const prev = [a, b]
    const next = [mk('a'), mk('b'), mk('c')]
    const merged = mergeConvView(prev, next)
    expect(merged).not.toBe(prev)
    expect(merged.length).toBe(3)
    expect(merged[0]).toBe(a) // 老引用保留 → 子组件/滚动不跳
    expect(merged[1]).toBe(b)
    expect(merged[2].msgId).toBe('c')
  })

  it('发送态/历史补齐等变更 → 整份替换（正确优先）', () => {
    const prev = [mk('a', 'sent')]
    expect(mergeConvView(prev, [mk('a', 'failed')])[0].sendState).toBe('failed')
    // 历史插到前面（对账补拉）→ 整份替换
    const next = [mk('z'), mk('a')]
    expect(mergeConvView(prev, next)).toBe(next)
    // 缩短（删除/撤回）→ 整份替换
    expect(mergeConvView([mk('a'), mk('b')], [mk('a')])).toEqual([mk('a')])
  })

  it('同长但顺序/内容变化 → 整份替换（不误当无变化）', () => {
    const prev = [mk('a'), mk('b')]
    const next = [mk('b'), mk('a')]
    expect(mergeConvView(prev, next)).toBe(next)
  })
})
