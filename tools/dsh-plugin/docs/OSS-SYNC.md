# 开源仓同步规则（DSH 插件）

> 权威源：本仓库 `dsh-plugin-identity/`（`D:\Projects\labs\myco` 的 worktree，分支 `feat/myco-cli-pc`）
> 发布目标：`github.com/youling-cc/myco` → `tools/dsh-plugin/`
> 维护方：DSH插件会话（session-181a6a6d）· 对接：有灵开源会话（session-92007bec）

## 1. 同步方式：快照拷贝（权威在我，发布在开源仓）

- 插件与 DSH 宿主 / myco 网关契约强耦合，真机验证在我这边做；开源仓只做发布。
- 两份都维护必然漂移，因此**不双写**。
- 我每次里程碑更新 → 给开源会话一条消息：`commit hash` + 相对上次的**变更文件清单**；他按需重拷。

## 2. 进 / 不进开源仓

**进**：
```
src/            （10 个源文件）
locale/         （zh/en）
scripts/build.mjs
test/           （单测 + fixtures + snapshots；**不含** test/e2e/evidence*）
tools/          send.py / dsh_rpc.py / mcp-server.mjs / test_send.py / mint_cookie.py
docs/           PA-ARCHITECTURE-FINAL.md / DESIGN-agent-directory.md /
                JUDGE-ENGINE-porting-notes.md / OOM-EVIDENCE-20261112.md
package.json / README.md / cordis.patch.yml / icon.svg / LICENSE
eval/vnet/judge-vectors.json（若开源仓统一收 eval/）
```

**不进**：
```
lib/                构建产物（.gitignore）
package-lock.json   ⚠️ 见 §4（建议改为提交）
INSTALL-PLAN.md     内部安装计划（含本机路径/pid/端口）
preview-identity.mjs 本地预览脚本
test/e2e/evidence*/ 真实会话证据（含 session id）
tools/probe-*.py    一次性探测脚本
tools/append-vectors.mjs  开发机专用（向量生成器）
```

## 3. 导出管道的 4 处"清洗替换"（**回填时跳过**）

开源导出会把本机路径/用户名中性化（业务代码零改动）：

| 本仓（内部） | 开源仓（中性化） |
|---|---|
| `D:/Projects/labs/<worktree>` | `repo-a/labs` |
| `Users\<user>` | `Users\you` |
| （另有 2 处同类路径/用户名） | 同上风格 |

**规则**：从开源仓回流代码时，**忽略这 4 处 diff**，不要把中性化路径拉回内部仓（否则本机测试/真 host 直接失效）。
判别方法：`git diff` 里只涉及这两类字符串的改动 → 跳过；其余才是真实业务 diff。

## 4. 待办：可复现构建

开源仓当前 `npm install` 51 包但**锁文件未提交** → esbuild / vitest 版本可能漂移，导致 `build: OK` 或测试行为不一致。
**建议提交 `package-lock.json`**（或改用 `pnpm-lock.yaml`），保证任何机器 `npm ci` 后一致。

## 5. 验证清单（每次同步后开源仓须跑）

```bash
node scripts/build.mjs            # 必须以 "build: OK" 结尾（缺这行=构建被截断，禁止发布）
node test/judge-vectors.test.js   # 15 向量 / 28 用例逐位一致
node test/web-listener.test.js    # 19 用例
node test/policy-proxy.test.js    # 11 用例
```

## 6. 历史

- 2026-11-12：仓库 `a25b753e` → 开源仓 `7de0a24`（35 文件），三项验证全过；发现并修复硬编码路径（`judge-vectors.test.js` 改多候选相对解析）。
