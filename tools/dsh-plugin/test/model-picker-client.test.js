import { describe, expect, it } from "vitest";

import { apiBase, coarseNow, defaultEffortFor, selectModelSelection, sessionIdFromBody } from "../src/model-picker-client.js";

// 复刻 session/modelCatalog 的真实形态：GLM 默认 max；K3.1 Pro 的 efforts 里
// 没有 max（这是“模型不支持思考模式 max”报错的现场），k3.1-flash 无 reasoning。
const CATALOG = {
  default: { provider: "zhipu-glm", model: "glm-5.3", reasoningEffort: "max" },
  groups: [
    {
      id: "zhipu-glm",
      name: "智谱 GLM",
      models: [{ id: "glm-5.3", name: "GLM-5.3", reasoning: { efforts: [{ id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "max" } }],
    },
    {
      id: "kimi-coding",
      name: "Kimi Coding",
      models: [
        { id: "k3.1-pro", name: "Kimi K3.1 Pro", reasoning: { efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }], defaultEffort: "medium" } },
        { id: "k3.1-flash", name: "Kimi K3.1 Flash" },
      ],
    },
  ],
};

describe("apiBase", () => {
  it("uses the plain /api/ surface for a harness page", () => {
    expect(apiBase("/")).toBe("/api/");
    expect(apiBase("/app/session/abc")).toBe("/api/");
    expect(apiBase(undefined)).toBe("/api/");
  });

  it("uses the share gateway prefix for a myco-served page", () => {
    expect(apiBase("/gw/sh-pc-env-dsh/app/")).toBe("/gw/sh-pc-env-dsh/app/api/");
    expect(apiBase("/gw/sh-pc-env-dsh/app/session/x")).toBe("/gw/sh-pc-env-dsh/app/api/");
  });
});

describe("coarseNow", () => {
  it("is off for a fine pointer on a wide viewport", () => {
    expect(
      coarseNow({
        matchMedia: () => ({ matches: false }),
        innerWidth: 1440,
        innerHeight: 900,
        hasTouch: false,
      }),
    ).toBe(false);
  });

  it("is on for a coarse pointer even on a wide viewport", () => {
    expect(
      coarseNow({
        matchMedia: (query) => ({ matches: query === "(pointer: coarse)" }),
        innerWidth: 1280,
        innerHeight: 800,
        hasTouch: false,
      }),
    ).toBe(true);
  });

  it("is on for a touch narrow viewport when matchMedia cannot tell", () => {
    expect(
      coarseNow({ innerWidth: 724, innerHeight: 727, hasTouch: true }),
    ).toBe(true);
    expect(coarseNow({ innerWidth: 724, innerHeight: 727, hasTouch: false })).toBe(false);
  });

  it("survives a throwing matchMedia", () => {
    expect(
      coarseNow({
        matchMedia: () => {
          throw new Error("unsupported");
        },
        innerWidth: 412,
        innerHeight: 915,
        hasTouch: true,
      }),
    ).toBe(true);
  });
});

describe("sessionIdFromBody", () => {
  it("extracts the first session id", () => {
    expect(sessionIdFromBody('{"payload":{"args":{"request":{"sessionId":"session-abc"}}}}')).toBe("session-abc");
  });

  it("returns undefined when there is none", () => {
    expect(sessionIdFromBody('{"method":"session/list"}')).toBeUndefined();
    expect(sessionIdFromBody(undefined)).toBeUndefined();
    expect(sessionIdFromBody(42)).toBeUndefined();
  });
});

describe("selectModelSelection", () => {
  it("切换模型时只用目标模型自己的 defaultEffort（GLM max → K3.1 Pro medium）", () => {
    const current = { provider: "zhipu-glm", model: "glm-5.3", reasoningEffort: "max" };
    expect(selectModelSelection(CATALOG, current, "kimi-coding", "k3.1-pro")).toEqual({
      provider: "kimi-coding",
      model: "k3.1-pro",
      reasoningEffort: "medium",
    });
  });

  it("目标模型没有默认等级时整个省略 reasoningEffort，绝不硬塞当前等级", () => {
    const current = { provider: "zhipu-glm", model: "glm-5.3", reasoningEffort: "max" };
    const selection = selectModelSelection(CATALOG, current, "kimi-coding", "k3.1-flash");
    expect(selection).toEqual({ provider: "kimi-coding", model: "k3.1-flash" });
    expect("reasoningEffort" in selection).toBe(false);
  });

  it("重选同一个模型时沿用当前等级（该等级来自此模型自己的 efforts，天然兼容）", () => {
    const current = { provider: "kimi-coding", model: "k3.1-pro", reasoningEffort: "high" };
    expect(selectModelSelection(CATALOG, current, "kimi-coding", "k3.1-pro")).toEqual({
      provider: "kimi-coding",
      model: "k3.1-pro",
      reasoningEffort: "high",
    });
  });

  it("重选同一模型但当前无等级时退回该模型的 defaultEffort", () => {
    expect(selectModelSelection(CATALOG, { provider: "kimi-coding", model: "k3.1-pro" }, "kimi-coding", "k3.1-pro").reasoningEffort).toBe("medium");
  });

  it("当前会话未知（新会话）时同样只用目标模型的 defaultEffort", () => {
    expect(selectModelSelection(CATALOG, undefined, "zhipu-glm", "glm-5.3").reasoningEffort).toBe("max");
    expect(selectModelSelection(CATALOG, undefined, "kimi-coding", "k3.1-flash")).toEqual({ provider: "kimi-coding", model: "k3.1-flash" });
  });

  it("目录里找不到目标模型时省略 reasoningEffort（也不会发出不兼容等级）", () => {
    const selection = selectModelSelection(CATALOG, { provider: "zhipu-glm", model: "glm-5.3", reasoningEffort: "max" }, "unknown", "m1");
    expect(selection).toEqual({ provider: "unknown", model: "m1" });
  });
});

// ── defaultEffortFor（2026-11-05 用户定稿：继承当前等级 / 无则 max / 退 defaultEffort）──
describe("defaultEffortFor", () => {
  const glm = CATALOG.groups[0].models[0];          // efforts: medium/high/max, default=max
  const k31 = CATALOG.groups[1].models[0];          // efforts: low/medium/high, default=medium（无 max）
  const flash = CATALOG.groups[1].models[1];        // 无 reasoning

  it("继承当前模型的等级（目标支持时）", () => {
    expect(defaultEffortFor(glm, { reasoningEffort: "high" })).toBe("high");
    expect(defaultEffortFor(k31, { reasoningEffort: "low" })).toBe("low");
  });

  it("当前等级目标不支持时，优先 max", () => {
    expect(defaultEffortFor(glm, { reasoningEffort: "low" })).toBe("max"); // low 不在 glm 列表 → max
    expect(defaultEffortFor(k31, { reasoningEffort: "max" })).toBe("medium"); // k31 无 max → defaultEffort
  });

  it("当前模型无等级时默认 max", () => {
    expect(defaultEffortFor(glm, undefined)).toBe("max");
    expect(defaultEffortFor(glm, {})).toBe("max");
    expect(defaultEffortFor(k31, {})).toBe("medium"); // 无 max 时退 defaultEffort
  });

  it("模型没有等级概念 → undefined（调用方省略字段）", () => {
    expect(defaultEffortFor(flash, { reasoningEffort: "max" })).toBeUndefined();
    expect(defaultEffortFor(undefined, {})).toBeUndefined();
  });
});

