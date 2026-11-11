/**
 * Browser half of `@myco/dsh-plugin` — the touch fallback for the DSH model
 * picker.
 *
 * The DSH web client loads this module through `window.__ModuleLoader__`. It
 * contributes one Cordis browser plugin whose job is deliberately small:
 *
 *  - only coarse-pointer / narrow-viewport clients get the fallback; desktop
 *    keeps the native model menu untouched;
 *  - a tap on the `模型` or `推理等级` row opens a myco-rendered sheet built from
 *    the same RPCs the native menu uses (`session/modelCatalog`,
 *    `session/selectModel`) — the host still applies its own authorization on
 *    every request, this file only supplies the missing front-end interaction;
 *  - nothing is injected into the page by myco core and the DSH application
 *    itself is not patched.
 *
 * @module @myco/dsh-plugin/client
 */

import { apiBase, coarseNow, defaultEffortFor, selectModelSelection, sessionIdFromBody } from "./model-picker-client.js";

const PANEL_ID = "myco-model-picker";

/** Current browser-level state: learned session id and last known selection. */
const state = { sessionId: undefined, selection: undefined, catalog: undefined, panel: undefined, footer: undefined };

/**
 * @returns {boolean} whether the plugin should take over this click.
 *
 * 2026-11-05 设计定稿：就近弹窗 + 内联思考等级是对所有视口的改进（桌面原生
 * 列表在矮窗口会变成 446×454 的大面板且不含等级），所以**桌面也接管**。
 * 逃生口：localStorage['myco.picker.native'] = '1' 回到 DSH 原生选择器。
 * coarseNow 仍参与诊断日志（`__mycoPicker.diag()`）。
 */
function shouldIntercept() {
  try {
    if (localStorage.getItem("myco.picker.native") === "1") return false;
  } catch {
    /* localStorage 不可用时照常接管 */
  }
  return true;
}

/** 诊断快照（控制台 `__mycoPicker` 使用）。 */
function pickerDiag() {
  let coarse = false;
  try {
    coarse = coarseNow({
      matchMedia: (query) => window.matchMedia(query),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      hasTouch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
    });
  } catch {}
  return {
    coarsePointer: coarse,
    intercepting: shouldIntercept(),
    sessionId: state.sessionId,
    selection: state.selection,
    catalog: state.catalog ? (state.catalog.groups || []).length + " groups" : undefined,
  };
}

/** selectModel：兼容 DSH 新版 `{request:{...}}` 与老版扁平 args。 */
function selectModel(args) {
  return rpc("session/selectModel", { request: args }).catch((error) => {
    const message = String((error && error.message) || "");
    if (/arguments-invalid|do not match the descriptor|missing \"request\"/.test(message)) {
      return rpc("session/selectModel", args);
    }
    throw error;
  });
}

