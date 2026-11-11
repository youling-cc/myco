/**
 * Cross-run vector harness: replays the shared judge-vectors.json against
 * the ported JS engine, mirroring exactly what the Rust side runs —
 * `effective_caps(share, grant)` then `caps_violation_as(eff,
 * "api/"+method, admin=false)` — and comparing allow/rule bit for bit.
 *
 * Vector file (single source of truth, owned by the myco session):
 *   repo-y/eval/vnet/judge-vectors.json
 *
 * Run: node test/judge-vectors.test.js
 */

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { effectiveCaps, judgeMethod } from "../src/judge-engine.js";

/**
 * Locate the shared vector file across the two supported layouts (no absolute
 * machine paths — those leak internal structure into the open-source export):
 *
 * 1. `MYCO_VECTOR_FILE` env (CI / custom checkout)
 * 2. **single-repo layout** (open source): `tools/dsh-plugin/test/` → `<repo>/eval/vnet/…`
 * 3. **dev layout**: `myco/dsh-plugin-identity/test/` → `repo-y/eval/vnet/…`
 *
 * 不写机器绝对路径（开源导出时会被判"内部路径泄漏"）。
 */
const CANDIDATES = [
  process.env.MYCO_VECTOR_FILE,
  fileURLToPath(new URL("../../../eval/vnet/judge-vectors.json", import.meta.url)),
  fileURLToPath(new URL("../../../repo-y/eval/vnet/judge-vectors.json", import.meta.url)),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

const VECTOR_FILE = CANDIDATES.find((candidate) => existsSync(candidate));

/**
 * Map one vector grant onto the engine's grant shape (owner by label, as
 * grant_is_owner: the "owner" label row is the owner entry).
 */
function engineGrant(grant) {
  if (grant === null || grant === undefined) return undefined;
  return {
    owner: grant.label === "owner",
    caps: grant.caps ?? null,
    visibility: grant.visibility ?? null,
  };
}

/**
 * @param {string} vectorFile - path to judge-vectors.json.
 * @returns {Promise<Array<{id, desc, mismatches, cases}>>} per-vector results.
 */
export async function runVectorFile(vectorFile = VECTOR_FILE) {
  const doc = JSON.parse(await readFile(vectorFile, "utf8"));
  const results = [];
  for (const vector of doc.vectors ?? []) {
    const cases = [];
    const single = vector.method !== undefined
      ? [{ method: vector.method, expect: vector.expect }]
      : vector.cases ?? [];
    for (const testCase of single) {
      const effective = effectiveCaps(vector.share.caps ?? {}, engineGrant(vector.grant));
      const verdict = judgeMethod(effective, testCase.method, false);
      const actual = verdict.allowed
        ? { allow: true }
        : { allow: false, rule: verdict.rule };
      const mismatch = testCase.expect.allow !== actual.allow
        || (testCase.expect.allow === false && testCase.expect.rule !== actual.rule);
      cases.push({ method: testCase.method, expect: testCase.expect, actual, mismatch });
    }
    results.push({
      id: vector.id,
      desc: vector.desc,
      mismatches: cases.filter((c) => c.mismatch).length,
      cases,
    });
  }
  return results;
}

/* ────────────────────────── dual-mode runner ────────────────────────────── */

const inline = [
  ["对拍：judge-vectors.json 全量逐位一致", async () => {
    const results = await runVectorFile();
    const bad = results.filter((r) => r.mismatches > 0);
    for (const r of bad) {
      for (const c of r.cases.filter((x) => x.mismatch)) {
        console.error(`MISMATCH ${r.id} ${c.method}: expect=${JSON.stringify(c.expect)} actual=${JSON.stringify(c.actual)}`);
      }
    }
    assert.deepEqual(bad.map((r) => r.id), [], "双端对拍必须逐位一致");
  }],
];

if (process.env.VITEST !== undefined) {
  const { describe, it } = await import("vitest");
  describe("judge vectors (cross-run)", () => {
    for (const [name, fn] of inline) it(name, fn);
  });
} else {
  let passed = 0;
  const failed = [];
  for (const [name, fn] of inline) {
    try {
      await fn();
      passed += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed.push(name);
      console.error(`FAIL ${name}\n    ${error?.message ?? error}`);
    }
  }
  const results = await runVectorFile().catch(() => []);
  console.log(`  （${results.length} 条向量 / ${results.reduce((n, r) => n + r.cases.length, 0)} 个用例）`);
  console.log(`\n${passed}/${inline.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}
