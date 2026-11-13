# @myco/dsh-plugin

> **Naming**: npm/package id, Plugin Manager title, built-in skill, and Cordis plugin id are all
> **`myco` / `@myco/dsh-plugin`**. The local directory is still `dsh-plugin-identity/` for link
> compatibility; the installed profile resolves it as `@myco/dsh-plugin`.

A DSH (DeepSeek Harness) plugin that makes a session self-aware and portable:

1. **Runtime identity** — one context per request, telling the agent its `sessionId`, title, logged-in `did:youling`, and this device's `did:myco`.
2. **Built-in `myco` skill** — registered by the same plugin, so a fresh DSH profile gets the collaboration rules without also installing a filesystem skill.

```text
[myco:session-identity] 本会话自身身份（myco runtime context）
- sessionId: session-...
- title: 申诉管理
- youling账号: CJ26 <did:youling:z6Mk...>
- myco设备: DESKTOP-DEV <did:myco:z6Mk...>
```

- Verified against DSH **0.2.1-rc.5** (`@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-session-title`, `@deepseek-ai/dsh-agent-loop`, `@deepseek-ai/dsh-skill`).
- Node ≥ 22 (the plugin only uses `node:` builtins).
- The identity core in `src/identity.js` has **no DSH imports**, so the same decision table can be ported to ZCode or another harness; only `src/index.js` is the DSH adapter.

---

## Why it exists

An agent working inside myco needs three facts that DSH does not provide by itself:

1. **which session it is** — so it can address its own session in cross-session tooling;
2. **what the session is about** — the user-visible title, so it does not have to infer intent from raw history;
3. **who it acts for** — the person DID (`did:youling:`) and this device's DID (`did:myco:`), read live from the myco CLI.

The three are refreshed on every request. Nothing is cached across requests.

---

## Built-in `myco` skill

The plugin also registers one runtime skill:

```text
name: myco
```

It is model- and user-invocable and contains the shared semantics above: how to read the identity
block, what missing DID lines mean, and the basic cross-session collaboration rules. Installing this
plugin therefore gives a fresh DSH profile both the identity context and the `myco` skill; no separate
filesystem skill is required.

> **Same-name filesystem skill note**
> DSH’s current skill precedence can let a user-level filesystem skill named `myco` shadow this
> runtime skill. On this machine the old filesystem skill has been archived to
> `~/.agents/skills-archive/myco-20261031/`. On a new host, remove or rename any
> `~/.agents/skills/myco/` if you want the plugin’s built-in skill to be the one shown to the model.
>
> Runtime skill content is captured when the plugin loads. After changing `src/skill.js`, run
> `npm run build` and restart DSH to refresh the registered skill body.

---

## Layout

```text
dsh-plugin-identity/
├─ package.json            # name @myco/dsh-plugin, type module, main lib/index.js
├─ src/
│  ├─ index.js             # DSH adapter: runtime context + skill registration + assemble waterfall
│  ├─ identity.js          # harness-independent exe/status/name resolution and text rendering
│  └─ skill.js             # built-in `myco` skill definition
├─ cordis.patch.yml        # bundle layer: mounts the plugin into a profile
├─ locale/{zh,en}.json     # Plugin Manager title/description
├─ icon.svg
├─ lib/                    # build output (byte-for-byte copy of src/, created by `npm run build`)
├─ scripts/build.mjs       # src → lib, no bundler
├─ test/
│  ├─ identity.test.js     # pure helpers + real child-process probe (timeout, kill, 20x leak)
│  ├─ plugin.test.js       # registration shape, 3 login states, title fallbacks, skill, wire evidence
│  ├─ fixtures/status-fixture.mjs   # mock `myco` executable
│  └─ e2e/                 # isolated-instance harness + recorded evidence
└─ README.md
```

`src/` is the real source; `lib/` exists only because the DSH loader imports the package through
`main`. `npm run build` copies `src/**.js` to `lib/` verbatim — there is no transpile step.

---

## Install and load

