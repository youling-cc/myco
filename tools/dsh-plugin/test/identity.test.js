/**
 * Pure-function and process-level tests for the identity probe.
 *
 * No DSH import here: `identity.js` is the standalone half of the plugin, so
 * the whole decision table can be pinned with plain Node semantics.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_NAME,
  MISSING_SESSION_ID,
  baseText,
  cleanLine,
  contextText,
  didLines,
  isLoggedIn,
  parseStatus,
  queryIdentity,
  readIdentity,
  readNames,
  resolveMycoExe,
} from "../src/identity.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/status-fixture.mjs", import.meta.url));

/** One healthy payload, reused across assertions. */
const HEALTHY = Object.freeze({
  accounts: 5,
  configDir: "C:\\Users\\example\\AppData\\Roaming\\youling",
  delegations: 6,
  deviceDid: "did:myco:z6MkExampleDeviceDIDxxxxxxxxxxxxxxxxxxxxxxxxxx",
  role: "embodiment",
  rootDid: "did:youling:z6MkExampleAccountDIDxxxxxxxxxxxxxxxxxxxxxxxxx",
  version: "0.3.193",
});

/**
 * Run the fixture as the mock `myco` executable.
 * @param scenario - fixture scenario name.
 * @param options - extra probe options.
 * @returns the probe result.
 */
function probe(scenario, options = {}) {
  return queryIdentity({
    exe: process.execPath,
    statusArgs: [FIXTURE, scenario],
    timeoutMs: 5_000,
    ...options,
  });
}

describe("parseStatus", () => {
  it("parses a clean payload", () => {
    expect(parseStatus(JSON.stringify(HEALTHY))).toMatchObject({ rootDid: HEALTHY.rootDid, role: "embodiment" });
  });

  it("tolerates a banner around the JSON object", () => {
    expect(parseStatus(`youling cli 0.3.193\n${JSON.stringify(HEALTHY)}\n`)).toMatchObject({ accounts: 5 });
  });

  it("rejects non-JSON, empty, array, and scalar payloads", () => {
    expect(parseStatus("myco: unexpected internal error")).toBeUndefined();
    expect(parseStatus("")).toBeUndefined();
    expect(parseStatus("[1,2,3]")).toBeUndefined();
    expect(parseStatus("42")).toBeUndefined();
    expect(parseStatus(undefined)).toBeUndefined();
  });
});

describe("isLoggedIn", () => {
  it("accepts a complete identity", () => {
    expect(isLoggedIn(HEALTHY)).toBe(true);
  });

  it("rejects the unlinked shape even when the device DID is valid", () => {
    expect(isLoggedIn({ ...HEALTHY, rootDid: null, role: "unlinked", accounts: 0 })).toBe(false);
  });

  it("rejects half-broken shapes", () => {
    expect(isLoggedIn({ ...HEALTHY, role: "unlinked" })).toBe(false);
    expect(isLoggedIn({ ...HEALTHY, deviceDid: undefined })).toBe(false);
    expect(isLoggedIn({ ...HEALTHY, deviceDid: "" })).toBe(false);
    expect(isLoggedIn({ ...HEALTHY, rootDid: "did:example:abc" })).toBe(false);
    // 2026-10-31 拍板：DID 体不能为空——"did:youling:" 是截断串不是身份
    expect(isLoggedIn({ ...HEALTHY, rootDid: "did:youling:" })).toBe(false);
    expect(isLoggedIn({ ...HEALTHY, deviceDid: "did:myco:" })).toBe(false);
    expect(isLoggedIn(undefined)).toBe(false);
  });
});

describe("readIdentity", () => {
  it("returns both DIDs when logged in", () => {
    expect(readIdentity(HEALTHY)).toEqual({ rootDid: HEALTHY.rootDid, deviceDid: HEALTHY.deviceDid });
  });

  it("returns nothing for every degraded shape", () => {
    expect(readIdentity(undefined)).toBeUndefined();
    expect(readIdentity({ ...HEALTHY, role: "unlinked" })).toBeUndefined();
    expect(readIdentity({ ...HEALTHY, deviceDid: null })).toBeUndefined();
    expect(readIdentity({ ...HEALTHY, deviceDid: "not-a-did" })).toBeUndefined();
    expect(readIdentity({ ...HEALTHY, rootDid: "did:youling:a b" })).toBeUndefined();
  });
});

