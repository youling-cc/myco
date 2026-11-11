/**
 * Plugin-level tests: registration shape, the `system-prompt/assemble`
 * waterfall, the three login states, the title fallbacks, and the absence of
 * any cross-request cache.
 *
 * The harness reproduces DSH rc.5's two seams faithfully:
 * `assemble()` first resolves every registered runtime context through its
 * `text(context)` callback, then runs the `system-prompt/assemble` waterfall,
 * whose `next()` returns that same assembly. A real child process plays
 * `myco.exe` for every case, so the wiring is exercised end to end.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTEXT_NAME, apply } from "../src/index.js";
import { DEFAULT_ORDER } from "../src/identity.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/status-fixture.mjs", import.meta.url));

/**
 * Build a fake Cordis context that records what the plugin registers.
 * @param options - services to expose through `ctx.get` and plugin config.
 * @returns the recorded registration, the waterfall hook, and the context.
 */
function createHarness({ services = {}, config = {} } = {}) {
  const registrations = [];
  const skillRegistrations = [];
  const listeners = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get: (serviceName) => services[serviceName],
    skills: {
      register: (skill) => {
        skillRegistrations.push(skill);
        return () => {};
      },
    },
    systemPrompt: {
      context: (definition) => {
        registrations.push(definition);
        return () => {};
      },
      getContextOrder: () => 100,
    },
    on: (event, listener, options) => {
      listeners.set(event, { listener, options });
      return () => {};
    },
  };
  apply(ctx, {
    mycoExe: process.execPath,
    statusArgs: [FIXTURE, "loggedIn"],
    timeoutMs: 5_000,
    ...config,
  });
  return {
    ctx,
    registration: registrations.find((entry) => entry.name === CONTEXT_NAME),
    registrations,
    skillRegistrations,
    hook: listeners.get("system-prompt/assemble"),
  };
}

/**
 * Run one assembly exactly the way DSH rc.5 does:
 *
 * 1. `assemble()` resolves every registered context through `text(context)`.
 * 2. The `system-prompt/assemble` waterfall runs (`next()` returns the same
 *    assembly).
 * 3. `refreshContext()` runs right before the request is admitted and
 *    **re-resolves every registered provider**, keeping waterfall-only
 *    entries untouched.
 *
 * Step 3 is what makes an asynchronously probed value hard to keep; the fake
 * below reproduces it so a regression cannot pass the suite again.
 *
 * @param harness - value returned by {@link createHarness}.
 * @param context - assembly context (`{ agent, signal }`).
 * @param options - `refresh: false` stops after the waterfall.
 * @returns the contexts the request would render.
 */
async function assemble(harness, context, { refresh = true } = {}) {
  const resolve = (registration) => ({
    name: registration.name,
    text: registration.text(context),
    interpolate: registration.interpolate,
  });
  const assembly = {
    contexts: harness.registrations.map(resolve),
    tools: [],
  };
  const result = await harness.hook.listener(assembly, context, async () => assembly);
  if (!refresh || !Array.isArray(result?.contexts)) return result.contexts;

  const contexts = result.contexts.map((entry) => {
    const registration = harness.registrations.find((candidate) => candidate.name === entry.name);
    return registration === undefined ? entry : resolve(registration);
  });
  for (const registration of harness.registrations) {
    if (!contexts.some((entry) => entry.name === registration.name)) contexts.push(resolve(registration));
  }
  return contexts;
}

/**
 * Build the mock assembly context for one session.
 * @param sessionId - session id.
 * @returns an assembly context shaped like DSH's.
 */
function sessionContext(sessionId) {
  return { agent: { session: { id: sessionId } }, signal: undefined };
}

/**
 * A fake `sessionTitle` service backed by a map.
 * @param titles - session id to title.
 * @returns the service object.
 */
function titleService(titles) {
  return { get: (session) => (titles.has(session.id) ? { title: titles.get(session.id), source: { kind: "fallback" } } : undefined) };
}

/**
 * Find the plugin's entry in an assembled context list.
 * @param contexts - assembled contexts.
 * @returns the entry.
 */
