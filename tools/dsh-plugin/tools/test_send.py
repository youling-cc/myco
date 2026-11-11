#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""send.py 回归自测（不联网）：shell 拆分防线 + 收件方日志校验。

跑法：
  python ~/.agents/skills/myco/test_send.py
"""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import send  # noqa: E402


class ParseArgsTests(unittest.TestCase):
    def _reject(self, args):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            send.parse_args(args)
        self.assertEqual(cm.exception.code, 2)
        return err.getvalue()

    def test_safe_short_text(self):
        o = send.parse_args(["--to", "x", "--text", "hello"])
        self.assertEqual(o["text"], "hello")
        # 2026-10-28 jason 令：默认改插队（steer），排队必须显式 --queue
        self.assertEqual(o["mode"], "steer")

    def test_leftover_fragments_rejected(self):
        # PowerShell 把 "把"自研传输"的问题" 拆成多段后的现场
        msg = self._reject(["--to", "x", "--text", "前缀", "自研传输", "的问题", "后半段"])
        self.assertIn("拒绝发送", msg)
        self.assertIn("--file", msg)

    @unittest.skipUnless(os.name == "nt", "quote guard is Windows-specific")
    def test_ascii_quote_rejected(self):
        msg = self._reject(["--to", "x", "--text", '他说"你好"'])
        self.assertIn("引号", msg)

    @unittest.skipUnless(os.name == "nt", "quote guard is Windows-specific")
    def test_smart_quote_rejected(self):
        self._reject(["--to", "x", "--text", "他说“你好”"])

    def test_file_and_stdin(self):
        self.assertEqual(send.parse_args(["--to", "x", "--file", "a.txt"])["file"], "a.txt")
        self.assertTrue(send.parse_args(["--to", "x", "--stdin"])["stdin"])

    def test_one_source_only(self):
        msg = self._reject(["--to", "x", "--file", "a.txt", "--stdin"])
        self.assertIn("只能选一个", msg)

    def test_mode_validation(self):
        self.assertEqual(send.parse_args(["--to", "x", "--file", "a", "--mode", "steer"])["mode"],
                         "steer")
        self._reject(["--to", "x", "--file", "a", "--mode", "now"])

    def test_default_is_steer_queue_requires_flag(self):
        # 默认不写任何模式 = 插队
        self.assertEqual(send.parse_args(["--to", "x", "--file", "a"])["mode"], "steer")
        # --queue 显式排队
        self.assertEqual(send.parse_args(["--to", "x", "--file", "a", "--queue"])["mode"], "queue")
        # --mode queue 等价
        self.assertEqual(send.parse_args(["--to", "x", "--file", "a", "--mode", "queue"])["mode"],
                         "queue")
        # --steer 与默认一致（保留给日志可读）
        self.assertEqual(send.parse_args(["--to", "x", "--file", "a", "--steer"])["mode"], "steer")


class RawQuoteLossTests(unittest.TestCase):
    def test_ascii_quote_swallowed(self):
        self.assertEqual(send._raw_quote_loss('他说"你好"', "他说你好"), 2)

    def test_structural_pair_not_loss(self):
        self.assertEqual(send._raw_quote_loss('"a b c"', "a b c"), 0)

    def test_inner_quotes_in_quoted_value(self):
        self.assertEqual(send._raw_quote_loss('"他说"你好""', "他说你好"), 2)

    def test_intact_smart_quotes(self):
        self.assertEqual(send._raw_quote_loss("他说“你好”再见", "他说“你好”再见"), 0)


class LogVerifyTests(unittest.TestCase):
    """用合成的 v4 会话日志验证 exact / truncated / unknown 判定。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "session.v4.jsonl.zstd")
        self.orig_find = send.find_session_log
        send.find_session_log = lambda sid: self.path

    def tearDown(self):
        send.find_session_log = self.orig_find
        self.tmp.cleanup()

    def _write_events(self, texts):
        import zstandard
        frames = []
        for i, (t, text) in enumerate(texts):
            ev = {
                "type": "agent/inbox/spliced", "seq": i, "time": t,
                "data": {"target": "next-turn", "start": 0,
                         "inserted": [{"id": f"m{i}", "content": [{"type": "text", "text": text}]}]},
            }
            frames.append(zstandard.ZstdCompressor().compress(
                (json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8")))
        with open(self.path, "wb") as f:
            for fr in frames:
                f.write(fr)

    def test_exact(self):
        header = send.build_header("tester", "session-abc")
        full = header + "\n" + "正文" * 100
        self._write_events([(1000, "older"), (2000, full)])
        v = send.verify_delivery("session-x", full, header, timeout=0.1, since_ms=1500)
        self.assertEqual(v["status"], "exact")

    def test_truncated(self):
        header = send.build_header("tester", "session-abc")
        full = header + "\n" + "正文" * 100
        self._write_events([(2000, full[:40])])
        v = send.verify_delivery("session-x", full, header, timeout=0.1, since_ms=1500)
        self.assertEqual(v["status"], "truncated")
        self.assertEqual(v["received_chars"], 40)

    def test_old_message_is_not_truncation(self):
        header = send.build_header("tester", "session-abc")
        self._write_events([(1000, header + "\n旧消息")])
        v = send.verify_delivery("session-x", header + "\n新消息", header, timeout=0.1,
                                 since_ms=1500)
        self.assertEqual(v["status"], "unknown")

    def test_concatenated_frames(self):
        self._write_events([(1000, "a" * 10), (2000, "b" * 20)])
        self.assertEqual(send._last_inbox_text(self.path, 0), "b" * 20)


class StripHeaderTests(unittest.TestCase):
    """2026-10-23：手写消息头剥离（审计实锤 44 次手写、36 条原样投达后的防御）。"""

    def test_old_style_via_myco_stripped(self):
        body = "[from: 有灵线上运维 via myco]\nreply-to: session-fake-0000\n\n正文第一行\n正文第二行"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 2)
        self.assertTrue(clean.startswith("正文第一行"), clean)
        self.assertNotIn("via myco", clean)
        self.assertNotIn("reply-to", clean.split("\n")[0])

    def test_canonical_style_stripped_too(self):
        body = "[from: 某会话 · 10-23 13:00]\nreply-to: session-12345678-1234\n只留正文"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 2)
        self.assertEqual(clean, "只留正文")

    def test_clean_body_untouched(self):
        body = "普通正文，没有头\n第二行"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 0)
        self.assertEqual(clean, body)

    def test_mid_text_header_not_stripped(self):
        """正文中间讨论消息格式的同款文本不动（只剥开头连续头）。"""
        body = "我在说格式：\n[from: 别人 · 10-23 12:00]\n这是引用示例"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 0)
        self.assertIn("[from: 别人", clean)

    def test_route_label_fullwidth_stripped(self):
        """2026-10-23 现场：DSH协议应用 正文开头手写【A → B】路由标签——与自动头重复，剥。

        现场真实形态是**行前缀**（标签和正文同一行）：只剥前缀、保留正文。
        """
        body = "【DSH协议应用 → 有灵myco】B1 干扰预警：正文开始"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 1)
        self.assertEqual(clean, "B1 干扰预警：正文开始")

    def test_route_label_standalone_line_stripped(self):
        """独立成行的标签整行剥。"""
        body = "【DSH协议应用 → 有灵myco】\nB1 干扰预警：正文开始"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 1)
        self.assertEqual(clean, "B1 干扰预警：正文开始")

    def test_route_label_halfwidth_stripped(self):
        body = "[A → B]\n正文"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 1)
        self.assertEqual(clean, "正文")

    def test_route_label_no_arrow_kept(self):
        """不含 → 的【重要】等正常括号内容不剥。"""
        body = "【重要】这个不是路由标签"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 0)
        self.assertEqual(clean, body)

    def test_mixed_header_and_route_label(self):
        """手写头 + 路由标签混排（任意顺序）全剥。"""
        body = "[from: 假冒者 via myco]\n\n【A → B】\n\n真正的正文"
        clean, n = send.strip_handwritten_header(body)
        self.assertEqual(n, 2)
        self.assertEqual(clean, "真正的正文")