The plugin is a normal Cordis plugin package:

```js
export const name = "myco";
export const inject = ["systemPrompt", "skills"];
export function apply(ctx, config) { ... }
```

`sessionTitle` and `sessionProjections` are read through `ctx.get(...)` and are **optional**: a
profile without them still loads, the title line is simply omitted.

### 1. Put the package where the profile can resolve it

From the profile directory (this is what `dsh plugin --profile <name> add` does for you):

```powershell
dsh plugin --profile <name> add "link:<path-to-dsh-plugin>"
# or, for a copy instead of a live link:
dsh plugin --profile <name> add "file:<path-to-dsh-plugin>"
```

`link:` is what the desktop profile already uses for local plugins (`@local/dsh-*` in
`~/.dsh/profiles/desktop/package.json`), so edits to `src/` + `npm run build` are picked up without
reinstalling.

> Since `0.2.0` this package declares a `dsh.bundle`, so `dsh plugin add` mounts its `cordis.patch.yml`
> automatically. The explicit `insert:` block below is what that bundle layer does.

### 2. Mount it in the profile's `cordis.patch.yml`

```yaml
- insert:
    - id: myco
      name: '@myco/dsh-plugin'
      config:
        # everything below is optional
        mycoExe: 'C:/Users/me/AppData/Local/Programs/Youling/myco.exe'
        timeoutMs: 1000
        order: 130
        debugLog: 'D:/tmp/myco-identity-timing.jsonl'
```

Reload the profile (restart the app that owns it, or let `patchReload: live` reload the layer) and
check that the context appears:

```powershell
dsh --profile <name> --dump-config | Select-String myco
```

### 3. Position in the prompt

`order: 130` places the block after the first-party runtime contexts that describe the environment
(`WORKING_DIRECTORY: 100`, `SANDBOX_POLICY: 110`, `APPROVAL_POLICY: 115`, `SUBAGENT_DELEGATION: 120`,
`TEAM_IDENTITY: 125`) and before `HARNESS_SOURCE: 200`. The number is fixed on purpose: the first-party
prefix is not disturbed, and the block does not drift if DSH renumbers its own slots.

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `mycoExe` | — | Absolute path to the myco executable. Highest priority; used verbatim even if it does not exist (so a typo fails into the degrade path instead of silently picking another binary). |
| `timeoutMs` | `1000` | Hard ceiling for one `myco cli status` probe. The child is spawned **without a shell** and killed with `SIGKILL`, so the pid really dies (on Windows `TerminateProcess`). |
| `order` | `130` | Runtime-context order. Non-finite values fall back to 130. |
| `statusArgs` | `['cli','status']` | Arguments of the probe. Only needed for tests or a future CLI shape. |
| `debugLog` | off | Path to a JSONL file; one line per assembly with `probeMs`, `totalMs`, `bytes`, `didCount`, `probe` reason. Fire-and-forget, never blocks a request. |

### Executable resolution order

1. `config.mycoExe`
2. `$MYCO_EXE`
3. platform default: Windows `%LOCALAPPDATA%\Programs\Youling\myco.exe` (then `~\AppData\Local\...`);
   other platforms: `myco` on `$PATH`
4. `$PATH` scan (`myco.exe`, `myco.cmd`, `myco` on Windows)

The resolved path and which rule chose it are logged once at plugin load and appear in every
`debugLog` line (`exe`, `source`).

---

## The three states

`loggedIn` is the only gate for the DID block:

```js
rootDid is a string starting with "did:youling:"
  && role !== "unlinked"
  && deviceDid is a non-empty string
```

| State | Input shape | Injected text |
|---|---|---|
| **logged in** | `rootDid=did:youling:…`, `role=embodiment`, `deviceDid=did:myco:…` | base + both DID lines |
| **logged out** | `rootDid=null`, `role=unlinked`, valid `deviceDid` | base only — **no `did:` at all**, even though the device DID is valid |
| **degraded** | timeout, non-zero exit, unparsable stdout, missing binary, half-broken payload (`role=unlinked` with a valid root DID, or a root DID without a device DID) | base only |