function entryOf(contexts) {
  const matches = contexts.filter((entry) => entry.name === CONTEXT_NAME);
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("registration shape", () => {
  it("registers exactly one required, non-interpolated runtime context at order 130", () => {
    const harness = createHarness();
    expect(harness.registrations).toHaveLength(1);
    expect(harness.registration).toMatchObject({
      name: "myco:session-identity",
      order: 130,
      required: true,
      interpolate: false,
    });
    expect(DEFAULT_ORDER).toBe(130);
    expect(harness.hook.options).toEqual({ prepend: true });
  });

  it("honours an explicit order override but never a non-finite one", () => {
    expect(createHarness({ config: { order: 127 } }).registration.order).toBe(127);
    expect(createHarness({ config: { order: Number.NaN } }).registration.order).toBe(130);
    expect(createHarness({ config: { order: "130" } }).registration.order).toBe(130);
  });

  it("registers the built-in myco skill", () => {
    const harness = createHarness();
    expect(harness.skillRegistrations).toHaveLength(1);
    expect(harness.skillRegistrations[0]).toMatchObject({
      name: "myco",
      description: expect.any(String),
      whenToUse: expect.any(String),
      invocation: { modelInvocable: true, userInvocable: true },
      source: "@myco/dsh-plugin",
      content: expect.stringContaining("宿主集成"),
    });
  });
});

describe("injected text", () => {
  it("logged in: session id, title, and both DIDs", async () => {
    const harness = createHarness({ services: { sessionTitle: titleService(new Map([["session-alpha", "申诉管理"]])) } });
    const contexts = await assemble(harness, sessionContext("session-alpha"));
    const entry = entryOf(contexts);
    expect(entry.interpolate).toBe(false);
    expect(entry.text).toMatchSnapshot();
    expect(entry.text.split("\n")).toEqual([
      "[myco:session-identity] 本会话自身身份（myco runtime context）",
      "- sessionId: session-alpha",
      "- title: 申诉管理",
      "- youling账号: <did:youling:z6MkExampleAccountDIDxxxxxxxxxxxxxxxxxxxxxxxxx>",
      "- myco设备: <did:myco:z6MkExampleDeviceDIDxxxxxxxxxxxxxxxxxxxxxxxxxx>",
    ]);
  });

  it("keeps the probed DIDs through the post-waterfall refreshContext re-resolution", async () => {
    const harness = createHarness({ services: { sessionTitle: titleService(new Map([["session-alpha", "申诉管理"]])) } });
    const context = sessionContext("session-alpha");
    // `refresh: false` is the raw waterfall value, `refresh: true` is what the
    // agent loop actually renders after `refreshContext()`.
    const waterfall = entryOf(await assemble(harness, context, { refresh: false }));
    const rendered = entryOf(await assemble(harness, context, { refresh: true }));
    expect(waterfall.text).toContain("- youling账号: <did:youling:");
    expect(rendered.text).toBe(waterfall.text);
    expect(rendered.text).toContain("- myco设备: <did:myco:");
  });

  it("logged out: a valid device DID is still not shown", async () => {
    const harness = createHarness({
      services: { sessionTitle: titleService(new Map([["session-beta", "申诉管理"]])) },
      config: { statusArgs: [FIXTURE, "unlinked"] },
    });
    const contexts = await assemble(harness, sessionContext("session-beta"));
    const entry = entryOf(contexts);
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("did:");
  });

  it("half logged in (role=unlinked, valid rootDid): no DID lines", async () => {
    const harness = createHarness({
      services: { sessionTitle: titleService(new Map([["session-gamma", "申诉管理"]])) },
      config: { statusArgs: [FIXTURE, "halfLoggedIn"] },
    });
    const entry = entryOf(await assemble(harness, sessionContext("session-gamma")));
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("did:");
  });

  it("half logged in (valid rootDid, missing deviceDid): no DID lines", async () => {
    const harness = createHarness({
      services: { sessionTitle: titleService(new Map([["session-delta", "申诉管理"]])) },
      config: { statusArgs: [FIXTURE, "noDevice"] },
    });
    const entry = entryOf(await assemble(harness, sessionContext("session-delta")));
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("did:");
  });

  it("title missing: the title line disappears entirely", async () => {
    const harness = createHarness({ services: { sessionTitle: titleService(new Map()) } });
    const entry = entryOf(await assemble(harness, sessionContext("session-epsilon")));
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("title");
    expect(entry.text).toContain("- youling账号: <did:youling:");
  });

  it("no title service at all: base lines plus DIDs, without a title line", async () => {
    const harness = createHarness({ services: {} });
    const entry = entryOf(await assemble(harness, sessionContext("session-zeta")));
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("title");
  });

  it("broken title shapes degrade to no title line", async () => {
    const throwing = { get: () => { throw new Error("title service exploded"); } };
    const nonString = { get: () => ({ title: 42 }) };
    for (const service of [throwing, nonString]) {
      const entry = entryOf(await assemble(createHarness({ services: { sessionTitle: service } }), sessionContext("session-eta")));
      expect(entry.text).not.toContain("title");
      expect(entry.text).toContain("- sessionId: session-eta");
    }
    const blank = { get: () => ({ title: "   " }) };
    expect(entryOf(await assemble(createHarness({ services: { sessionTitle: blank } }), sessionContext("session-theta"))).text)
      .not.toContain("title");
  });

  it("falls back to the title projection when the title service is absent", async () => {
    const projections = { stateOf: (_session, key) => (key === "title" ? "投影标题" : null) };
    const entry = entryOf(await assemble(createHarness({ services: { sessionProjections: projections } }), sessionContext("session-iota")));
    expect(entry.text).toContain("- title: 投影标题");
  });

  it("timeout: only the base lines survive", async () => {
    const harness = createHarness({
      services: { sessionTitle: titleService(new Map([["session-kappa", "慢查询"]])) },
      config: { statusArgs: [FIXTURE, "hang"], timeoutMs: 300 },
    });
    const startedAt = Date.now();
    const entry = entryOf(await assemble(harness, sessionContext("session-kappa")));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("did:");
  });

  it("garbage output: only the base lines survive", async () => {
    const harness = createHarness({ config: { statusArgs: [FIXTURE, "garbage"] } });
    const entry = entryOf(await assemble(harness, sessionContext("session-lambda")));
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("did:");
  });

  it("non-zero exit: only the base lines survive", async () => {
    const harness = createHarness({ config: { statusArgs: [FIXTURE, "exitNonZero"] } });
    const entry = entryOf(await assemble(harness, sessionContext("session-mu")));
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("did:");
  });

  it("missing executable: only the base lines survive", async () => {
    const harness = createHarness({ config: { mycoExe: join(FIXTURE, "nope.exe") } });
    const entry = entryOf(await assemble(harness, sessionContext("session-nu")));
    expect(entry.text).toMatchSnapshot();
    expect(entry.text).not.toContain("did:");
  });

  it("never mentions a placeholder token in any state", async () => {
    for (const statusArgs of [["loggedIn"], ["unlinked"], ["halfLoggedIn"], ["noDevice"], ["garbage"]]) {
      const entry = entryOf(await assemble(createHarness({ config: { statusArgs: [FIXTURE, ...statusArgs] } }), sessionContext("session-xi")));
      expect(entry.text).not.toMatch(/undefined|null|\(unknown\)|\.\.\.|…/);
    }
  });
});

describe("waterfall behaviour", () => {
  it("passes through without probing when the assembly has no agent", async () => {
    const harness = createHarness({ config: { statusArgs: [FIXTURE, "hang"], timeoutMs: 60_000 } });
    const startedAt = Date.now();
    const contexts = await assemble(harness, { agent: undefined, signal: undefined });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].text).toBe("");
  });

  it("re-reads the title and the login state on every request (no cross-request cache)", async () => {
    const titles = new Map([["session-omicron", "第一轮标题"]]);
    const harness = createHarness({ services: { sessionTitle: titleService(titles) } });
    // One Session object across both turns, exactly like a live agent: any
    // cross-request reuse would surface as the stale first-turn title.
    const context = sessionContext("session-omicron");

    const first = entryOf(await assemble(harness, context)).text;
    expect(first).toContain("- title: 第一轮标题");
    expect(first).toContain("- youling账号: <did:youling:");

    titles.set("session-omicron", "第二轮标题");
    const second = entryOf(await assemble(harness, context)).text;
    expect(second).toContain("- title: 第二轮标题");
    expect(second).not.toContain("第一轮标题");
  });

  it("reflects a login change between two requests of the same session", async () => {
    const harness = createHarness({ services: { sessionTitle: titleService(new Map([["session-pi", "申诉管理"]])) } });
    const loggedIn = entryOf(await assemble(harness, sessionContext("session-pi"))).text;
    expect(loggedIn.match(/did:/g)).toHaveLength(2);

    const loggedOut = entryOf(await assemble(createHarness({
      services: { sessionTitle: titleService(new Map([["session-pi", "申诉管理"]])) },
      config: { statusArgs: [FIXTURE, "unlinked"] },
    }), sessionContext("session-pi"))).text;
    expect(loggedOut.match(/did:/g)).toBeNull();
  });

  it("adds the context when a previous listener dropped it", async () => {
    const harness = createHarness();
    const context = sessionContext("session-rho");
    const assembly = { contexts: [] };
    const result = await harness.hook.listener(assembly, context, async () => assembly);
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0]).toMatchObject({ name: CONTEXT_NAME, interpolate: false });
    expect(result.contexts[0].text).toContain("- sessionId: session-rho");
  });

  it("returns the assembly untouched when next() did not produce contexts", async () => {
    const harness = createHarness();
    const result = await harness.hook.listener({}, sessionContext("session-sigma"), async () => undefined);
    expect(result).toBeUndefined();
  });

  it("writes one JSONL timing line per assembly when a debug log is configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myco-identity-log-"));
    const logPath = join(directory, "timing.jsonl");
    try {
      const harness = createHarness({
        services: { sessionTitle: titleService(new Map([["session-tau", "计时"]])) },
        config: { debugLog: logPath },
      });
      await assemble(harness, sessionContext("session-tau"));
      await assemble(harness, sessionContext("session-tau"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      // debugLog 也承载 listener 诊断行（apply-reached / ready / ...）；
      // 本断言只关心「每次 assembly 一行 identity timing」。
      const lines = records.filter((record) => record.listener === undefined);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({ sessionId: "session-tau", title: "计时", loggedIn: true, probe: "ok", didCount: 2 });
      expect(lines[0].probeMs).toBeGreaterThanOrEqual(0);
      expect(lines[0].totalMs).toBeGreaterThanOrEqual(lines[0].probeMs);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
