#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh_rpc.py — 访问本机 DSH（DeepSeek Harness）的 typed RPC。

用途：会话管理（建/改名/投递）、模型与思考档切换、工作区管理。
被 ~/.agents/skills/myco/SKILL.md 引用。

用法：
  python dsh_rpc.py --detect                          # 探测 DSH 当前 RPC 端口
  python dsh_rpc.py session/modelCatalog '{}'
  python dsh_rpc.py session/selectModel '{"request":{"sessionId":"…","provider":"zai-coding-cn","model":"glm-5.3","reasoningEffort":"max"}}'
  python dsh_rpc.py session/create '{"request":{"cwd":"D:\\\\proj","workspaceId":"…"}}'
  python dsh_rpc.py session/rename '{"request":{"sessionId":"…","title":"名字"}}'
  python dsh_rpc.py session/prompt '{"request":{"requestId":"x1","sessionId":"…","mode":"queue","content":[{"type":"text","text":"正文"}]}}'
  python dsh_rpc.py workspace/create '{"request":{"path":"D:\\\\proj"}}'
  python dsh_rpc.py workspace/rename '{"request":{"workspaceId":"…","title":"显示名"}}'

原理：
  - DSH 桌面版每次启动端口可能变化（2026-10-17 实测 19387 → 55802）。
    本脚本用 tasklist+netstat 找 "DeepSeek Harness" 进程的监听口，用自签 cookie
    探 GET / == 200 来确认哪个口是 DSH web/RPC。
  - cookie 是 DSH 的 browser-session 自签（secret 在 ~/.dsh/.credentials.yaml 的
    client-connection/browser-session 记录的 secret: 字段，base64url-no-pad 32B）。
    authority 必须等于 "127.0.0.1:<端口>"，否则 401。
  - 应答是 chunked JSON（server-response 信封），脚本已解码。
