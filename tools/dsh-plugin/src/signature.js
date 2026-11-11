/**
 * 设备发言署名（从 dsh_share.rs 移植）——"谁在这台设备上打字"的权威前缀。
 *
 * 两套前缀（勿混）：
 *  - HTTP prompt 写路径：`【设备·笔记本·6Cqf】：正文`（中文冒号 + 同行紧凑）
 *  - WS 文本帧：`【设备·笔记本·6Cqf】正文`（无冒号）
 *
 * 0.2.x 的 RPC 走 fetch POST、WS 只承载事件下行（Rust 侧注释明确），所以插件
 * 只在 HTTP prompt 这一层签名即可覆盖全部真实发言；WS 泵不参与签名。
 *
 * 防伪造（A4a）：正文里手写的 `[from: …]`（含/不含 `---`）与 `【设备·…】`/
 * `【MYCO·…】` 头形状，一律先剥掉再盖权威头——访客预写一个头形就能冒充主人。
 * 防叠加（A4a-④）：已带本连接权威头（重试重放）→ 原样转发，不重签。
 *
 * label 由 myco 计算后随策略下发（插件拿不到账号/设备名映射），形态见
 * dsh_share.rs `signature_label_with_assert`。
 *
 * @module @myco/dsh-plugin/signature
 */

/** 中文括号权威头（prompt 写路径，带冒号）。 */
export function promptHeader(label) {
  return `【${label}】：`;
}

/** WS 帧权威头（无冒号）。 */
export function frameHeader(label) {
  return `【${label}】`;
}

/* ─────────────────────────── 剥掉伪造的头形状 ─────────────────────────── */

/**
 * 剥 `[from: …]\n---\n正文` 形态（cli.rs strip_handwritten_header 的移植）。
 * @param {string} text - 原始正文。
 * @returns 剥头后的正文（不匹配则原样）。
 */
export function stripHandwrittenHeader(text) {
  const t = text.replace(/^[\n\r \t]+/, "");
  if (!t.startsWith("[from:")) return text;
  const nl = t.indexOf("\n");
  if (nl < 0) return text;
  const head = t.slice(0, nl);
  if (!head.replace(/\s+$/, "").endsWith("]")) return text;
  const after = t.slice(nl + 1).replace(/^[\n\r]+/, "");
  if (!after.startsWith("---")) return text;
  return after.slice(3).replace(/^[\n\r]+/, "");
}

/**
 * 剥掉全部可伪造的署名头（A4a）：cli 严格形 → 无 `---` 的 `[from: …]` 首行 →
 * 首个 `【设备·…】`/`【MYCO·…】`（含紧跟的 ：/:）。
 * @param {string} text - 原始正文。
 * @returns 剥头后的正文。
 */
export function stripForgedSigningHeaders(text) {
  let out = stripHandwrittenHeader(text);
  // ② 无 `---` 的 `[from: …]` 首行
  {
    const t = out.replace(/^[\n\r \t]+/, "");
    if (t.startsWith("[from:")) {
      const rest = t.slice("[from:".length);
      const nl = rest.indexOf("\n");
      if (nl >= 0) {
        const head = rest.slice(0, nl);
        if (head.replace(/\s+$/, "").endsWith("]")) {
          out = rest.slice(nl + 1).replace(/^[\n\r]+/, "");
        }
      }
    }
  }
  // ③ 首个 【设备·…】/【MYCO·…】 权威头形状
  {
    const t = out.replace(/^[\n\r \t]+/, "");
    if (t.startsWith("【")) {
      const close = t.indexOf("】");
      if (close > 0) {
        const inner = t.slice(1, close);
        if (inner.startsWith("设备·") || inner.startsWith("MYCO·")) {
          let after = t.slice(close + 1);
          if (after.startsWith("：") || after.startsWith(":")) after = after.slice(1);
          return after;
        }
      }
    }
  }
  return out;
}

/* ───────────────────────────── prompt 署名 ─────────────────────────────── */

/**
 * 给一次 `session/prompt`（或 `subagent/prompt`）请求体盖权威头。
 *
 * 当前行为（用户 2026-11-09 03:00 口径：**先不剥头**——现在都是自己人用，
 * 剥头语义留待办）：直接在正文最前盖章，正文内容原样保留。
 * 防叠加仅做精确前缀判断：已带本连接权威头（重试重放）→ 跳过。
 *
 * TODO(待办): 剥头防伪造（stripForgedSigningHeaders 已实现未启用）——
 * 对外分享给访客前必须开启：正文里预写的 `[from:…]`/`【设备·…】` 头形
 * 会被目标 AI 当可信来源（Rust A4a 真案）。开启 = 把下面 STRIP_FORGED
 * 置 true 即可，测试已备好。
 *
 * 结构不匹配 / 没有可签文本 → `undefined`（调用方原样转发，协议跟版风险隔离）。
 *
 * @param {string} bodyText - 原始 JSON 请求体。
 * @param {string} label - 权威标签（`设备·笔记本·6Cqf`）。
 * @returns 改写后的 JSON 文本，或 `undefined`。
 */
const STRIP_FORGED = false;

export function signPromptBody(bodyText, label) {
  if (typeof label !== "string" || label.length === 0) return undefined;
  let value;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const args = value?.payload?.args;
  if (args === null || typeof args !== "object") return undefined;
  const req = args.request ?? args._request;
  if (req === null || typeof req !== "object" || !Array.isArray(req.content)) return undefined;
  const header = promptHeader(label);
  let touched = false;
  for (const item of req.content) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    if (item.text.trim().length === 0) continue;
    // 防叠加：已带本连接权威头（重试重放）→ 原样
    if (item.text.trimStart().startsWith(header)) continue;
    const cleaned = STRIP_FORGED ? stripForgedSigningHeaders(item.text) : item.text;
    const signed = `${header}${cleaned}`;
    if (signed === item.text) continue;
    item.text = signed;
    touched = true;
  }
  return touched ? JSON.stringify(value) : undefined;
}

/**
 * 判断一个 RPC 方法是不是 prompt 写路径（0.1 点分 / 0.2 斜杠双兼容）。
 * @param {string} method - `session/prompt` 或 `session.prompt`。
 * @returns 是否写路径。
 */
export function isPromptWrite(method) {
  if (typeof method !== "string") return false;
  const normalized = method.trim().toLowerCase();
  return normalized === "session/prompt"
    || normalized === "session.prompt"
    || normalized === "subagent/prompt"
    || normalized === "subagent.prompt";
}
