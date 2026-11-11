#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""send.py — myco skill 的跨会话/跨账号消息发送（本地直投 + 跨设备 + 跨账号路由）。

架构（2026-11-07 起三路由，设计源 docs/DESIGN-agent-directory.md §5）：
  本地（同一台 PC 的 DSH 会话）→ 直接调 DSH session/prompt RPC（不经 myco.exe）
  跨设备（手机/笔记本）       → 调 myco.exe :3102 session_send（现有兜底，保留）
  跨账号（好友/对方 DID/分享） → POST :3102/api/msg/route（myco 网关侧端点；
                                 未实现时优雅降级：一句话说明 + 退出码 1，绝不误投）

用法：
  python send.py --list                            # 列出全部可发目标（好友/分享任务/本机会话）
  python send.py --list --grep 远程                 # 按关键词过滤清单
  python send.py --to <目标> --stdin                # 文字消息首选（here-string/管道，正文不经命令行）
  python send.py --to <目标> --text "短句"           # 极短无引号文字的快捷方式（引号会被拒绝）
  python send.py --to <目标> --file D:\\photos\\a.png  # 仅用于发送文件附件（路径=真实文件）
  python send.py --to <目标> --stdin --queue        # 排队（默认 steer=插队，见下）

正文来源定位（2026-11-07，DESIGN §7）：
  --stdin  文字消息**首选**（长文/多行/含引号的唯一安全通道）
  --file   **仅用于发送文件附件**：路径指向真实文件（图片/文档等），不是临时写正文再发
  --text   极短且无引号的快捷方式；含引号/被 shell 拆开会直接拒绝（见下）

--to 智能路由（四种格式，按优先级识别，DESIGN §4.3/§5.1）：
  "session-xxxx-..."  本机 DSH 会话 ID → DSH RPC 直投（查无此会话则 myco.exe 跨设备兜底）
  "did:youling:..."   跨账号 DID       → POST /api/msg/route（必须在协作清单中，防幻觉 DID；
                                          清单里的 z6Mk...sHaW 是展示缩写，不可用来路由）
  "sh-xxxx"           分享任务 shareId  → 查 :3102/api/dshShare/list 拿 owner DID + 绑定会话
                                          → POST /api/msg/route
  "任意文字"           名称匹配：好友昵称 → 分享任务名 → 会话标题
                          先精确后包含；命中多个 → 列候选并退出（反问用户，不盲选）；
                          命中零个 → 报错并列出当前可用目标

投递模式（2026-10-28 jason 令：默认改插队；同日按 DSH 源码校正措辞）：
  steer（默认）= 下一步边界生效：对方当前正在执行的一步（模型步/工具调用）会先跑完，你的消息随即进入上下文、参与下一步决策——不等它整轮结束。
                （DSH 源码：steer → send(input,"next-step",true)，即"下一个步边界"；
                 不是立刻掐断——正在执行的工具/模型步不会被中止）
  queue        = 等对方当前轮完整结束（模型停笔/回合收尾）后，作为新一轮处理
                ——只在"不紧急/纯通知/对方要求别插"时显式使用
  对方空闲（无轮在跑）时两者等价：都立即开始新轮。
  观察与风险（jason 原话）：插队多了可能消息泛滥，但"发送方有自己的考量，接收方也
  不一定看到就回"——所以默认交给插队，发送方觉得可以等就自己加 --queue。

🚨 2026-10-22 静默截断事故（已修）：
  Windows PowerShell 5.1 在把变量传给 native 程序（python.exe）时，**不会转义正文里的
  引号**（`"` 以及被 PS 当作引号的 `“”`）。`--text $msg` 会在引号处把参数拆成多段：
  python 只拿到第一段，send.py 旧版只取 argv 里 --text 的下一项、**静默忽略其余片段**，
  于是收件方拿到的是被砍掉尾巴的正文，而发送端仍然打印 ✅（DSH RPC 也照样返回 ok）。
  生产实测断点：1210 / 619 / 408 / 784 字符，全部落在引号/空格处（不是 HTTP 层问题）。

  现在的防线（三道）：
    1. 引号/参数完整性：解析完已知选项后若还有多余片段（= shell 把正文拆开了）→ 拒绝；
       并回到 Windows 原始命令行与 sys.argv 对比，发现引号被 PowerShell 吞掉也拒绝；
    2. 内容来源强制：拒绝上述可疑调用，要求改用 --file/--stdin（正文不经过命令行）；
    3. 送达校验（默认开启）：投递后从收件方会话日志的 `agent/inbox/spliced` 事件里
       读回落库文本，与发送内容逐字比对；不一致 → ❌ 且退出码非 0。✅ 只在验证通过后打印。

自动署名（无需调用方做任何事，v6 充要两行）：
  [from: 发送方名字 · 10-19 19:16]
  reply-to: session-xxxx-...
  正文