describe("readNames", () => {
  it("reads the matching account and device names from myco's local registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myco-identity-names-"));
    try {
      await writeFile(join(directory, "accounts.json"), JSON.stringify([
        { did: HEALTHY.rootDid, name: "CJ26", loggedOut: false },
        { did: HEALTHY.rootDid, name: "logged out copy", loggedOut: true },
      ]), "utf8");
      await writeFile(join(directory, "authorized-dids.json"), JSON.stringify([
        { did: HEALTHY.deviceDid, name: "DESKTOP-DEV", revoked: false },
        { did: HEALTHY.deviceDid, name: "revoked copy", revoked: true },
      ]), "utf8");
      await expect(readNames({ ...HEALTHY, configDir: directory })).resolves.toEqual({
        accountName: "CJ26",
        deviceName: "DESKTOP-DEV",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("omits names when the registry is missing, corrupt, or not logged in", async () => {
    const missing = await mkdtemp(join(tmpdir(), "myco-identity-missing-"));
    try {
      await expect(readNames({ ...HEALTHY, configDir: missing })).resolves.toEqual({});
      await expect(readNames({ ...HEALTHY, role: "unlinked" })).resolves.toEqual({});
    } finally {
      await rm(missing, { recursive: true, force: true });
    }
  });
});

describe("text rendering", () => {
  it("renders the base block with a title", () => {
    expect(baseText("session-abc", "申诉管理")).toBe([
      "[myco:session-identity] 本会话自身身份（myco runtime context）",
      "- sessionId: session-abc",
      "- title: 申诉管理",
    ].join("\n"));
  });

  it("omits the title line entirely when the title is missing", () => {
    const text = baseText("session-abc", undefined);
    expect(text).toBe([
      "[myco:session-identity] 本会话自身身份（myco runtime context）",
      "- sessionId: session-abc",
    ].join("\n"));
    expect(text).not.toContain("title");
  });

  it("appends the DID block only when logged in", () => {
    const identity = readIdentity(HEALTHY);
    const text = contextText("session-abc", "申诉管理", identity);
    expect(text.split("\n").slice(-2)).toEqual([
      `- youling账号: <${HEALTHY.rootDid}>`,
      `- myco设备: <${HEALTHY.deviceDid}>`,
    ]);
    expect(contextText("session-abc", "申诉管理", undefined)).toBe(baseText("session-abc", "申诉管理"));
  });

  it("prefixes the optional human-friendly names without changing the DID boundary", () => {
    const identity = { ...readIdentity(HEALTHY), accountName: "CJ26", deviceName: "DESKTOP-DEV" };
    expect(didLines(identity).split("\n")).toEqual([
      `- youling账号: CJ26 <${HEALTHY.rootDid}>`,
      `- myco设备: DESKTOP-DEV <${HEALTHY.deviceDid}>`,
    ]);
  });

  it("never renders a placeholder token", () => {
    for (const identity of [readIdentity(HEALTHY), undefined]) {
      const text = contextText("session-abc", "申诉管理", identity);
      expect(text).not.toMatch(/undefined|null|\(unknown\)|\.\.\.|…/);
    }
  });

  it("exposes the stable context name and the defensive session-id placeholder", () => {
    expect(CONTEXT_NAME).toBe("myco:session-identity");
    expect(MISSING_SESSION_ID).toBe("(missing session id)");
    expect(didLines(undefined)).toBe("");
  });

  it("cleans control characters and collapses whitespace in titles", () => {
    expect(cleanLine("\u001b[31m申诉  管理\u001b[0m")).toBe("[31m申诉 管理 [0m");
    expect(cleanLine("   ")).toBeUndefined();
    expect(cleanLine(undefined)).toBeUndefined();
  });
});

describe("resolveMycoExe", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local", PATH: "C:\\bin;D:\\tools" };

  it("prefers the configured path, then MYCO_EXE, then the default install dir, then PATH", () => {
    expect(resolveMycoExe({ configured: "D:\\custom\\myco.exe", env, platform: "win32", home: "C:\\Users\\example", exists: () => true }))
      .toEqual({ exe: "D:\\custom\\myco.exe", source: "config" });
    expect(resolveMycoExe({ configured: "  ", env: { ...env, MYCO_EXE: "E:\\myco.exe" }, platform: "win32", home: "C:\\Users\\example", exists: () => true }))
      .toEqual({ exe: "E:\\myco.exe", source: "env" });
    expect(resolveMycoExe({ env, platform: "win32", home: "C:\\Users\\example", exists: (path) => path.endsWith(join("Programs", "Youling", "myco.exe")) }))
      .toEqual({ exe: join("C:\\Users\\example\\AppData\\Local", "Programs", "Youling", "myco.exe"), source: "default" });
    expect(resolveMycoExe({ env, platform: "win32", home: "C:\\Users\\example", exists: (path) => path === join("D:\\tools", "myco.exe") }))
      .toEqual({ exe: join("D:\\tools", "myco.exe"), source: "path" });
  });

  it("falls back to a bare name when nothing is found, and to PATH on other platforms", () => {
    expect(resolveMycoExe({ env: { PATH: "" }, platform: "win32", home: "C:\\Users\\example", exists: () => false }))
      .toEqual({ exe: "myco.exe", source: "none" });
    expect(resolveMycoExe({ env: { PATH: "/usr/local/bin" }, platform: "linux", home: "/home/example", exists: (path) => path === join("/usr/local/bin", "myco") }))
      .toEqual({ exe: join("/usr/local/bin", "myco"), source: "path" });
  });
});

describe("queryIdentity", () => {
  it("returns the parsed status for a healthy CLI", async () => {
    const result = await probe("loggedIn");
    expect(result.reason).toBe("ok");
    expect(result.status).toMatchObject({ role: "embodiment", deviceDid: HEALTHY.deviceDid });
    expect(result.elapsedMs).toBeLessThan(2_500);
  });

  it("parses a payload wrapped in CLI banner noise", async () => {
    const result = await probe("noisy");
    expect(result.reason).toBe("ok");
    expect(result.status.rootDid).toBe(HEALTHY.rootDid);
  });

  it("degrades on garbage output", async () => {
    const result = await probe("garbage");
    expect(result).toMatchObject({ reason: "bad-output", status: undefined });
  });

  it("degrades on a non-zero exit", async () => {
    const result = await probe("exitNonZero");
    expect(result).toMatchObject({ reason: "exit", status: undefined });
  });

  it("degrades when the executable does not exist", async () => {
    const result = await queryIdentity({ exe: join(FIXTURE, "does-not-exist.exe") });
    expect(result).toMatchObject({ reason: "spawn", status: undefined });
  });

  it("degrades when no executable is configured at all", async () => {
    expect(await queryIdentity({ exe: "  " })).toMatchObject({ reason: "no-exe", status: undefined });
  });

  it("kills a hung child at the timeout and reports the elapsed time", async () => {
    const result = await queryIdentity({
      exe: process.execPath,
      statusArgs: ["-e", "setTimeout(()=>{},5000)"],
      timeoutMs: 1_000,
    });
    expect(result.reason).toBe("timeout");
    expect(result.status).toBeUndefined();
    expect(result.elapsedMs).toBeLessThanOrEqual(1_200);
    expect(typeof result.pid).toBe("number");

    await expectGone(result.pid);
  }, 15_000);

  it("leaves no child process behind after 20 consecutive timeouts", async () => {
    const pids = new Set();
    const startedAt = Date.now();
    for (let index = 0; index < 20; index += 1) {
      const result = await queryIdentity({
        exe: process.execPath,
        statusArgs: ["-e", "setTimeout(()=>{},5000)"],
        timeoutMs: 250,
      });
      expect(result.reason).toBe("timeout");
      expect(result.elapsedMs).toBeLessThanOrEqual(450);
      expect(typeof result.pid).toBe("number");
      pids.add(result.pid);
    }
    // Windows 下连续拉起 20 个进程可能复用同一个 pid（快速退出 + pid 回收），
    // 因此允许 19/20 的唯一 pid；关键是「每个 pid 事后都已退出」。
    expect(pids.size).toBeGreaterThanOrEqual(19);
    for (const pid of pids) await expectGone(pid);
    // 20 x 250ms budgets; a leaking pool would serialize far past this.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 30_000);
});

/**
 * Assert a pid is gone, waiting briefly for Windows to release the handle.
 * @param pid - process id returned by the probe.
 * @returns a promise that rejects when the child is still alive.
 */
async function expectGone(pid) {
  expect(pid).toBeGreaterThan(0);
  const deadline = Date.now() + 3_000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      alive = false;
      expect(error.code).toBe("ESRCH");
      break;
    }
  }
  expect(alive).toBe(false);
}