/** POST one client-request RPC and resolve to its `result.value`. */
function rpc(method, args) {
  const body = JSON.stringify({
    type: "client-request",
    rpcId: `mp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    method,
    payload: { args: args || {} },
  });
  return fetch(apiBase(location.pathname) + method.replace(/\//g, "/"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body,
  })
    .then((response) => response.json())
    .then((json) => {
      const result = json && json.result;
      if (result && result.ok === false) {
        const error = result.error || {};
        throw new Error(error.message || error.code || "操作被拒绝");
      }
      return result ? result.value : undefined;
    });
}

/** Resolve the active session id.
 *  2026-11-05 实测：DSH 在会话容器/右侧栏挂 `data-conversation-session`（当前打开的
 *  会话 id，权威来源）；旧实现只靠 fetch 学习，可能拿到别的会话 id →
 *  "切了模型但当前会话没生效"。DOM 优先，其次缓存，再退 URL 解析。 */
function sessionId() {
  try {
    const nodes = document.querySelectorAll("[data-conversation-session]");
    for (const el of nodes) {
      const v = (el.getAttribute("data-conversation-session") || "").trim();
      if (/^session-[0-9a-f-]{20,}$/i.test(v)) {
        state.sessionId = v;
        return v;
      }
    }
  } catch {
    /* DOM 不可用时退回缓存 */
  }
  if (state.sessionId !== undefined) return state.sessionId;
  const match = /session-[0-9a-fA-F-]{20,}/.exec(location.href || "");
  if (match) return match[0];
  const pathMatch = /session-([0-9a-f-]{36})/.exec(location.pathname || "");
  if (pathMatch) return "session-" + pathMatch[1];
  return undefined;
}

/** Create an element with inline style and text. */
function el(tag, css, text) {
  const node = document.createElement(tag);
  if (css) node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Remove the open sheet, if any. */
function closePanel() {
  if (state.panel && state.panel.parentNode) state.panel.parentNode.removeChild(state.panel);
  state.panel = undefined;
}

/** Show one host-side rejection (P/A) at the bottom of the open sheet instead of failing silently. */
function showError(error) {
  const message = (error && error.message) || String(error || "操作失败");
  try {
    if (!state.panel) {
      console.warn("[myco] model picker:", message);
      return;
    }
    if (!state.footer) {
      state.footer = el(
        "div",
        "margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(224,87,76,.16);color:#ffb4ae;font-size:12.5px;line-height:1.45;white-space:pre-wrap;",
      );
      state.panel.lastChild.appendChild(state.footer);
    }
    state.footer.textContent = message;
  } catch { /* panel already closed */ }
}

/** Render a bottom sheet with a title and body. */
/** Open a compact popover anchored to `anchorEl` (falls back to bottom-center when none). */
function openPanel(title, body, anchorEl) {
  closePanel();
  const overlay = el(
    "div",
    "position:fixed;inset:0;z-index:2147483600;background:rgba(8,10,16,.18);font:13px/1.45 system-ui,sans-serif;",
  );
  const card = el(
    "div",
    "position:fixed;left:0;top:0;visibility:hidden;box-sizing:border-box;width:min(380px,calc(100vw - 20px));max-height:min(72vh,540px);overflow:auto;background:#171a23;border:1px solid #2a3040;border-radius:12px;padding:10px 12px;color:#e8ecf5;box-shadow:0 14px 44px rgba(0,0,0,.55);",
  );
  const head = el("div", "display:flex;align-items:center;justify-content:space-between;margin:0 0 6px;");
  head.appendChild(el("div", "font-weight:700;font-size:13.5px", title));
  const close = el(
    "button",
    "border:0;background:rgba(255,255,255,.08);color:#e8ecf5;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;",
    "关闭",
  );
  close.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePanel();
  };
  head.appendChild(close);
  card.appendChild(head);
  card.appendChild(body);
  overlay.appendChild(card);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closePanel();
  }, true);
  document.body.appendChild(overlay);
  // 2026-11-05 用户反馈：弹窗原来居中，鼠标从右侧按钮到屏幕中心行程太长。
  // 改为就近锚定：优先弹在按钮**上方**（右缘对齐），按上方可用空间收窄高度，
  // 保证不盖住按钮；上方实在放不下才翻到下方；横向夹紧视口。
  try {
    const margin = 8;
    if (anchorEl && typeof anchorEl.getBoundingClientRect === "function") {
      const a = anchorEl.getBoundingClientRect();
      const spaceAbove = Math.max(0, a.top - margin * 2);
      const spaceBelow = Math.max(0, window.innerHeight - a.bottom - margin * 2);
      const preferAbove = spaceAbove >= Math.min(240, spaceBelow) || spaceAbove >= spaceBelow;
      const limit = Math.max(160, preferAbove ? spaceAbove : spaceBelow);
      card.style.maxHeight = `${Math.round(Math.min(limit, window.innerHeight * 0.72))}px`;
      const rect = card.getBoundingClientRect();
      let left = Math.max(margin, Math.min(a.right - rect.width, window.innerWidth - rect.width - margin));
      let top = preferAbove ? a.top - rect.height - margin : a.bottom + margin;
      top = Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin));
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    } else {
      const rect = card.getBoundingClientRect();
      card.style.left = `${Math.round(Math.max(margin, (window.innerWidth - rect.width) / 2))}px`;
      card.style.top = `${Math.round(Math.max(margin, window.innerHeight - rect.height - margin * 2))}px`;
    }
    card.style.visibility = "visible";
  } catch {
    card.style.left = "8px";
    card.style.top = "8px";
    card.style.visibility = "visible";
  }
  state.panel = overlay;
}

/** Inline success tick before closing (2026-11-05：切换成功即时可见，缓解芯片刷新延迟感). */
function flashSuccess(cardOverlay, label) {
  try {
    const tick = el(
      "div",
      "position:fixed;left:50%;top:18%;transform:translateX(-50%);background:rgba(34,163,90,.95);color:#fff;padding:8px 14px;border-radius:10px;font-size:13px;z-index:2147483647;box-shadow:0 8px 26px rgba(0,0,0,.4)",
      label || "✓ 已切换",
    );
    document.body.appendChild(tick);
    setTimeout(() => { try { tick.remove(); } catch {} }, 700);
  } catch {}
}

/** 找到 composer 里的真实模型芯片按钮（可见、下半屏、模型名开头、不在弹层内）。 */
function findModelChipEl() {
  try {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    for (const b of document.querySelectorAll("button")) {
      const t = (b.textContent || "").trim();
      if (!t || t.length > 60 || t.includes("\n")) continue;
      if (!/^(DeepSeek|GLM|Kimi|GPT|Claude|Qwen|Doubao|Gemini|Yi)/i.test(t)) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 60 || r.height < 8 || r.height > 40) continue;
      if (r.y < vh * 0.5 || r.y + r.height > vh + 1) continue;
      if (r.x < 0 || r.x + r.width > vw + 1) continue;
      if (state.panel && state.panel.contains(b)) continue;
      return b;
    }
  } catch {}
  return null;
}

/** 芯片文本解析：`<模型名>[ <上下文数字>]<等级>`（上下文数字必须带前导空格，
 *  否则 `GLM-5.3` 会被误拆成名字 `GLM-5.` + 上下文 `3`）。 */
const CHIP_TEXT_RE = /^(.*?)(\s+\d+)?\s*(Off|Low|Medium|High|Max)$/i;

/** 从芯片文本解析当前选择。 */
function readChipSelection(catalog) {
  const chip = findModelChipEl();
  if (!chip || !catalog) return undefined;
  const m = CHIP_TEXT_RE.exec((chip.textContent || "").trim());
  if (!m) return undefined;
  const name = (m[1] || "").trim().toLowerCase();
  const effort = m[3].toLowerCase();
  for (const g of catalog.groups || []) {
    for (const model of g.models || []) {
      const n = String(model.name || model.id || "").trim().toLowerCase();
      const id = String(model.id || "").trim().toLowerCase();
      if (n === name || id === name) {
        return { provider: g.id, model: model.id, reasoningEffort: effort };
      }
    }
  }
  return undefined;
}

/** 当前芯片显示的模型名（回填 refreshModelChip 的 oldName）。 */
function chipDisplayName(catalog) {
  const sel = readChipSelection(catalog);
  if (!sel) return undefined;
  for (const g of catalog.groups || []) {
    for (const m of g.models || []) {
      if (g.id === sel.provider && m.id === sel.model) return m.name || m.id;
    }
  }
  return undefined;
}

/** Refresh the DSH model chip text so it reflects the switch immediately.
 *  芯片可能由多个文本节点组成（名字 span + 上下文 span + 等级 span）且含 svg 箭头：
 *  逐节点精确替换——只动"名字节点"和"等级节点"，不动上下文数字与图标。 */
function refreshModelChip(oldName, newName, newEffortLabel) {
  const chip = findModelChipEl();
  if (!chip || !newName) return;
  try {
    const nodes = [];
    const walker = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    let nameDone = false;
    for (const n of nodes) {
      const t = (n.nodeValue || "").trim();
      if (!t) continue;
      if (!nameDone && oldName && (t === oldName || t.startsWith(oldName))) {
        n.nodeValue = (n.nodeValue || "").replace(oldName, newName);
        nameDone = true;
        continue;
      }
      if (newEffortLabel && /^(Off|Low|Medium|High|Max)$/i.test(t)) {
        n.nodeValue = (n.nodeValue || "").replace(t, newEffortLabel);
      }
    }
    if (!nameDone) {
      // 单文本节点形态：整段重建（保留上下文数字）
      const first = nodes.find((n) => (n.nodeValue || "").trim());
      if (first) {
        const m = CHIP_TEXT_RE.exec((first.nodeValue || "").trim());
        const ctx = m && m[2] ? m[2] : "";
        first.nodeValue = `${newName}${ctx}${newEffortLabel || (m ? m[3] : "")}`;
      }
    }
  } catch {}
}

/** off→Off / medium→Medium ... 用于芯片尾部等级标签刷新。 */
function effortLabel(id) {
  if (!id) return undefined;
  const s = String(id);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One selectable row: label, optional description, active state, tap handler. */
function option(label, description, active, onTap) {
  const button = el(
    "button",
    `display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;border:0;border-radius:10px;padding:10px 12px;margin:2px 0;background:${active ? "rgba(79,110,247,.28)" : "rgba(255,255,255,.05)"};color:#e8ecf5;font:14px/1.35 system-ui,sans-serif;cursor:pointer;`,
  );
  button.appendChild(el("span", "font-weight:600", label));
  if (description) button.appendChild(el("span", "font-size:12px;color:#9aa3b8", description));
  button.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onTap();
  };
  return button;
}