"""
import base64
import hashlib
import hmac
import json
import os
import socket
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CREDS = os.path.join(HOME, ".dsh", ".credentials.yaml")
PROC_NAME = "DeepSeek Harness"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def read_secret() -> bytes:
    txt = open(CREDS, "r", encoding="utf-8").read()
    in_rec = False
    for line in txt.splitlines():
        l = line.rstrip()
        if l.lstrip().startswith("client-connection/browser-session:"):
            in_rec = True
            continue
        if not in_rec:
            continue
        if not l.startswith("    ") and l.strip():
            in_rec = False
            continue
        s = l.strip()
        if s.startswith("secret:"):
            return b64u_dec(s[len("secret:"):].strip())
    raise SystemExit("读不到 DSH browser-session secret（~/.dsh/.credentials.yaml）")


def mint(authority: str) -> str:
    now = int(time.time() * 1000)
    payload = {"version": 1, "authority": authority, "issuedAt": now,
               "expiresAt": now + 30 * 24 * 3600 * 1000}
    body = b64u(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    sig = hmac.new(read_secret(), body.encode(), hashlib.sha256).digest()
    return "dsh-auth-" + b64u(hashlib.sha256(authority.encode()).digest()) + "=v1." + body + "." + b64u(sig)


def _run(cmd: str) -> str:
    try:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=20)
        return (out.stdout or "") + (out.stderr or "")
    except Exception:
        return ""


def candidate_ports():
    ports = []
    env_port = os.environ.get("DSH_NATIVE_PORT")
    if env_port and env_port.isdigit():
        ports.append(int(env_port))
    # tasklist 找 DSH 进程 pid
    pids = set()
    for line in _run('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /FO CSV /NH').splitlines():
        parts = [p.strip('" ') for p in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            pids.add(parts[1])
    # netstat 找这些 pid 的监听口（只取回环）
    for line in _run("netstat -ano -p TCP").splitlines():
        f = line.split()
        if len(f) < 5 or f[3] != "LISTENING":
            continue
        if f[1].startswith(("127.0.0.1:", "0.0.0.0:")) and f[4] in pids:
            try:
                ports.append(int(f[1].split(":")[-1]))
            except ValueError:
                pass
    for legacy in (19387, 55802):
        ports.append(legacy)
    seen, uniq = set(), []
    for p in ports:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def http(port: int, method: str, path: str, body: bytes = b"", with_cookie: bool = True, timeout: float = 60):
    authority = f"127.0.0.1:{port}"
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    lines = [f"{method} {path} HTTP/1.1", f"Host: {authority}"]
    if with_cookie:
        lines.append(f"cookie: {mint(authority)}")
    lines.append(f"origin: http://{authority}")
    lines.append("accept: */*")
    if body:
        # body 必须是 bytes，len() 才是 UTF-8 字节数；若按 str 的字符数算 Content-Length，
        # 中文（3 字节/字）会被服务端截成约 1/3 —— 2026-10-22 曾误判为截断根因，已实测排除。
        lines += ["content-type: application/json", f"Content-Length: {len(body)}"]
    lines.append("Connection: close")
    s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode() + body)
    chunks = []
    while True:
        c = s.recv(1 << 16)
        if not c:
            break
        chunks.append(c)
    s.close()
    raw = b"".join(chunks)
    head, _, rest = raw.partition(b"\r\n\r\n")
    hdr = head.decode("utf-8", "replace")
    status = hdr.split("\r\n")[0]
    if "chunked" in hdr.lower():
        out = bytearray()
        while rest:
            i = rest.find(b"\r\n")
            if i < 0:
                break
            try:
                size = int(rest[:i], 16)
            except ValueError:
                break
            if size == 0:
                break
            out += rest[i + 2:i + 2 + size]
            rest = rest[i + 2 + size + 2:]
        data = bytes(out)
    else:
        data = rest
    return status, data


def detect():
    """返回 (port, status) —— 能通过 cookie 探活的那个 DSH 口。

    2026-10-17 实测：DSH 有**间歇 401 忙窗**（高负载时几秒一轮），单次失败（401/超时）
    不能定论。实测 401/401/200 连续出现，所以给足 ~50s 退避窗口。
    """
    last = None
    for _ in range(25):
        for p in candidate_ports():
            try:
                st, data = http(p, "GET", "/", with_cookie=True, timeout=8)
                if "200" in st and b"<" in data[:200]:
                    return p, st
                last = (p, st)
            except Exception as e:
                last = (p, f"{type(e).__name__}: {e}")
        time.sleep(2)
    raise SystemExit(f"探测不到 DSH RPC 端口（DSH 未运行？或一直撞 401 忙窗）last={last}")


def rpc(method: str, args: dict, port: int = None, retries: int = 8):
    """typed RPC。2026-10-19：DSH 有**间歇 401 窗口**（实测 40 次采样 2 次连挂、myco 侧
    连挂过 5 次/8s；body 是 `unauthorized`）——不是我们的 cookie 坏了，是 DSH 鉴权子系统
    短时不可用。原实现 4 次×2s（~8s）窗口稍长就失败；改为指数退避 ~11s，
    且失败时给出**确定性**结论（调用方可重试，不会挂成"客户端超时"）。"""
    if port is None:
        port, _ = detect()
    last = None
    delays = [0.3, 0.5, 1, 1.5, 2, 3, 3]
    for attempt in range(retries):
        body = json.dumps({"type": "client-request", "rpcId": f"cli{int(time.time()*1000)%1000000}",
                           "method": method, "payload": {"args": args}},
                          ensure_ascii=False, separators=(",", ":")).encode()
        try:
            st, data = http(port, "POST", f"/api/{method}", body=body)
            if "401" in st:
                last = (st, data)
                wait = delays[min(attempt, len(delays) - 1)]
                sys.stderr.write(f"[dsh-rpc] 401 忙窗（第 {attempt + 1} 次），{wait}s 后重试\n")
                time.sleep(wait)
                continue
            return json.loads(data.decode("utf-8", "replace"))
        except Exception as e:
            last = ("EXC", str(e).encode())
            wait = delays[min(attempt, len(delays) - 1)]
            sys.stderr.write(f"[dsh-rpc] 调用异常（第 {attempt + 1} 次）：{e}；{wait}s 后重试\n")
            time.sleep(wait)
    raise SystemExit(
        f"RPC 失败（{method}）：DSH 短时忙窗（401 鉴权子系统不可用）或连接异常，"
        f"已重试 {retries} 次仍未通过 —— 等 ≥5s 后重试即可（不是 cookie/签名坏了）。last={last}"
    )


def main():
    # Windows 控制台默认 GBK：应答里含中文/emoji 时 print 会 UnicodeEncodeError → 统一转 UTF-8
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(sys.argv) >= 2 and sys.argv[1] == "--detect":
        port, st = detect()
        print(json.dumps({"ok": True, "port": port, "status": st}, ensure_ascii=False))
        return
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    method = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    port, _ = detect()
    res = rpc(method, args, port=port)
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