class ClassifyTargetTests(unittest.TestCase):
    """--to 四种格式的优先级识别（DESIGN §4.3/§5.1）。"""

    def test_session_id(self):
        self.assertEqual(send.classify_target("session-55babc93-1234-5678"), "session-id")

    def test_did(self):
        self.assertEqual(send.classify_target("did:youling:z6Mkabc"), "did")
        self.assertEqual(send.classify_target("DID:youling:z6Mkabc"), "did")
        self.assertEqual(send.classify_target("did:myco:z6Mkabc"), "did")

    def test_share_id(self):
        self.assertEqual(send.classify_target("sh-pc-env-rdp"), "share-id")

    def test_name(self):
        self.assertEqual(send.classify_target("小王"), "name")
        self.assertEqual(send.classify_target("申诉管理"), "name")

    def test_shortened_did_detected(self):
        self.assertTrue(send.is_shortened_did("did:youling:z6Mk...sHaW"))
        self.assertFalse(send.is_shortened_did("did:youling:z6Mkfull"))


class BuildDirectoryTests(unittest.TestCase):
    """Python 版清单数据层（对齐 src/directory.js 的条目构建与过滤）。"""

    FRIENDS = [
        {"did": "did:youling:AA", "name": "小王", "status": "ok"},
        {"did": "did:youling:BB", "name": "待确认", "status": "ok", "pending": True},
    ]
    SHARES = [
        {"shareId": "sh-1", "title": "任务A", "state": "active",
         "ownerAccount": "did:youling:ME"},
        {"shareId": "sh-2", "title": "已关闭", "state": "closed"},
        {"shareId": "sh-3", "title": "原始名", "customName": "改名", "state": "active",
         "sessionId": "session-x", "ownerAccount": "did:youling:AA"},
    ]
    SESSIONS = [{"sessionId": "session-s1", "title": "申诉管理"}]

    def test_entries_and_filtering(self):
        entries, notes = send.build_directory(self.FRIENDS, self.SHARES,
                                              self.SESSIONS, "did:youling:ME")
        self.assertEqual(notes, {})
        friends = [e for e in entries if e["kind"] == "friend"]
        shares = [e for e in entries if e["kind"] == "share"]
        sess = [e for e in entries if e["kind"] == "session"]
        self.assertEqual(len(friends), 1)          # pending 好友被过滤
        self.assertEqual(len(shares), 2)           # closed 分享被过滤
        self.assertEqual(len(sess), 1)
        sh1 = next(e for e in shares if e["shareId"] == "sh-1")
        self.assertEqual(sh1["myRole"], "owner")
        sh3 = next(e for e in shares if e["shareId"] == "sh-3")
        self.assertEqual(sh3["displayName"], "改名")   # 自定义名 > 任务卡原始名
        self.assertEqual(sh3["boundSessionId"], "session-x")
        self.assertEqual(sh3["myRole"], "collaborator")

    def test_unreachable_sources_noted(self):
        entries, notes = send.build_directory(None, None, [], "")
        self.assertEqual(entries, [])
        self.assertTrue(notes["friend"])
        self.assertTrue(notes["share"])
        self.assertNotIn("session", notes)

    def test_format_directory_renders_sections(self):
        entries, notes = send.build_directory(self.FRIENDS, self.SHARES,
                                              self.SESSIONS, "did:youling:ME")
        text = send.format_directory(entries, notes)
        self.assertIn("好友：", text)
        self.assertIn("分享任务：", text)
        self.assertIn("本机其他会话：", text)
        self.assertIn("owner=我", text)            # sh-1 owner=我
        self.assertIn("绑定会话=session-x", text)   # sh-3
        self.assertIn("无绑定会话", text)           # sh-1