/** The provider/model selection currently in effect. */
function current() {
  // 2026-11-05：芯片文本才是"用户看到的当前模型"（catalog.default 只是目录默认，
  // 不是本会话的真实选择——真案：芯片 GLM-5.3，default 却是 deepseek-flash）。
  const fromChip = readChipSelection(state.catalog);
  if (fromChip) return fromChip;
  return state.selection || (state.catalog && state.catalog.default) || {};
}

/** Load the catalog once. */
function ensureCatalog(callback) {
  if (state.catalog !== undefined) return callback(null, state.catalog);
  rpc("session/modelCatalog", {}).then(
    (value) => {
      state.catalog = value;
      callback(null, value);
    },
    (error) => callback(error),
  );
}

/** 单一模型行：模型名（点=按默认等级切）+ 内联思考等级胶囊（点=切该模型+该等级）。 */
function modelRow(group, model, currentSel, catalog, onPick) {
  const efforts = (model && model.reasoning && model.reasoning.efforts) || [];
  const isActive = currentSel.provider === group.id && currentSel.model === model.id;
  const row = el(
    "div",
    `display:flex;align-items:center;gap:6px;padding:5px 4px;border-radius:8px;${isActive ? "background:rgba(79,110,247,.18);" : ""}`,
  );
  const nameBtn = el(
    "button",
    "flex:1;min-width:0;text-align:left;border:0;background:transparent;color:#e8ecf5;font:13px/1.3 system-ui,sans-serif;padding:3px 2px;cursor:pointer;",
  );
  // 2026-11-05 用户要求：选模型不需要介绍文案，界面保持简洁（只留名称+等级）。
  nameBtn.appendChild(el("span", "font-weight:600", model.name || model.id));
  nameBtn.title = model.description || model.name || model.id;
  nameBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPick(group.id, model.id, defaultEffortFor(model, currentSel), model);
  };
  row.appendChild(nameBtn);
  if (efforts.length > 0) {
    const pills = el("div", "display:flex;gap:3px;flex-shrink:0;");
    for (const eff of efforts) {
      const on = isActive && currentSel.reasoningEffort === eff.id;
      const pill = el(
        "button",
        `border:1px solid ${on ? "#4f6ef7" : "#2a3040"};background:${on ? "rgba(79,110,247,.30)" : "rgba(255,255,255,.04)"};color:${on ? "#cdd8ff" : "#9aa3b8"};border-radius:999px;padding:2px 7px;font-size:11px;line-height:1.3;cursor:pointer;`,
      );
      pill.textContent = eff.name || eff.id;
      pill.title = eff.description || eff.id;
      pill.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        onPick(group.id, model.id, eff.id, model);
      };
      pills.appendChild(pill);
    }
    row.appendChild(pills);
  }
  return row;
}

