// signal.mjs — WebRTC 信令信箱（服务器只转 SDP/ICE 元数据，绝不转业务数据）。
//
// P2P 哲学：服务器只做"建联中介"——phone 和 PC 把 SDP offer/answer + ICE candidate
// 投到这里，按目标 did 路由给对方的轮询长连；建联完成后数据 phone⇄PC 直连，不经本服务。
//
// 内存态（不落库；进程重启丢正在进行的握手，客户端重连即可）：
//   boxes:   did -> [{msg, ts}, ...]   信箱（对方未在线时暂存，TTL 5 分钟）
//   waiters: did -> Set<{res, timer}>  当前挂着 SSE 轮询的连接（在线即推）
//
// 客户端用 fetch-based SSE（非 EventSource）拉 /signal/poll——因为 EventSource 不支持
// 自定义头，而 X-Myco-Auth 签名头必须带上。

import { isCryptoDid, normalizeDid } from './identity/index.mjs'

const BOX_TTL_MS = 5 * 60_000
// SSE 空闲策略(2026-08-28 改):原 30s 硬断+客户端重连,两端(canvas/phone)各背最多 30s+
// 重试延迟的候选投递间隙——ICE 直连对在浏览器提名窗口里跑不赢 TURN 中继,中继反成主路。
// 现改为 10s 一跳 keepalive 注释(SSE comment,两端解析器本就忽略),连接常驻;
// 10min 绝对上限兜底防僵尸连接(客户端断开走 res.on('close') 清理)。
const POLL_KA_MS = 10_000
const POLL_MAX_MS = 10 * 60_000
const boxes = new Map()
const waiters = new Map()

/** 信箱键归一（canonical-only，2026-10-10 收敛）：canonical 串幂等归一（保留
 *  method 前缀）；legacy/非法串不再换桶——投递侧 deposit 闸门已拒，轮询侧
 *  authedDid 已拒，这里归一只是把「同一把钥匙的 did:myco:/did:youling: 写法」
 *  等价处理交给 parse 的公钥级归一（同钥同 canonical 串，天然同桶）。 */
const boxKey = (did) => normalizeDid(did) ?? did

/** 投递一条信令消息到目标 did 的信箱，并即时推给在线轮询者。 */
export function deposit(toDid, msg) {
  if (!isCryptoDid(toDid)) return false
  const key = boxKey(toDid)
  let box = boxes.get(key)
  if (!box) { box = []; boxes.set(key, box) }
  box.push({ msg, ts: Date.now() })
  flush(key)
  return true
}

/** 把信箱里积压的消息推给在线轮询者（有轮询者才清空信箱；没有则保留待下次 poll）。 */
function flush(did) {
  const set = waiters.get(did)
  if (!set || set.size === 0) return
  const box = boxes.get(did)
  if (!box || box.length === 0) return
  const drained = box.splice(0) // 取走全部
  for (const w of set) {
    for (const item of drained) {
      try { w.res.write(`data: ${JSON.stringify(item.msg)}\n\n`) } catch {}
    }
    w.reset?.() // 有动静就重置超时（保持长连活跃）
  }
}

/** 一次性取走自己信箱的全部积压（手机作主设备收 pair 申请用——不设长连的场景）。 */
export function drain(did) {
  const box = boxes.get(boxKey(did))
  if (!box || box.length === 0) return []
  return box.splice(0).map((m) => m.msg)
}

/** 开一条 SSE 轮询长连：先把信箱积压的冲刷出来，然后挂着等新消息（10s keepalive 保活，10min 上限后收尾让客户端重连）。 */
export function startPoll(did, res) {
  did = boxKey(did)
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-myco-auth',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  })
  res.write(': connected\n\n')
  if (!waiters.has(did)) waiters.set(did, new Set())
  const w = { res, timer: null, born: Date.now() }
  // keepalive 循环:每 POLL_KA_MS 写一条 SSE 注释行保活;超过 POLL_MAX_MS 才收尾让客户端重连
  w.reset = () => {
    clearTimeout(w.timer)
    w.timer = setTimeout(() => {
      if (Date.now() - w.born >= POLL_MAX_MS) return endWaiter(did, w)
      try { w.res.write(': ka\n\n') } catch { return endWaiter(did, w) }
      w.reset()
    }, POLL_KA_MS)
  }
  waiters.get(did).add(w)
  flush(did) // 先冲积压
  w.reset()
  // 客户端断开（关页/重连）→ 清理
  res.on('close', () => { clearTimeout(w.timer); waiters.get(did)?.delete(w) })
}

function endWaiter(did, w) {
  waiters.get(did)?.delete(w)
  try { w.res.end() } catch {}
}

// 定期清过期信箱（防内存泄漏；只在无轮询者时清，有轮询者由 flush 即时清）
setInterval(() => {
  const now = Date.now()
  for (const [did, box] of boxes) {
    if (waiters.get(did)?.size) continue // 有等待者，不在这清
    const fresh = box.filter((m) => now - m.ts < BOX_TTL_MS)
    if (fresh.length) boxes.set(did, fresh)
    else boxes.delete(did)
  }
}, 60_000).unref()