class ResolveViaDirectoryTests(unittest.TestCase):
    """名称匹配（好友昵称 → 分享任务名 → 会话标题；精确 → 包含 → 会话ID前缀）。"""

    DIR = [
        {"kind": "friend", "did": "did:youling:AA", "nickname": "小王",
         "online": True, "displayName": "小王"},
        {"kind": "share", "shareId": "sh-1", "displayName": "【PC远程桌面】",
         "taskTitle": "【PC远程桌面】", "customName": "", "boundSessionId": "",
         "ownerDid": "did:youling:AA", "myRole": "owner"},
        {"kind": "session", "sessionId": "session-aaa1", "sessionTitle": "申诉管理",
         "displayName": "申诉管理"},
        {"kind": "session", "sessionId": "session-aaa2", "sessionTitle": "抽检管理",
         "displayName": "抽检管理"},
    ]

    def test_exact_friend(self):
        st, e = send.resolve_via_directory("小王", self.DIR)
        self.assertEqual((st, e["kind"]), ("resolved", "friend"))

    def test_exact_beats_fuzzy(self):
        # "小王" 精确命中好友；"小王的会话" 只是包含命中——精确档优先，不算歧义
        d = self.DIR + [{"kind": "session", "sessionId": "session-z",
                         "sessionTitle": "小王的会话", "displayName": "小王的会话"}]
        st, e = send.resolve_via_directory("小王", d)
        self.assertEqual((st, e["kind"]), ("resolved", "friend"))

    def test_fuzzy_unique_session(self):
        st, e = send.resolve_via_directory("申诉", self.DIR)
        self.assertEqual((st, e["kind"]), ("resolved", "session"))

    def test_ambiguous_within_kind(self):
        st, hits = send.resolve_via_directory("管理", self.DIR)
        self.assertEqual(st, "ambiguous")
        self.assertEqual(len(hits), 2)

    def test_ambiguous_across_kinds(self):
        # 同名跨类目（好友"小王" + 分享"小王"）→ 列候选退出，不盲选
        d = self.DIR + [{"kind": "share", "shareId": "sh-9", "displayName": "小王",
                         "taskTitle": "小王", "customName": "", "boundSessionId": "",
                         "ownerDid": "did:youling:CC", "myRole": "collaborator"}]
        st, hits = send.resolve_via_directory("小王", d)
        self.assertEqual(st, "ambiguous")
        self.assertEqual({e["kind"] for e in hits}, {"friend", "share"})

    def test_session_id_prefix_tier(self):
        st, e = send.resolve_via_directory("session-aaa1", self.DIR)
        self.assertEqual((st, e["kind"]), ("resolved", "session"))

    def test_none(self):
        st, _ = send.resolve_via_directory("根本不存在", self.DIR)
        self.assertEqual(st, "none")