发送方身份来源：$DSH_SESSION_ID 环境变量（每个 DSH 会话自动注入）。
"""
import io
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsh_rpc

MYCO_API = "http://127.0.0.1:3102/api/cli"
MYCO_TIMEOUT = 90

# ── 协作智能体清单（与 src/directory.js 同源的三类数据，端口/端点对齐）──
MYCO_API_PORTS = (3102, 3103)       # directory.js MYCO_API_PORTS：主 3102，兜底 3103
CHAT_STATE_PATH = "/api/chat_state"  # 好友（HTTP 未挂时回退 myco cli chat state）
SHARE_LIST_PATH = "/api/dshShare/list"
MSG_ROUTE_PATH = "/api/msg/route"   # 跨账号路由端点（myco 网关侧；截至 2026-11-07 未实现，实测 404）
SOURCE_TIMEOUT = 5                  # 单个 HTTP 源探测超时（秒）

SESS_ROOT = os.path.join(os.path.expanduser("~"), ".dsh", "sessions")
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
VERIFY_TAIL_BYTES = 8 * 1024 * 1024

try:  # 送达校验需要读 DSH 的 zstd 会话日志；缺库时降级为"未验证"而非误报
    import zstandard
except Exception:  # pragma: no cover - 环境缺库
    zstandard = None


# ── 会话清单 ──────────────────────────────────────────────────

def _extract_title(item: dict) -> str:
    """从 DSH session/list 条目提取标题（嵌套在 projections.values.title）。"""
    return ((item.get("projections") or {}).get("values") or {}).get("title") or ""


def get_sessions():
    """从 DSH 直接拉会话清单（含 fork），返回 [{sessionId, title, ...}]。"""
    try:
        res = dsh_rpc.rpc("session/list", {"_request": {}})
        raw = (res.get("result", {}).get("value", {}).get("items", [])
               if "result" in res else res.get("items", []))
        # 展平：title 从 projections.values.title 提取到顶层
        items = []
        for s in raw or []:
            s["title"] = _extract_title(s)
            items.append(s)
        return items
    except (Exception, SystemExit):
        # SystemExit 也要吞：dsh_rpc.detect() 探不到端口时 raise SystemExit，
        # 清单容错要求"任一源不可达 → 该类清空 + 一句说明"，不让整个 --list 崩掉
        return []


# ── 协作智能体清单（src/directory.js 数据层的 Python 对等实现）─────
# 三源合并成 Agent Entry 列表：好友(chat_state) + 分享(dshShare/list) + 本机会话(session/list)。
# 目录缓存活在插件宿主（Node）进程里，Python 侧拿不到——这里直接拉同样的源头数据，
# 字段与 directory.js 的 friendEntry/shareEntry/sessionEntry 一一对应。

def _clean_line(v) -> str:
    """压缩空白成单行（directory.js cleanLine 的 Python 版）。"""
    if not isinstance(v, str):
        return ""
    return " ".join(v.split())


def _short_did(did: str) -> str:
    """did:youling:z6Mk...yqTy（directory.js shortDid 同规则：头4+…+尾4）。"""
    t = (did or "").strip()
    i = t.rfind(":")
    if i < 0:
        return t
    prefix, body = t[:i + 1], t[i + 1:]
    if len(body) <= 8:
        return t
    return f"{prefix}{body[:4]}...{body[-4:]}"


def is_shortened_did(did: str) -> bool:
    """清单/摘要里展示的短 DID（did:youling:z6Mk...sHaW）不可用来路由。"""
    return "..." in (did or "")


def _http_request(path: str, method: str = "GET", body: dict | None = None,
                  timeout: float = SOURCE_TIMEOUT):
    """对 myco 管理面（3102 → 3103 逐个试）发 HTTP。

    返回 (status, parsed)：status=None 表示两个端口都连不上；parsed 仅在应答为
    JSON 对象时给出。HTTPError（如 404）记下状态码后仍试下一个口——与
    directory.js getJson"非 200 当失败、换口"的语义一致。
    """
    import urllib.error
    import urllib.request
    last_status = None
    for port in MYCO_API_PORTS:
        url = f"http://127.0.0.1:{port}{path}"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
            raw = resp.read().decode("utf-8", "replace")
            try:
                parsed = json.loads(raw) if raw.strip() else None
            except Exception:
                parsed = None
            status = getattr(resp, "status", None) or resp.getcode()
            return status, (parsed if isinstance(parsed, dict) else None)
        except urllib.error.HTTPError as e:
            last_status = e.code        # 端口有服务但路由不符（404 等）→ 记下，换口
        except Exception:
            continue                    # 连不上/超时 → 换口
    return last_status, None


def _http_json(path: str, method: str = "GET", body: dict | None = None,
               timeout: float = SOURCE_TIMEOUT):
    """拿一个 JSON 对象（仅 200 算成功）；任何失败返回 None（吞掉一切异常）。"""
    status, parsed = _http_request(path, method, body, timeout)
    return parsed if status == 200 else None


def _myco_exe() -> str | None:
    """定位 myco.exe（与 directory.js resolveMycoExeLocal 同规则）。"""
    configured = os.environ.get("MYCO_EXE", "").strip()
    if configured:
        return configured
    if os.name == "nt":
        candidates = []
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            candidates.append(os.path.join(local, "Programs", "Youling", "myco.exe"))
        candidates.append(os.path.join(os.path.expanduser("~"), "AppData", "Local",
                                       "Programs", "Youling", "myco.exe"))
        for c in candidates:
            if os.path.isfile(c):
                return c
    return None


def _extract_json_object(text: str) -> dict | None:
    """从可能带噪声的 stdout 里抠 JSON 对象（directory.js parseJsonObject）。"""
    t = (text or "").strip()
    if not t:
        return None
    candidates = [t]
    start, end = t.find("{"), t.rfind("}")
    if start >= 0 and end > start:
        candidates.append(t[start:end + 1])
    for cand in candidates:
        try:
            v = json.loads(cand)
            if isinstance(v, dict):
                return v
        except Exception:
            continue
    return None


def get_friends() -> tuple[list | None, dict]:
    """好友列表 + 我的账号元数据（chat_state：friends[]/myDid/myName）。

    HTTP 先试 :3102/:3103（桌面端管理面尚未挂 /api/chat_state，2026-11-07 实测
    404，与 directory.js 注记一致），失败回退 `myco cli chat state`（同形状输出）。
    返回 (friends, meta)；friends=None 表示该源不可达（meta 仍尽力给 myDid/myName，
    供跨账号发送的 fromDid/fromName 用）。
    """
    import subprocess
    got = _http_json(CHAT_STATE_PATH)
    if got is not None:
        friends = got.get("friends")
        return (friends if isinstance(friends, list) else []), _friend_meta(got)
    exe = _myco_exe()
    if exe:
        try:
            p = subprocess.run([exe, "cli", "chat", "state"],
                               capture_output=True, timeout=15)
            got = _extract_json_object(p.stdout.decode("utf-8", "replace"))
            if got is not None:
                friends = got.get("friends")
                return (friends if isinstance(friends, list) else []), _friend_meta(got)
        except Exception:
            pass
    return None, {}


def _friend_meta(state: dict) -> dict:
    meta = {}
    for key in ("myDid", "myName"):
        v = state.get(key)
        if isinstance(v, str) and v.strip():
            meta[key] = v.strip()
    return meta


def get_shares() -> list | None:
    """分享任务注册表（:3102/:3103 /api/dshShare/list → shares[]）。不可达返回 None。"""
    got = _http_json(SHARE_LIST_PATH)
    if got is None:
        return None
    shares = got.get("shares")
    return shares if isinstance(shares, list) else []


def _friend_entry(raw) -> dict | None:
    """chat_state.friends[] 条目 → Agent Entry（directory.js friendEntry）。"""
    if not isinstance(raw, dict) or raw.get("pending") is True:
        return None
    did = _clean_line(raw.get("did"))
    if not did:
        return None
    nick = _clean_line(raw.get("name"))
    return {"kind": "friend", "did": did, "nickname": nick,
            "online": raw.get("status") == "ok",
            "displayName": nick or did[-4:]}


def _is_owner_grant(g) -> bool:
    return isinstance(g, dict) and ("owner" in (g.get("label"), g.get("role"))
                                    or g.get("owner") is True)


def _decide_my_role(grants, my_did: str, owner_account: str) -> str:
    """我在这个分享里的角色（directory.js decideMyRole 同规则）。"""
    if my_did and owner_account and owner_account == my_did:
        return "owner"
    owners = [g for g in (grants or []) if _is_owner_grant(g)]
    if not owners:
        return "collaborator"
    if not my_did:
        return "owner"
    return "owner" if any(g.get("did") == my_did for g in owners) else "collaborator"


def _share_entry(raw, my_did: str, friends_by_did: dict) -> dict | None:
    """dshShare/list 条目 → Agent Entry（directory.js shareEntry）。"""
    if not isinstance(raw, dict) or raw.get("state") == "closed":
        return None
    share_id = _clean_line(raw.get("shareId") or raw.get("id"))
    if not share_id:
        return None
    title = _clean_line(raw.get("title"))
    custom = _clean_line(raw.get("customName") or raw.get("customTitle")
                         or raw.get("renamedTitle"))
    bound = _clean_line(raw.get("sessionId"))
    owner_did = _clean_line(raw.get("ownerAccount"))
    my_role = _decide_my_role(raw.get("grants"), my_did, owner_did)
    return {"kind": "share", "shareId": share_id, "taskTitle": title,
            "customName": custom, "boundSessionId": bound, "ownerDid": owner_did,
            "myRole": my_role,
            "displayName": custom or title or share_id}


def build_directory(friends, shares, sessions, my_did: str = "") -> tuple[list, dict]:
    """三源合成 Agent Entry 列表（字段对齐 src/directory.js）。

    返回 (entries, notes)：notes={"friend": True, ...} 标记不可达的源（该类清空
    + 渲染时一句说明）。会话不过滤当前会话——JS 侧的过滤只影响 prompt 展示，
    --list/解析保持"全部可发目标"。
    """
    entries, notes = [], {}
    if friends is None:
        notes["friend"] = True
    else:
        entries.extend(e for e in (_friend_entry(f) for f in friends) if e)
    friends_by_did = {e["did"]: e["nickname"] for e in entries
                      if e["kind"] == "friend" and e.get("nickname")}
    if shares is None:
        notes["share"] = True
    else:
        entries.extend(e for e in (_share_entry(s, my_did, friends_by_did)
                                   for s in shares) if e)
    for s in sessions or []:
        sid = _clean_line(s.get("sessionId"))
        if not sid:
            continue
        title = _clean_line(s.get("title") or s.get("name"))
        entries.append({"kind": "session", "sessionId": sid, "sessionTitle": title,
                        "displayName": title or "（未命名会话）"})
    return entries, notes


_KIND_LABEL = {"friend": "好友", "share": "分享任务", "session": "本机其他会话"}
_KIND_NOTE = {"friend": "好友列表暂不可达", "share": "分享任务列表暂不可达",
              "session": "本机DSH会话列表暂不可达"}


def _share_owner_label(e: dict, friends_by_did: dict) -> str:
    if e["myRole"] == "owner":
        return "我"
    if e["ownerDid"]:
        return friends_by_did.get(e["ownerDid"]) or _short_did(e["ownerDid"])
    return "他人"


def format_directory(entries: list, notes: dict, max_entries: int = 30) -> str:
    """渲染清单（段序/格式对齐 directory.js renderSummary：好友 > 分享 > 会话）。"""
    friends_by_did = {e["did"]: e["nickname"] for e in entries
                      if e["kind"] == "friend" and e.get("nickname")}
    sections = []
    for kind in ("friend", "share", "session"):
        grp = [e for e in entries if e["kind"] == kind]
        if notes.get(kind):
            sections.append(f"{_KIND_LABEL[kind]}：\n- （{_KIND_NOTE[kind]}）")
            continue
        if not grp:
            continue
        lines = []
        for e in grp[:max_entries]:
            if e["kind"] == "friend":
                lines.append(f"- {e['displayName']} ({_short_did(e['did'])}) — "
                             f"{'在线' if e['online'] else '离线'}")
            elif e["kind"] == "share":
                bound = (f"绑定会话={e['boundSessionId']}" if e["boundSessionId"]
                         else "无绑定会话")
                lines.append(f"- \"{e['displayName']}\" (shareId={e['shareId']}, "
                             f"owner={_share_owner_label(e, friends_by_did)}, {bound})")
            else:
                lines.append(f"- \"{e['displayName']}\" ({e['sessionId']})")
        if len(grp) > max_entries:
            lines.append(f"…另有 {len(grp) - max_entries} 个")
        sections.append(f"{_KIND_LABEL[kind]}：\n" + "\n".join(lines))
    return "\n\n".join(sections)


def describe_entry(e: dict) -> str:
    """候选列表/日志里的一条人话描述。"""
    if e["kind"] == "friend":
        return f"{e['displayName']} [好友 did={_short_did(e['did'])}]"
    if e["kind"] == "share":
        return f"\"{e['displayName']}\" [分享任务 shareId={e['shareId']}]"
    return f"\"{e['displayName']}\" [本机会话 {e['sessionId']}]"


def resolve_target(name_or_id: str, sessions: list) -> dict | None:
    """按名字或 sessionId 找目标会话。

    2026-10-23 起四级匹配保留，但**模糊档加歧义防御**：包含匹配/前缀匹配命中 >1 个
    时直接报错并列出候选（旧行为"取第一个"会静默错投，如 --to "管理" 命中
    申诉管理/抽检管理/…里的第一个）。精确档（ID 全等/名字全等）命中多个同样报错。
    """
    nid = name_or_id.strip()

    def _ambiguous(tier: str, hits: list):
        print(f"❌ --to \"{nid}\" 在{tier}命中 {len(hits)} 个会话，为避免错投已拒绝：", file=sys.stderr)
        for s in hits[:10]:
            t = s.get("title") or s.get("name") or "?"
            print(f"     {t:40s} {s.get('sessionId', '?')}", file=sys.stderr)
        print("   请用完整 sessionId（推荐，回信用对方消息里 reply-to: 的 ID）或精确全名重发。", file=sys.stderr)
        sys.exit(2)

    # ① sessionId 全等（唯一键，命中即返回）
    for s in sessions:
        if s.get("sessionId", "") == nid:
            return s
    # ② 名字全等
    exact = [s for s in sessions if s.get("title", "") == nid]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        _ambiguous("名字全等", exact)
    # ③ 名字包含（不分大小写）
    fuzzy = [s for s in sessions if nid.lower() in (s.get("title") or "").lower()]
    if len(fuzzy) == 1:
        return fuzzy[0]
    if len(fuzzy) > 1:
        _ambiguous("名字包含", fuzzy)
    # ④ sessionId 前缀
    pref = [s for s in sessions if s.get("sessionId", "").startswith(nid)]
    if len(pref) == 1:
        return pref[0]
    if len(pref) > 1:
        _ambiguous("ID 前缀", pref)
    return None


def classify_target(to: str) -> str:
    """--to 四种格式的优先级识别（DESIGN-agent-directory §4.3/§5.1）。

    "session-…" → "session-id"（本机 DSH 会话 ID，走现有四级匹配 + DSH RPC）
    "did:…"     → "did"（跨账号 DID，走 /api/msg/route）
    "sh-…"      → "share-id"（分享任务，先查注册表再走 /api/msg/route）
    其余        → "name"（名称匹配：好友昵称 → 分享任务名 → 会话标题）
    """
    t = (to or "").strip()
    if t.startswith("session-"):
        return "session-id"
    if t.lower().startswith("did:"):
        return "did"
    if t.startswith("sh-"):
        return "share-id"
    return "name"


def resolve_via_directory(nid: str, directory: list):
    """名称匹配（增强版）：在整个协作清单里按 displayName 找目标。

    层级：① 全类目精确（好友昵称 / 分享任务名 / 会话标题）
          ② 全类目包含（不分大小写）
          ③ 本机会话 sessionId 前缀（保留旧版"session-xxx 前缀缩写"习惯）
    每层内命中多个 → ("ambiguous", hits)：列出候选并退出，让 AI 反问用户，不盲选。
    返回 ("resolved", entry) / ("ambiguous", hits) / ("none", None)；
    不打印不退出——输出与退出码由调用方统一处理。
    """
    nid = (nid or "").strip()
    exact = [e for e in directory if e.get("displayName") == nid]
    if len(exact) == 1:
        return "resolved", exact[0]
    if len(exact) > 1:
        return "ambiguous", exact
    fuzzy = [e for e in directory if nid.lower() in (e.get("displayName") or "").lower()]
    if len(fuzzy) == 1:
        return "resolved", fuzzy[0]
    if len(fuzzy) > 1:
        return "ambiguous", fuzzy
    pref = [e for e in directory
            if e["kind"] == "session" and e.get("sessionId", "").startswith(nid)]
    if len(pref) == 1:
        return "resolved", pref[0]
    if len(pref) > 1:
        return "ambiguous", pref
    return "none", None


def find_did_in_directory(did: str, directory: list) -> dict | None:
    """完整 DID 反查清单条目（好友 did 或分享 ownerDid；DESIGN §8 防 AI 幻觉 DID）。"""
    did = (did or "").strip()
    for e in directory:
        if e["kind"] == "friend" and e["did"] == did:
            return e
    for e in directory:
        if e["kind"] == "share" and e.get("ownerDid") == did:
            return e
    return None


def find_share(share_id: str, directory: list) -> dict | None:
    """shareId 反查分享条目。"""
    share_id = (share_id or "").strip()
    for e in directory:
        if e["kind"] == "share" and e["shareId"] == share_id:
            return e
    return None


# ── 署名 ─────────────────────────────────────────────────────

def id8(session_id: str) -> str:
    """sessionId 后 8 位（myco 惯例）。"""
    return session_id[-8:] if len(session_id) >= 8 else session_id


def sender_info(sessions: list) -> tuple[str, str]:
    """返回 (sender_name, sender_session_id)。从 $DSH_SESSION_ID 取身份。"""
    sid = os.environ.get("DSH_SESSION_ID", "")
    if not sid:
        return "unknown", ""
    for s in sessions:
        if s.get("sessionId") == sid:
            name = s.get("title") or s.get("name") or id8(sid)
            return name, sid
    return id8(sid), sid


def build_header(sender_name: str, sender_sid: str) -> str:
    """构造署名头（v6「充要」版，与 myco.exe 的 format_chat_header 同格式）。

    ```
    [from: 会话名 · 10-19 19:16]
    reply-to: session-<完整 sessionId>
    ```
    只留必要且充分的三件事：谁发的（名字，人读）、回给谁（完整 id，路由）、什么时候。
    砍掉的都是可推导/重复的：reply-to-name（= from 名字）、id 尾（= reply-to 末 8）、
    设备尾（会话 id 已定位设备侧）、via myco/via skill（通道是实现细节）、---
    （两行前缀自识别）。用户原话：「这个消息头太冗长啊，你不能秉持充要么」。
    """
    stamp = time.strftime('%m-%d %H:%M')
    name = (sender_name or "").strip() or "myco"
    lines = [f"[from: {name} · {stamp}]"]
    if sender_sid:
        sid = sender_sid if sender_sid.startswith("session-") else f"session-{sender_sid}"
        lines.append(f"reply-to: {sid}")
    return "\n".join(lines) + "\n"


# 手写头识别：正文开头由调用方自己拼的署名/回信行（各种变体）。
# 审计（2026-10-23 audit-inter-session）：44 份草稿手写旧版头 `[from: X via myco]`、
# 36 条原样投达——调用方模仿"接收格式"当"发送模板"。规则：**调用方永远只给正文**，
# 头由 send.py 自动生成；这里把混进来的手写头剥掉，让误用变得无害。
# 2026-10-23 13:5x 补第二件马甲：`【A → B】`/`[A → B]` 路由标签（现场：DSH协议应用
# 发的消息正文开头手写"【DSH协议应用 → 有灵myco】"——与自动头完全重复）。
import re as _re

_HEADER_LINE = _re.compile(
    r"^\s*(\[[Ff][Rr][Oo][Mm]:.*\]?\s*|[Rr][Ee][Pp][Ll][Yy]-[Tt][Oo]:\s*\S+.*)$"
)
# 路由标签：括号内含 → 的标签（【A → B】/ [A → B]）。不含 → 的【重要】等正常内容不碰。
# 两种形态都算：①独立成行；②**行前缀**（现场实锤：`【DSH协议应用 → 有灵myco】B1 干扰预警：…`
# ——标签和正文挤在同一行，只剥前缀、保留后面正文）。
_ROUTE_LABEL = _re.compile(r"^\s*[【\[][^】\[\]]*→[^】\[\]]*[】\]]\s*$")
_ROUTE_LABEL_PREFIX = _re.compile(r"^\s*[【\[][^】\[\]]*→[^】\[\]]*[】\]]")


def strip_handwritten_header(text: str):
    """剥掉正文开头的手写消息头与路由标签。

    覆盖三类（只剥**开头连续**的，正文中间出现的同款文本不动）：
      1. `[from: …]`（含旧版 via myco 变体）
      2. `reply-to: …`
      3. `【A → B】` / `[A → B]` 路由标签——独立行整行剥；作为**行前缀**只剥前缀留正文
    返回 (干净正文, 剥掉行数/次数)。
    """
    lines = text.split("\n")
    i = 0
    stripped = 0
    n = len(lines)
    while i < n:
        s = lines[i].strip()
        if not s:                      # 头行之间的空行跟着剥（但至少保留与正文的分隔由后面统一加）
            j = i
            while j < n and not lines[j].strip():
                j += 1
            if j < n and (_HEADER_LINE.match(lines[j].strip())
                          or _ROUTE_LABEL.match(lines[j].strip())
                          or _ROUTE_LABEL_PREFIX.match(lines[j].strip())):
                i = j
                continue
            break
        if _HEADER_LINE.match(s) or _ROUTE_LABEL.match(s):
            stripped += 1
            i += 1
            continue
        m = _ROUTE_LABEL_PREFIX.match(s)
        if m and m.end() < len(s):     # 行前缀形态：剥前缀，同行剩余部分成为正文开头
            lines[i] = s[m.end():].lstrip()
            stripped += 1
            continue                   # 重看本行（可能叠两个标签）
        break
    if stripped:
        return "\n".join(lines[i:]).lstrip("\n"), stripped
    return text, 0


# ── 送达校验（从收件方会话日志取证）──────────────────────────

def find_session_log(session_id: str) -> str | None:
    """按 sessionId 在 ~/.dsh/sessions/<workspace>/<sessionId>/ 下找日志文件。"""
    try:
        workspaces = os.listdir(SESS_ROOT)
    except OSError:
        return None
    for ws in workspaces:
        d = os.path.join(SESS_ROOT, ws, session_id)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if ".jsonl" in name or name.endswith(".zstd"):
                return os.path.join(d, name)
    return None


def _tail_frames(path: str):
    """从日志尾部按 zstd 帧逐帧解压（帧独立，可只读尾部，避免解压 200MB）。"""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - VERIFY_TAIL_BYTES))
        buf = f.read()
    offs = []
    i = buf.find(ZSTD_MAGIC)
    while i >= 0 and len(offs) < 600:
        offs.append(i)
        i = buf.find(ZSTD_MAGIC, i + 4)
    for off in reversed(offs):
        try:
            with zstandard.ZstdDecompressor().stream_reader(
                    io.BytesIO(buf[off:]), read_across_frames=False) as r:
                raw = r.read()
        except Exception:
            continue  # 魔数可能只是压缩数据里的巧合字节，跳过
        yield raw


def _last_inbox_text(path: str, since_ms: int = 0):
    """返回 since_ms 之后、时间最晚的一条 agent/inbox/spliced 文本（收件方落库正文）。

    since_ms 用于排除"同一发送方上一条旧消息"：否则刚发完还没落库时，会把旧消息
    误判成本次被截断。
    """
    last = None
    last_time = -1
    for raw in _tail_frames(path):
        for line in raw.decode("utf-8", "replace").splitlines():
            if "agent/inbox/spliced" not in line:
                continue
            try:
                e = json.loads(line)
                ins = e["data"].get("inserted") or []
                if not ins:
                    continue
                text = "".join(b.get("text", "") for b in ins[0].get("content", [])
                               if b.get("type") == "text")
                t = e.get("time") or 0
            except Exception:
                continue
            if not text or t < since_ms:
                continue
            if t >= last_time:
                last_time = t
                last = text
    return last


def verify_delivery(session_id: str, expected: str, header: str, timeout: float = 5.0,
                    since_ms: int = 0) -> dict:
    """轮询收件方日志，判定 exact / truncated / unknown。

    判据来自 2026-10-22 事故取证脚本 check_delivery.py：`agent/inbox/spliced` 的
    inserted[0].content[0].text 才是"收件方真实拿到的正文"；发送端 ✅ 和 RPC ok 都不算。
    """
    if zstandard is None:
        return {"status": "unknown", "reason": "缺少 zstandard 库，无法读会话日志"}
    path = find_session_log(session_id)
    if path is None:
        return {"status": "unknown", "reason": "找不到收件方会话日志"}
    deadline = time.time() + max(0.0, timeout)
    last = None
    while True:
        try:
            last = _last_inbox_text(path, since_ms) or last
        except Exception as e:
            return {"status": "unknown", "reason": f"读日志失败: {e}", "path": path}
        if last == expected:
            return {"status": "exact", "path": path, "received_chars": len(last),
                    "received_bytes": len(last.encode("utf-8"))}
        # 找到"本次发送时间点之后、带同一署名头"的消息，但不是预期文本 → 截断。
        # 注意：必须用 since_ms 把上一条旧消息排除，否则会把"还没落库"误判成截断。
        if last and header.strip() and last.startswith(header.strip().split("\n")[0]) \
                and last != expected:
            return {"status": "truncated", "path": path, "received_chars": len(last),
                    "received_bytes": len(last.encode("utf-8")), "received_tail": last[-80:]}
        if time.time() >= deadline:
            break
        time.sleep(0.25)
    if last and header.strip() and last.startswith(header.strip().split("\n")[0]):
        return {"status": "truncated", "path": path, "received_chars": len(last),
                "received_bytes": len(last.encode("utf-8")), "received_tail": last[-80:]}
    return {"status": "unknown", "reason": "日志里没找到本次消息（可能目标会话尚未落库）",
            "path": path, "last_chars": len(last) if last else 0}


# ── 本地投递（DSH RPC 直投）───────────────────────────────────

def send_local(target_sid: str, text: str, mode: str = "steer") -> dict:
    """直接调 DSH session/prompt（不经 myco.exe）。"""
    req = {
        "request": {
            "requestId": f"skill-{int(time.time()*1000)}",
            "sessionId": target_sid,
            "mode": mode,
            "content": [{"type": "text", "text": text}],
        }
    }
    res = dsh_rpc.rpc("session/prompt", req)
    result = res.get("result", {}) or {}
    ok = bool(result.get("ok", False))
    value = result.get("value") or {}
    if ok and value.get("accepted") is False:
        ok = False
    return {"ok": ok, "route": "local-dsh-rpc", "detail": res}


# ── 跨设备投递（myco.exe）────────────────────────────────────

def send_remote(target: str, sender_sid: str, text: str, mode: str = "steer") -> dict:
    """调 myco.exe :3102 session_send（跨设备）。"""
    import urllib.request
    import urllib.error
    body = json.dumps({
        "action": "session_send",
        "to": target,
        "sessionId": sender_sid,
        "text": text,
        "mode": mode,
    }).encode()
    r = urllib.request.Request(MYCO_API, data=body,
                               headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(r, timeout=MYCO_TIMEOUT)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        return {"ok": False, "error": f"HTTP {e.code}: {err[:200]}", "route": "myco-remote"}
    except Exception as e:
        return {"ok": False, "error": str(e), "route": "myco-remote"}


# ── 跨账号投递（myco 网关 /api/msg/route）────────────────────

def send_cross_account(to_did: str, body: str, mode: str = "steer",
                       from_name: str = "", from_did: str = "",
                       session_id: str = "") -> dict:
    """跨账号路由：POST :3102/api/msg/route（接口契约已与 myco 网关侧定稿）。

    请求体：{"to": 目标账号DID, "sessionId": 目标DSH会话(可选), "fromName": 发送者
    显示名, "fromDid": 发送者DID, "kind": "dsh-session-msg", "body": 正文, "mode":
    steer|queue}。发送方身份走结构化字段（网关到达端负责重组署名），body 只放纯正文。

    成功：{"ok":true,"delivered":true,"sessionId":"...","via":"p2p-direct"}。

    ⚠️ 该端点目前不存在（myco 网关侧未实现，2026-11-07 实测 404）——这里做
    **优雅降级**：连不上/404/非 200 → {"ok": False, "unimplemented": True,
    "reason": ...}，调用方打印"跨账号消息路由暂不可用"并以退出码 1 结束，
    **绝不** fallback 到其他路径（防误投）。网关真实回包 {"ok":false,"error":...}
    则原样透出 error。
    """
    payload = {
        "to": to_did,
        "fromName": from_name or "unknown",
        "fromDid": from_did,
        "kind": "dsh-session-msg",
        "body": body,
        "mode": mode,
    }
    if session_id:
        payload["sessionId"] = session_id
    status, parsed = _http_request(MSG_ROUTE_PATH, "POST", payload, timeout=30)
    if status is None:
        return {"ok": False, "unimplemented": True,
                "reason": "myco 网关不可达（127.0.0.1:3102/3103 均连接失败）"}
    if status == 404:
        return {"ok": False, "unimplemented": True,
                "reason": "HTTP 404：网关未挂 /api/msg/route 路由"}
    if status != 200:
        return {"ok": False, "unimplemented": True, "reason": f"HTTP {status}"}
    if not isinstance(parsed, dict):
        return {"ok": False, "unimplemented": True, "reason": "网关应答不是 JSON 对象"}
    if parsed.get("ok") is True:
        return {"ok": True, "route": "cross-account", "detail": parsed}
    return {"ok": False, "route": "cross-account",
            "error": str(parsed.get("error") or parsed)[:200]}


# ── 参数解析（含 shell 拆分防线）─────────────────────────────

QUOTE_CHARS = ('"', "\u201c", "\u201d")  # ASCII 双引号 + PS 也当引号的中文弯引号
_RAW_OPTION_RE = r"\s+--(?:to|file|stdin|mode|steer|queue|verify-timeout|no-verify)\b"


def _die(msg: str, code: int = 2):
    print(msg, file=sys.stderr)
    sys.exit(code)


def _truncate_arg(a: str, n: int = 60) -> str:
    s = a.replace("\n", "\\n")
    return s if len(s) <= n else s[:n] + "…"


def _raw_command_line() -> str:
    """Windows: 取进程的原始命令行（PowerShell 拼给 CreateProcess 的那一串）。

    sys.argv 是 CRT 再解析后的结果——正文里的引号会在这一步被当成分隔符吞掉；
    原始命令行里它们还在。对比两者就能发现"引号被吞"（2026-10-22 事故）。
    """
    if os.name != "nt":
        return ""
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.GetCommandLineW.restype = ctypes.c_wchar_p
        return k32.GetCommandLineW() or ""
    except Exception:
        return ""


def _raw_text_segment(raw: str) -> str | None:
    """原始命令行里 --text 后面的片段（到下一个已知选项或行尾为止）。"""
    if not raw:
        return None
    m = re.search(r"(?:^|\s)--text(?=\s)", raw)
    if m is None:
        return None
    rest = raw[m.end():].lstrip()
    nxt = re.search(_RAW_OPTION_RE, rest)
    if nxt is not None:
        rest = rest[:nxt.start()]
    return rest.strip()


def _quote_count(s: str) -> int:
    return sum(s.count(c) for c in QUOTE_CHARS)


def _raw_quote_loss(seg: str, argv_text: str) -> int:
    """原始命令行里比 argv 多出来的引号数（>0 = 引号在传给 python 时被吞了）。

    PowerShell 在参数含空格时会给整个值包一层引号；这层是结构性的，先剥掉。
    """
    outer = len(seg) >= 2 and seg.startswith('"') and seg.endswith('"')
    inner = seg[1:-1] if outer else seg
    return max(0, _quote_count(inner) - _quote_count(argv_text))


def parse_args(args: list) -> dict:
    """手写解析：任何无法识别的多余片段都视为"正文被 shell 拆开"的硬错误。"""
    opts = {"to": None, "text": None, "file": None, "stdin": False,
            "mode": "steer", "verify": True, "verify_timeout": 5.0}
    leftovers = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--to", "--text", "--file", "--mode", "--verify-timeout"):
            if i + 1 >= len(args):
                _die(f"❌ {a} 缺少参数值")
            v = args[i + 1]
            if a == "--to":
                opts["to"] = v
            elif a == "--text":
                opts["text"] = v
            elif a == "--file":
                opts["file"] = v
            elif a == "--mode":
                if v not in ("queue", "steer"):
                    _die("❌ --mode 只接受 queue 或 steer")
                opts["mode"] = v
            else:
                try:
                    opts["verify_timeout"] = float(v)
                except ValueError:
                    _die("❌ --verify-timeout 需要数字（秒）")
            i += 2
            continue
        if a == "--stdin":
            opts["stdin"] = True
        elif a == "--no-verify":
            opts["verify"] = False
        elif a == "--steer":
            opts["mode"] = "steer"   # 默认值，显式写出也接受（便于日志可读）
        elif a == "--queue":
            opts["mode"] = "queue"
        elif a in ("-h", "--help"):
            print(__doc__)
            sys.exit(0)
        else:
            leftovers.append(a)
        i += 1

    if leftovers:
        shown = "\n".join(f"   [{k}] {_truncate_arg(x)!r}" for k, x in enumerate(leftovers[:8], 1))
        more = f"\n   …还有 {len(leftovers)-8} 段" if len(leftovers) > 8 else ""
        _die(
            "❌ 拒绝发送：正文被 shell 拆成了多段（这是 2026-10-22「静默截断」的同款现场）。\n"
            f"   已识别的 --text 之外还有 {len(leftovers)} 段多余参数：\n{shown}{more}\n\n"
            "   原因：Windows PowerShell 5.1 把变量传给 python.exe 时不会转义正文里的引号\n"
            "   （\" 以及中文弯引号 “ ”），参数会在引号/空格处断开；send.py 只拿到第一段，\n"
            "   旧版会静默丢弃其余片段 → 收件方正文残缺但发送端仍打印 ✅。\n\n"
            "   请改用安全通道（正文不经过命令行）：\n"
            "     python send.py --to <目标> --file <正文文件>    # 推荐\n"
            "     python send.py --to <目标> --stdin < <正文文件>\n"
            "   或直接用 myco MCP 的 send_message 工具。"
        )

    sources = sum(x is not None and x != "" for x in (opts["text"], opts["file"])) + int(opts["stdin"])
    if sources == 0:
        _die("❌ 需要正文来源：--text（短句）/ --file <文件> / --stdin")
    if sources > 1:
        _die("❌ --text / --file / --stdin 只能选一个")
    if not opts["to"]:
        _die("❌ 需要 --to <会话名或 sessionId>")

    if opts["text"] is not None and os.name == "nt":
        # sys.argv 里已经没有"被吞掉的引号"了，必须回到原始命令行去比对。
        seg = _raw_text_segment(_raw_command_line())
        if seg is not None:
            lost = _raw_quote_loss(seg, opts["text"])
            if lost:
                _die(
                    f"❌ 拒绝发送：原始命令行里有 {lost} 个引号在传给 python 时被 PowerShell 吞掉了。\n"
                    "   PowerShell 5.1 不会转义 --text 里的 \" / “ / ”；它们会被当成分隔符，\n"
                    "   正文可能已经变了而不是报错（2026-10-22 静默截断事故同源）。\n"
                    "   请改用 --file <正文文件> 或 --stdin（正文不经过命令行）。"
                )
        else:
            bad = [c for c in QUOTE_CHARS if c in opts["text"]]
            if bad:
                _die(
                    "❌ 拒绝发送：--text 里含有引号（" + "、".join(repr(c) for c in bad) + "）。\n"
                    "   Windows PowerShell 5.1 在此处会拆参数/吞引号，导致收件方正文静默截断\n"
                    "   （2026-10-22 事故：1210/619/408/784 字符，断点都在引号处）。\n"
                    "   请改用 --file <正文文件> 或 --stdin（正文不经过命令行）。"
                )
    return opts


def read_content(opts: dict) -> str:
    if opts["stdin"]:
        data = sys.stdin.buffer.read()
        return data.decode("utf-8", "replace")
    if opts["file"] is not None:
        fn = opts["file"]
        if fn == "-":
            return sys.stdin.buffer.read().decode("utf-8", "replace")
        with open(fn, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read()
    return opts["text"] or ""


# ── 投递与输出 ───────────────────────────────────────────────

def deliver_local(target: dict, full_text: str, header: str, opts: dict):
    """本机 DSH RPC 投递 + 落库校验 + 打印（原 main 的本地分支，逻辑原样搬出）。"""
    target_sid = target.get("sessionId", "")
    target_name = target.get("title") or target.get("name") or "?"
    send_started_ms = int(time.time() * 1000)
    result = send_local(target_sid, full_text, opts["mode"])
    status = "✅" if result.get("ok") else "❌"
    if not result.get("ok"):
        print(f"{status} → {target_name}({id8(target_sid)}) [local-dsh-rpc]")
        print(json.dumps(result, ensure_ascii=False, indent=1)[:300])
        sys.exit(1)

    # 默认从收件方日志验证真实落库文本（不以"发送端 ✅ / RPC ok"为准）
    if opts["verify"]:
        v = verify_delivery(target_sid, full_text, header, opts["verify_timeout"],
                            since_ms=send_started_ms - 200)
        if v["status"] == "exact":
            print(f"{status} → {target_name}({id8(target_sid)}) [local-dsh-rpc] "
                  f"mode={opts['mode']} chars={len(full_text)} "
                  f"bytes={len(full_text.encode('utf-8'))} verified=yes")
        elif v["status"] == "truncated":
            print(
                f"❌ → {target_name}({id8(target_sid)}) [local-dsh-rpc] 送达不完整："
                f"发送 {len(full_text)} 字符，收件方落库 {v['received_chars']} 字符\n"
                f"   收件方尾部：{v.get('received_tail', '')!r}\n"
                f"   日志证据：{v.get('path')}\n"
                "   这说明正文在进入 send.py 之前/传输途中被改写了。请改用 --stdin 重发并保留本条证据。",
                file=sys.stderr,
            )
            sys.exit(1)
        else:
            print(f"{status} → {target_name}({id8(target_sid)}) [local-dsh-rpc] "
                  f"chars={len(full_text)} bytes={len(full_text.encode('utf-8'))} "
                  f"⚠️ 未验证（{v.get('reason')}）")
    else:
        print(f"{status} → {target_name}({id8(target_sid)}) [local-dsh-rpc] "
              f"chars={len(full_text)}（--no-verify，未校验收件方落库文本）")


def deliver_cross_account(to_did: str, to_desc: str, body: str, opts: dict,
                          from_name: str, from_did: str, session_id: str = ""):
    """跨账号投递 + 打印。/api/msg/route 不可用时优雅降级（一句话 + 退出码 1）。"""
    result = send_cross_account(to_did, body, opts["mode"], from_name, from_did,
                                session_id)
    if result.get("unimplemented"):
        print("❌ 跨账号消息路由暂不可用（myco 网关未实现 /api/msg/route），消息未发送",
              file=sys.stderr)
        print(f"   目标：{to_desc}", file=sys.stderr)
        print(f"   探测：{result.get('reason', '?')}", file=sys.stderr)
        sys.exit(1)
    if not result.get("ok"):
        print(f"❌ → {to_desc} [cross-account] {result.get('error', '?')}", file=sys.stderr)
        sys.exit(1)
    detail = result.get("detail") or {}
    via = detail.get("via", "?")
    sess = detail.get("sessionId", "")
    line = (f"✅ → {to_desc} [cross-account via={via}] mode={opts['mode']} "
            f"chars={len(body)}")
    if sess:
        line += f" sessionId={sess}"
    if detail.get("delivered") is False:
        line += "（delivered=false：已受理但未直投，等对方上线）"
    print(line)


def deliver_share(entry: dict, text: str, opts: dict, from_name: str, from_did: str):
    """分享任务路由：owner DID（+绑定会话）→ /api/msg/route（任务路由表 §5.1）。"""
    owner = entry.get("ownerDid") or ""
    if not owner:
        _die(f"❌ 分享 {entry['shareId']}（{entry['displayName']}）没有 ownerAccount，"
             "无法跨账号路由。")
    bound = entry.get("boundSessionId") or ""
    desc = f"{entry['displayName']}({entry['shareId']} → owner {_short_did(owner)})"
    deliver_cross_account(owner, desc, text, opts, from_name, from_did, session_id=bound)


def _available_hint(directory: list, notes: dict) -> str:
    """报错时附带的可用目标清单（复用 format_directory 渲染，缩进对齐 ❌ 消息）。"""
    body = format_directory(directory, notes)
    if not body:
        return "   （当前清单为空：好友/分享数据源不可达，本机也没有会话）"
    return "   当前可用目标（--list 随时查看）：\n" + "\n".join(
        "   " + line for line in body.split("\n"))


# ── 主入口 ───────────────────────────────────────────────────

def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    # --list：打印协作智能体清单（好友 / 分享任务 / 本机会话；数据层同 directory.js）
    if args[0] == "--list":
        sessions = get_sessions()
        friends, meta = get_friends()
        shares = get_shares()
        entries, notes = build_directory(friends, shares, sessions, meta.get("myDid", ""))
        grep = None
        if "--grep" in args:
            i = args.index("--grep")
            if i + 1 < len(args):
                grep = args[i + 1]
        body = format_directory(entries, notes)
        if grep:
            g = grep.lower()
            hits = [e for e in entries
                    if g in (e.get("displayName") or "").lower()
                    or (e["kind"] == "share" and g in e["shareId"].lower())
                    or (e["kind"] == "session" and g in e["sessionId"].lower())]
            body = format_directory(hits, {}) if hits else "  （无匹配目标）"
        if body:
            print(body)
        n_friend = sum(1 for e in entries if e["kind"] == "friend")
        n_share = sum(1 for e in entries if e["kind"] == "share")
        n_sess = sum(1 for e in entries if e["kind"] == "session")
        print(f"\n  共 {len(entries)} 个可发目标（好友 {n_friend} · 分享 {n_share} · 本机会话 {n_sess}）")
        print("  发送：python send.py --to <名称或ID> --stdin")
        return

    opts = parse_args(args)
    text = read_content(opts)
    if not text.strip():
        _die("❌ 正文为空，未发送")

    # 三个数据源 → 协作清单（Agent Entry 列表，字段对齐 src/directory.js）
    sessions = get_sessions()
    friends, meta = get_friends()
    shares = get_shares()
    directory, notes = build_directory(friends, shares, sessions, meta.get("myDid", ""))

    sender_name, sender_sid = sender_info(sessions)
    from_name = meta.get("myName") or sender_name or "unknown"
    from_did = meta.get("myDid", "")

    # 手写头剥离（本地/跨账号同样生效——2026-10-23：调用方模仿接收格式手写头的
    # 误用被审计实锤 44 次，这里让它无害化：剥掉后统一用自动署名）
    text, stripped = strip_handwritten_header(text)
    if stripped:
        print(f"⚠️  检测到调用方手写消息头 {stripped} 行，已自动剥离。"
              f"规范头（[from:…]+reply-to:）由 send.py 自动生成，调用方永远不要自己写。",
              file=sys.stderr)
    header = build_header(sender_name, sender_sid)
    full_text = header + "\n" + text

    kind = classify_target(opts["to"])

    if kind == "session-id":
        # ① 本机 DSH 会话 ID：现有四级匹配 + DSH RPC 直投（路径不变）
        target = resolve_target(opts["to"], sessions)
        if target:
            deliver_local(target, full_text, header, opts)
            return
        # 查无此会话 → 保持旧行为：myco.exe 跨设备兜底
        print(f"  目标「{opts['to']}」不在本机会话清单，尝试 myco.exe 跨设备...")
        result = send_remote(opts["to"], sender_sid, full_text, opts["mode"])
        status = "✅" if result.get("ok") else "❌"
        route = result.get("route", "?")
        print(f"{status} → {opts['to']} [{route}] chars={len(full_text)}"
              "（跨设备，无法用本机会话日志校验）")
        if not result.get("ok"):
            print(f"  error: {result.get('error', '?')}")
            sys.exit(1)
        return

    if kind == "did":
        # ② 跨账号 DID：先校验在清单中（DESIGN §8 防 AI 幻觉 DID）→ /api/msg/route
        did = opts["to"].strip()
        if is_shortened_did(did):
            _die(f"❌ --to 是缩写 DID（{did}）——清单里的 z6Mk...sHaW 只是展示缩写，"
                 "无法路由。请用完整 DID，或直接用好友昵称。")
        entry = find_did_in_directory(did, directory)
        if entry is None:
            if notes.get("friend") and notes.get("share"):
                _die("❌ 好友/分享清单均不可达，无法校验 DID（防幻觉 DID 已拒绝发送）。\n"
                     "   稍后重试，或先用 --list 查看清单状态。")
            _die("❌ DID 不在协作清单中，已拒绝发送（防误投/幻觉 DID，DESIGN §8）：\n"
                 f"   {did}\n" + _available_hint(directory, notes))
        if entry["kind"] == "friend":
            desc = f"{entry['displayName']}({_short_did(did)})"
        else:
            desc = f"{entry['displayName']}({entry['shareId']} owner)"
        deliver_cross_account(did, desc, text, opts, from_name, from_did)
        return

    if kind == "share-id":
        # ③ 分享任务：查注册表拿 owner DID + 绑定会话 → /api/msg/route
        entry = find_share(opts["to"], directory)
        if entry is None:
            if notes.get("share"):
                _die("❌ 分享任务列表暂不可达（:3102/api/dshShare/list 无应答），"
                     "无法解析 shareId。稍后重试，或先用 --list 查看清单状态。")
            _die(f"❌ shareId 不在分享注册表中：{opts['to']}\n"
                 + _available_hint(directory, notes))
        deliver_share(entry, text, opts, from_name, from_did)
        return

    # ④ 名称匹配：好友昵称 → 分享任务名 → 会话标题（精确 → 包含 → 会话ID前缀）
    status, hit = resolve_via_directory(opts["to"], directory)
    if status == "ambiguous":
        print(f"❌ --to \"{opts['to']}\" 命中 {len(hit)} 个目标，为避免错投已拒绝。"
              "请改用唯一名称或对应完整 ID：", file=sys.stderr)
        for e in hit[:10]:
            print(f"     {describe_entry(e)}", file=sys.stderr)
        if len(hit) > 10:
            print(f"     …还有 {len(hit) - 10} 个", file=sys.stderr)
        sys.exit(2)
    if status == "none":
        _die(f"❌ 找不到目标 \"{opts['to']}\"。\n" + _available_hint(directory, notes))
    if hit["kind"] == "session":
        deliver_local({"sessionId": hit["sessionId"], "title": hit["sessionTitle"]},
                      full_text, header, opts)
        return
    if hit["kind"] == "friend":
        deliver_cross_account(hit["did"], f"{hit['displayName']}({_short_did(hit['did'])})",
                              text, opts, from_name, from_did)
        return
    deliver_share(hit, text, opts, from_name, from_did)


if __name__ == "__main__":
    main()