Two further rules keep the block honest:

- a missing **title** drops the whole `- title:` line; the literal strings `undefined`, `null`,
  `(unknown)`, `...` and `…` can never be produced by this plugin;
- a DID that is not a single safe token (whitespace or control characters), or whose method prefix does
  not match its label, degrades the **whole** DID block rather than printing half of it.

Observed live on this machine:

```json
{"deviceDid":"did:myco:z6MkExampleDeviceDIDxxxxxxxxxxxxxxxxxxxxxxxxxx",
 "role":"embodiment",
 "rootDid":"did:youling:z6MkExampleAccountDIDxxxxxxxxxxxxxxxxxxxxxxxxx"}
```

### Note on the DID line shape

The DID is always printed **inside angle brackets**, with the method prefix kept once:

```text
- youling账号: CJ26 <did:youling:z6Mk...>
- myco设备: DESKTOP-DEV <did:myco:z6Mk...>
```

- The label is human-readable and does not duplicate the method.
- `<...>` marks the exact DID boundary; spaces in an account or device name cannot leak into the DID.
- If a name cannot be resolved, the line degrades to `- youling账号: <did:...>` rather than inventing a placeholder.

---

## How it hooks into rc.5 (and the one trap)

Two DSH seams, both used by the first-party `@deepseek-ai/dsh-working-directory` plugin:

```js
ctx.systemPrompt.context({
  name: "myco:session-identity",
  order: 130, required: true, interpolate: false,
  text: (context) => /* base block, synchronously */
});

ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
  if (context.agent === void 0) return next();
  const pending = queryIdentity();      // started, never awaited here
  const assembly = await next();        // the rest of the assembly is not blocked
  const probe = await pending;          // ≤ timeoutMs
  ...                                   // rewrite the entry's text, return the assembly
}, { prepend: true });
```

**The trap:** `@deepseek-ai/dsh-agent-loop` calls `systemPrompt.refreshContext(assembly, context)`
immediately before each request is admitted, and `refreshContext()` *re-resolves every registered
provider*, discarding whatever the waterfall wrote into `assembly.contexts`. A synchronous fact can
simply be recomputed there; an asynchronously probed DID cannot — the first implementation of this
plugin looked correct in an assembly-only unit test and still reached the wire with **no DID lines**
(see `test/e2e/evidence/`, where the same request shows the base block only).

The fix keeps the registration (order, `required`, interpolation are still owned by the registry) and
lets the waterfall hand its finished text to the refreshed resolution through a per-session slot with a
short TTL. The probe still runs once per request; the slot only survives the two resolutions of the
same step, and it is keyed by the live `Session` object, so it cannot leak between sessions.

If you write another runtime context whose text needs I/O, budget for this: `text()` must be able to
return the final value synchronously at refresh time.

---

## Tests

```powershell
npm install
npm test          # vitest run — 50 tests
```

Coverage highlights:

- **10 inline snapshots** of the exact injected text, one per state (logged in, logged out, half logged
  in ×2, title missing, no title service, broken title service, timeout, garbage, non-zero exit,
  missing executable) — see `test/__snapshots__/plugin.test.js.snap`.
- **Built-in skill test**: `apply()` registers exactly one runtime skill named `myco`, model- and
  user-invocable, with the identity/collaboration instructions.
- A mock `myco` executable is spawned for real (`test/fixtures/status-fixture.mjs`), so the probe path,
  the JSON parsing and the degrade paths are exercised end to end rather than stubbed.
- **Timeout kill test**: a `node -e "setTimeout(...)"` child is spawned as the mock CLI, the probe must
  return in **≤ 1.2 s** with reason `timeout`, and the recorded pid must be gone (`process.kill(pid, 0)`
  → `ESRCH`).
- **20 consecutive timeouts** must each return within budget, must use 20 distinct pids, and every pid
  must be gone afterwards (no zombie accumulation).