class FindTargetTests(unittest.TestCase):
    """DID / shareId 反查（DESIGN §8 防 AI 幻觉 DID）。"""

    def test_find_friend_did(self):
        e = send.find_did_in_directory("did:youling:AA", ResolveViaDirectoryTests.DIR)
        self.assertIsNotNone(e)
        self.assertEqual(e["kind"], "friend")

    def test_find_owner_did(self):
        e = send.find_did_in_directory("did:youling:AA", ResolveViaDirectoryTests.DIR)
        # 好友优先返回；owner-only DID 也能查到：
        d = [{"kind": "share", "shareId": "sh-1", "displayName": "x",
              "ownerDid": "did:youling:ZZ", "myRole": "collaborator",
              "boundSessionId": ""}]
        e2 = send.find_did_in_directory("did:youling:ZZ", d)
        self.assertEqual(e2["kind"], "share")

    def test_unknown_did_rejected(self):
        self.assertIsNone(send.find_did_in_directory("did:youling:GHOST",
                                                     ResolveViaDirectoryTests.DIR))

    def test_find_share(self):
        e = send.find_share("sh-1", ResolveViaDirectoryTests.DIR)
        self.assertEqual(e["displayName"], "【PC远程桌面】")
        self.assertIsNone(send.find_share("sh-nope", ResolveViaDirectoryTests.DIR))