/** 执行切换：调 session/selectModel，成功后就地刷新芯片并短暂提示。 */
function pickModelFor(providerId, modelId, effortId, modelMeta, catalog) {
  const id = sessionId();
  if (!id) {
    showError(new Error("还不知道当前是哪个会话——请先点开一个会话（看到聊天内容）后再切模型"));
    return;
  }
  const prev = current();
  const sameModel = prev.provider === providerId && prev.model === modelId;
  const prevEffort = prev.reasoningEffort;
  const noActualChange = sameModel && (effortId === undefined ? true : prevEffort === effortId);
  if (noActualChange) {
    closePanel();
    return;
  }
  const selection = { provider: providerId, model: modelId };
  if (effortId) selection.reasoningEffort = effortId;
  const prevName = chipDisplayName(catalog);
  selectModel({ sessionId: id, ...selection }).then(
    (value) => {
      state.selection = (value && value.selected) || selection;
      const newName = (modelMeta && (modelMeta.name || modelMeta.id)) || modelId;
      // 芯片可能由多个文本节点 + svg 箭头组成——refreshModelChip 逐节点精确替换。
      refreshModelChip(prevName, newName, effortLabel(effortId));
      flashSuccess(state.panel, "✓ 已切换到 " + newName);
      closePanel();
    },
    showError,
  );
}