- A regression test that reproduces rc.5's post-waterfall `refreshContext()` re-resolution and asserts
  the DID lines survive it.

## Isolated end-to-end run

`test/e2e/` contains a reproducible harness that boots a **separate** DSH home with the plugin mounted,
2 sessions × 2 turns through the shipped headless app, against a local mock model server:

```powershell
node test/e2e/mock-llm-server.mjs 8123                       # terminal 1
.\test\e2e\run-e2e.ps1                                        # terminal 2
```

Recorded evidence lives in `test/e2e/evidence/`:

| File | Contents |
|---|---|
| `e2e-summary.json` | per-turn wall clock, per-assembly `probeMs` / `totalMs` |
| `identity-timing.jsonl` | raw plugin timing log (same numbers the summary is built from) |
| `wire-identity-blocks.txt` | the exact blocks extracted from the request bodies the model received |

The harness never touches the user's live profile: it uses its own `DSH_HOME`, its own profile
directory and a localhost model. See the report for the numbers.

---

## Deliberate non-goals

- no cross-request cache (every assembly probes again — a logout in another window is visible on the
  very next turn);
- no single-flight dedupe inside one request (there is only ever one probe per request);
- no retries: a failed probe degrades, it never delays the request by more than `timeoutMs`;
- no `logout`, no account or delegation changes: the plugin only ever runs `myco cli status`.

---

## 用户端半边（client half）：模型选择器触控修复（2026-11-03）

DSH Web 在触控/窄屏下点击输入条上的「模型 / 推理等级」行**不会弹出二级菜单**（手机 WebView 实测：点击后 DOM 零新增、零请求、零异常；同一页面桌面鼠标点击正常）。这是 DSH Web 的交互问题，修复放在本插件的浏览器半边，**不进入 myco 核心、也不改 DSH 本体**。

- `src/client.js`：通过 `window.__ModuleLoader__.load({ id: '@myco/dsh-plugin', factory })` 注册一个 Cordis 浏览器插件（`apply` 返回清理函数，`inject: []`）；
  - 只在**粗指针或窄屏**时接管（桌面原生交互保持不变）；
  - 捕获「模型 / 推理等级」行点击 → 渲染底部选择器；
  - 目录走 `session/modelCatalog`，选择走 `session/selectModel`（host 仍按自己的 P/A 裁决，插件只补前端交互）。
- `src/model-picker-client.js`：DOM-free 纯函数（`apiBase` / `coarseNow` / `sessionIdFromBody`），单测在 `test/model-picker-client.test.js`（8 条）。
- `package.json` 增加 `exports["./client"]` 与 `dsh.client = { platform: "web", immediately: true, inject: [conversation, slots] }`、`dsh.manifestVersion = 1`。
- 分享页与本地 DSH 页都支持：`apiBase()` 会把 `/gw/<shareId>/[app/]` 映射到 `/gw/<shareId>/app/api/`。

启用：与身份注入同一个插件（`@myco/dsh-plugin`）——DSH 重新加载 profile 后生效，不需要单独安装第二个插件。

### 2026-11-02 真案：client entry 必须是**普通脚本**，不能含 ESM import

把 `client.js` 的首次版本直接写成 ESM（`import { … } from "./model-picker-client.js"`）后，DSH 启动即崩：

```text
web boot: 1 entry did not activate
@myco/dsh-plugin: import failed (see console for the import error)
Uncaught SyntaxError: Cannot use import statement outside a module
```

原因：DSH 的 client 入口经 `/plugins/??…` 串接后按 `<script>` 经典脚本加载，不做 ESM 解析。修法（已固化到 `scripts/build.mjs`）：

- `src/client.js` 允许 import（源码可读）；
- build 用 esbuild 把 `src/client.js` 打成**单文件 IIFE** 写入 `lib/client.js`（无 `import`/`export`）；
- build 里加硬闸：打包产物若再出现行首 `import`/`export` 就直接报错，防止再次把 DSH 打崩。