class CrossAccountTests(unittest.TestCase):
    """send_cross_account：/api/msg/route 契约 + 优雅降级（不联网，monkeypatch urlopen）。"""

    def setUp(self):
        import urllib.request as ur
        self._ur = ur
        self._real_urlopen = ur.urlopen

    def tearDown(self):
        self._ur.urlopen = self._real_urlopen

    def _patch(self, fn):
        self._ur.urlopen = fn

    def test_unreachable_degrades(self):
        import urllib.error
        def boom(req, timeout=None):
            raise urllib.error.URLError("refused")
        self._patch(boom)
        r = send.send_cross_account("did:youling:AA", "正文", "steer", "小王", "did:youling:ME")
        self.assertFalse(r["ok"])
        self.assertTrue(r["unimplemented"])   # 降级标记：调用方打印"暂不可用"并退出 1

    def test_404_degrades(self):
        import urllib.error
        def not_found(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", None, None)
        self._patch(not_found)
        r = send.send_cross_account("did:youling:AA", "正文", "steer", "小王", "did:youling:ME")
        self.assertFalse(r["ok"])
        self.assertTrue(r["unimplemented"])
        self.assertIn("404", r["reason"])

    def test_success(self):
        class Resp:
            status = 200
            def read(self):
                return b'{"ok":true,"delivered":true,"sessionId":"session-x","via":"p2p-direct"}'
        self._patch(lambda req, timeout=None: Resp())
        r = send.send_cross_account("did:youling:AA", "正文", "steer", "小王",
                                    "did:youling:ME", session_id="session-x")
        self.assertTrue(r["ok"])
        self.assertEqual(r["detail"]["via"], "p2p-direct")

    def test_gateway_business_error(self):
        class Resp:
            status = 200
            def read(self):
                return b'{"ok":false,"error":"\xe5\xaf\xb9\xe6\x96\xb9\xe4\xb8\x8d\xe5\x9c\xa8\xe7\xba\xbf"}'
        self._patch(lambda req, timeout=None: Resp())
        r = send.send_cross_account("did:youling:AA", "正文", "steer", "小王", "did:youling:ME")
        self.assertFalse(r["ok"])
        self.assertNotIn("unimplemented", r)   # 网关真实回包 ≠ 端点未实现
        self.assertEqual(r["error"], "对方不在线")


class ResolveAmbiguityTests(unittest.TestCase):
    """2026-10-23：模糊匹配歧义防御（旧行为"取第一个"会静默错投）。"""

    SESS = [
        {"sessionId": "session-aaa1", "title": "申诉管理"},
        {"sessionId": "session-aaa2", "title": "抽检管理"},
        {"sessionId": "session-aaa3", "title": "你是 申诉管理（Lead）派出的"},
    ]

    def test_exact_id_wins(self):
        self.assertEqual(send.resolve_target("session-aaa2", self.SESS)["title"], "抽检管理")

    def test_exact_title_unique(self):
        self.assertEqual(send.resolve_target("抽检管理", self.SESS)["title"], "抽检管理")

    def test_fuzzy_multi_rejected(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as cm:
            send.resolve_target("管理", self.SESS)
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("命中 3 个", err.getvalue())

    def test_fuzzy_single_ok(self):
        sess = [{"sessionId": "session-b1", "title": "投诉处理"}]
        self.assertEqual(send.resolve_target("投诉", sess)["title"], "投诉处理")

    def test_no_match_returns_none(self):
        self.assertIsNone(send.resolve_target("不存在的人", self.SESS))


if __name__ == "__main__":
    unittest.main(verbosity=2)