/** Open the model chooser (inline efforts per row + independent current-model effort row). */
function openModelPicker(anchorEl) {
  ensureCatalog((error, catalog) => {
    if (error || !catalog) return;
    const body = el("div");
    const currentSel = current();

    // 顶部：当前模型的推理等级（独立控制——用户要求"换思考等级维持现状，可独立控制"）
    let curModel;
    for (const group of catalog.groups || []) {
      if (group.id !== currentSel.provider) continue;
      for (const model of group.models || []) if (model.id === currentSel.model) curModel = model;
    }
    const curEfforts = (curModel && curModel.reasoning && curModel.reasoning.efforts) || [];
    if (curEfforts.length > 0) {
      body.appendChild(el("div", "font-size:11.5px;color:#8b93a7;margin:2px 2px 3px", "当前模型推理等级"));
      const row = el("div", "display:flex;gap:4px;flex-wrap:wrap;padding:0 2px 4px;");
      const activeEffort = currentSel.reasoningEffort || (curModel.reasoning && curModel.reasoning.defaultEffort);
      for (const eff of curEfforts) {
        const on = eff.id === activeEffort;
        const pill = el(
          "button",
          `border:1px solid ${on ? "#4f6ef7" : "#2a3040"};background:${on ? "rgba(79,110,247,.30)" : "rgba(255,255,255,.04)"};color:${on ? "#cdd8ff" : "#9aa3b8"};border-radius:999px;padding:2px 9px;font-size:11.5px;cursor:pointer;`,
        );
        pill.textContent = eff.name || eff.id;
        pill.onclick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          pickModelFor(currentSel.provider, currentSel.model, eff.id, curModel, catalog);
        };
        row.appendChild(pill);
      }
      body.appendChild(row);
      body.appendChild(el("div", "height:1px;background:#2a3040;margin:4px 0 2px"));
    }

    for (const group of catalog.groups || []) {
      body.appendChild(el("div", "font-size:11.5px;color:#8b93a7;margin:8px 2px 2px", group.name || group.id));
      for (const model of group.models || []) {
        body.appendChild(
          modelRow(group, model, currentSel, catalog, (pid, mid, eid, meta) => {
            pickModelFor(pid, mid, eid, meta, catalog);
          }),
        );
      }
    }
    openPanel("选择模型", body, anchorEl);
  });
}

