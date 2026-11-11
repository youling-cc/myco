/**
 * Pure helpers for the browser half of `@myco/dsh-plugin`.
 *
 * Kept DOM-free so they can be unit-tested in Node: the DSH web client runs
 * `client.js` inside `window.__ModuleLoader__`, which no test environment here
 * provides. Everything that touches `window` lives in `client.js`.
 *
 * Why this module exists at all: on touch/narrow viewports the DSH model
 * picker's `模型 / 推理等级` rows do not open their secondary menu (verified on a
 * phone WebView: a tap produced zero DOM mutation, zero request, zero error,
 * while the same page works with a mouse on desktop). This is a DSH web issue;
 * it is fixed here, in the DSH plugin's browser half, **not** in myco core and
 * not by patching the DSH application itself.
 *
 * @module @myco/dsh-plugin/model-picker-client
 */

/**
 * Compute the RPC base path for the current page.
 *
 * A DSH page can be served from two places:
 *  - the harness itself: `.../app/...` or any path → `/api/`;
 *  - a myco share gateway: the DSH app is mounted under `/gw/<shareId>/app/`
 *    and its RPC surface is `/gw/<shareId>/app/api/`.
 *
 * @param pathname - `location.pathname` of the page.
 * @returns the base path ending in `/api/`.
 */
export function apiBase(pathname) {
  const match = /^\/gw\/([^/]+)\/(?:app\/)?/.exec(String(pathname || ""));
  return match === null ? "/api/" : `/gw/${match[1]}/app/api/`;
}

/**
 * Whether the current environment should get the touch fallback.
 *
 * Desktop keeps the native interaction (so the plugin never gets in the way of
 * the pointer path that already works); only coarse pointers or a narrow
 * viewport take over.
 *
 * @param env - `{ matchMedia, innerWidth, innerHeight, hasTouch }`.
 * @returns true when the fallback should handle model-row clicks.
 */
export function coarseNow(env) {
  const safe = env || {};
  if (typeof safe.matchMedia === "function") {
    try {
      if (safe.matchMedia("(pointer: coarse)").matches === true) return true;
    } catch {
      // A throwing matchMedia (older WebViews) falls through to the size check.
    }
  }
  const width = Number(safe.innerWidth) || 0;
  const height = Number(safe.innerHeight) || 0;
  const narrow = Math.min(width, height) > 0 && Math.min(width, height) < 900;
  return safe.hasTouch === true && narrow;
}

/**
 * Extract the session id from an RPC request body, if it carries one.
 *
 * The model picker needs the active `sessionId` for `session/selectModel`; the
 * page already sends it in most RPC payloads (`schedule/list`, `goals/get`,
 * `session/page`, ...), so the client half learns it passively instead of
 * asking the harness for state it does not expose.
 *
 * @param body - the JSON string of an outgoing RPC request.
 * @returns the first `sessionId` found, or `undefined`.
 */
export function sessionIdFromBody(body) {
  if (typeof body !== "string") return undefined;
  const match = /"sessionId"\s*:\s*"([^"]+)"/.exec(body);
  return match === null ? undefined : match[1];
}

/**
 * Compute the `session/selectModel` selection for one catalog model.
 *
 * 对齐 DSH 原生选择器的确切语义（取证自 `@deepseek-ai/dsh-client-ui-model-selection`
 * 的 lib/client.js，模型菜单与 /model 弹窗两处构造点一致）：切换到**另一个**模型时
 * 绝不携带当前会话的 reasoningEffort，只用目标模型自己的 `reasoning.defaultEffort`；
 * 目标模型没有默认等级时整个省略 `reasoningEffort` 字段，让网关套用它自己的默认值。
 * 原生从不把当前会话的等级硬塞给目标模型——等级只在目标模型的 efforts 列表里时
 * 才合法（旧代码 `defaultEffort || current().reasoningEffort` 会把 GLM 的 `max`
 * 带给 efforts 里没有 `max` 的 Kimi K3.1 Pro，网关直接报“模型不支持思考模式 max”）。
 * 只有重选**同一个**模型时才沿用当前等级——此时等级必然来自该模型自己的 efforts，
 * 天然兼容；若当前没有等级，仍退回该模型的 defaultEffort。
 *
 * @param catalog - `session/modelCatalog` 的返回值（`{default, groups, ...}`）。
 * @param current - 本会话当前选择 `{provider, model, reasoningEffort?}`；可为空。
 * @param providerId - 目标 provider（分组）id。
 * @param modelId - 目标模型 id。
 * @returns selection `{provider, model, reasoningEffort?}`；`reasoningEffort` 仅在
 *   存在兼容值时出现（不存在时字段整个缺失，与原生 `...x === void 0 ? {} : {x}`
 *   的省略写法一致）。
 */
export function selectModelSelection(catalog, current, providerId, modelId) {
  // 在目录里找目标模型的 reasoning 元数据；找不到就当没有（原生对陈旧行直接
  // 报错，这里退化为"不带等级"更稳，也不会发出不兼容值）。
  let reasoning;
  for (const group of (catalog && catalog.groups) || []) {
    if (group.id !== providerId) continue;
    for (const model of group.models || []) {
      if (model.id === modelId) reasoning = model.reasoning;
    }
  }
  const sameModel = current !== undefined && current !== null && current.provider === providerId && current.model === modelId;
  const effort = sameModel && current.reasoningEffort !== undefined ? current.reasoningEffort : reasoning && reasoning.defaultEffort;
  const selection = { provider: providerId, model: modelId };
  if (effort !== undefined && effort !== null) selection.reasoningEffort = effort;
  return selection;
}

/**
 * 目标模型的默认思考等级（2026-11-05 设计定稿规则）。
 *
 * 用户在模型列表里点模型名（不点具体等级胶囊）时用这个值：
 *   1. **继承当前模型的思考等级**——若目标模型也有这个等级（兼容）；
 *   2. 目标模型支持 `max` 时用 **max**（用户明确要求"当前模型没有思考等级则默认 Max"）；
 *   3. 否则退回目标模型自己的 `defaultEffort`（若在可用列表里）；
 *   4. 最后退可用列表的末项；
 *   5. 模型没有等级概念（efforts 空）→ `undefined`（调用方整个省略该字段）。
 *
 * @param model - 目录里的目标模型对象。
 * @param currentSel - 当前选择 `{provider, model, reasoningEffort?}`。
 * @returns 等级 id，或 undefined。
 */
export function defaultEffortFor(model, currentSel) {
  const efforts = (model && model.reasoning && model.reasoning.efforts) || [];
  const ids = efforts.map((e) => e.id);
  if (ids.length === 0) return undefined;
  const inherited = currentSel && currentSel.reasoningEffort;
  if (inherited && ids.includes(inherited)) return inherited;
  if (ids.includes("max")) return "max";
  if (model.reasoning && model.reasoning.defaultEffort && ids.includes(model.reasoning.defaultEffort)) {
    return model.reasoning.defaultEffort;
  }
  return ids[ids.length - 1];
}