/** Open the reasoning-effort chooser (独立控制，维持现状). */
function openEffortPicker(anchorEl) {
  ensureCatalog((error, catalog) => {
    if (error || !catalog) return;
    const selected = current();
    let model;
    for (const group of catalog.groups || []) {
      if (group.id !== selected.provider) continue;
      for (const candidate of group.models || []) if (candidate.id === selected.model) model = candidate;
    }
    const efforts = (model && model.reasoning && model.reasoning.efforts) || [];
    const fallback = model && model.reasoning ? model.reasoning.defaultEffort : undefined;
    const body = el("div");
    if (efforts.length === 0) body.appendChild(el("div", "color:#9aa3b8;padding:8px 2px", "这个模型没有可推理等级选项"));
    for (const effort of efforts) {
      body.appendChild(
        option(effort.name || effort.id, effort.description || "", effort.id === (selected.reasoningEffort || fallback), () => {
          const id = sessionId();
          if (!id || !selected.provider || !selected.model) return;
          selectModel({
            sessionId: id,
            provider: selected.provider,
            model: selected.model,
            reasoningEffort: effort.id,
          }).then((value) => {
            state.selection = (value && value.selected) || {
              provider: selected.provider,
              model: selected.model,
              reasoningEffort: effort.id,
            };
            flashSuccess(state.panel, "✓ 推理等级已切换");
            closePanel();
          }, showError);
        }),
      );
    }
    openPanel("推理等级", body, anchorEl);
  });
}

/** Capture-phase click handler: intercept the real model chip and the two legacy rows. */
function isModelChip(cell) {
  const text = (cell.textContent || "").trim();
  if (!text || text.length > 60) return false;
  if (text.includes("\n") || text.includes("\r")) return false;
  // 旧/其他形态：行首就是「模型」
  if (text.startsWith("模型")) return true;
  const rect = typeof cell.getBoundingClientRect === "function" ? cell.getBoundingClientRect() : null;
  if (!rect || rect.width < 40 || rect.height < 10 || rect.height > 40) return false;
  // 必须**真实可见**：视口下半部且完整在视口内（2026-11-05 实测：同名模型标签
  // 可能出现在视口外的隐藏面板里，只按 y>half 会把它们也当芯片）。
  const vh = window.innerHeight;
  if (rect.y < vh * 0.5) return false;
  if (rect.y + rect.height > vh + 1) return false;
  if (rect.x < 0 || rect.x + rect.width > window.innerWidth + 1) return false;
  return /^(DeepSeek|GLM|Kimi|GPT|Claude|Qwen|Doubao|Gemini|Yi)/i.test(text);
}

function onClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  // 2026-11-05 真案：弹层内部的点击必须先放行——弹层里的模型行按钮文字也以模型名
  // 开头且可能落在下半屏，旧逻辑会把它们误判成芯片 → 再开一个弹层（"点一下左边
  // 又弹一次"）、原目标动作被 preventDefault（"点了没用/关闭无效/模型没生效"）。
  if (state.panel && state.panel.contains(target)) return;
  const cell = target.closest("button");
  if (!cell) return;
  const text = (cell.textContent || "").trim();
  const isEffortRow = text.startsWith("推理等级");
  if (!isEffortRow && !isModelChip(cell)) return;
  if (!shouldIntercept()) return;
  event.preventDefault();
  event.stopPropagation();
  // 同一个芯片再点一次 = 收起（开关语义），避免"点了又弹"的困惑。
  if (isEffortRow) openEffortPicker(cell);
  else openModelPicker(cell);
}

/**
 * Cordis browser plugin body. DSH calls `apply(ctx)` when the client module is
 * loaded into the Web composition.
 *
 * 2026-11-03（用户反馈）：server 半边已通过 `context.agent.session.id` 知道
 * sessionId；client 半边不该自己猜。这里从 ctx 注入的服务里直接取（最可靠），
 * 再用 fetch 拦截兜底（页面自己发的 RPC 里带 sessionId）。
 */
function apply(ctx) {
  if (document.getElementById(PANEL_ID) !== null) return () => {};
  if (window.__mycoModelPickerClient === true) return () => {};
  window.__mycoModelPickerClient = true;

  // ── 优先来源：ctx 上的 DSH 客户端服务（server 半边同源）────────────
  try {
    if (ctx && typeof ctx === "object") {
      for (const key of Object.keys(ctx)) {
        const val = ctx[key];
        if (val && typeof val === "object") {
          const sid = val.sessionId || val.currentSessionId || val.activeSessionId
            || (val.session && typeof val.session === "object" && val.session.id)
            || (val.current && typeof val.current === "object" && val.current.sessionId);
          if (typeof sid === "string" && sid.startsWith("session-")) {
            state.sessionId = sid;
            break;
          }
        }
      }
    }
  } catch { /* ctx 探测失败不影响主流程 */ }

  // ── 兜底：fetch 拦截学习 sessionId ─────────────────────────────────
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function mycoModelPickerFetch(input, init) {
      try {
        if (init && typeof init.body === "string") {
          const found = sessionIdFromBody(init.body);
          if (found !== undefined) state.sessionId = found;
          if (init.body.indexOf("selectModel") >= 0) {
            // 2026-11-05 修复：从请求体直接更新 state.selection——不碰响应。
            // 旧版 response.clone().json() 创建 stream tee，两个读取器竞争
            // 同一底层流，tee 背压可能延迟 DSH 原始读取器收到数据 →
            // 原生模型选择器 UI 不刷新（"点了没反应但后台已切"的根因）。
            try {
              const req = JSON.parse(init.body);
              const args = (req.payload && req.payload.args && (req.payload.args.request || req.payload.args)) || req.request || {};
              if (args.provider && args.model) {
                state.selection = { provider: args.provider, model: args.model };
                if (args.reasoningEffort !== undefined) {
                  state.selection.reasoningEffort = args.reasoningEffort;
                }
              }
            } catch { /* not a valid selectModel JSON */ }
            return nativeFetch.apply(this, arguments);
          }
        }
      } catch { /* never break the page's own fetch */ }
      return nativeFetch.apply(this, arguments);
    };
  }

  document.addEventListener("click", onClick, true);
  // 诊断/逃生钩子（控制台可用；不影响正常交互）
  try {
    window.__mycoPicker = {
      diag: pickerDiag,
      open: () => openModelPicker(),
      native: (on) => {
        try {
          if (on) localStorage.setItem("myco.picker.native", "1");
          else localStorage.removeItem("myco.picker.native");
        } catch {}
      },
      version: "2026-11-05-anchored-inline",
    };
  } catch {}
  console.info("[myco] model picker active (anchored popover + inline efforts)");
  return () => {
    document.removeEventListener("click", onClick, true);
    window.__mycoModelPickerClient = false;
  };
}

window.__ModuleLoader__.load({
  id: "@myco/dsh-plugin",
  factory() {
    return { apply, inject: [] };
  },
});
