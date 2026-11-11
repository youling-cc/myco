/**
 * Build `lib/` from `src/`.
 *
 * Server half (`index.js`, `identity.js`, `skill.js`) is copied byte-for-byte:
 * the DSH loader imports it as published ESM.
 *
 * Client half (`client.js`) is **bundled** into one self-contained classic
 * script. DSH serves plugin client entries through its `/plugins/??…` concat
 * route as plain `<script>` files (not ES modules), so anything containing
 * `import` / `export` statements is a hard boot failure:
 *
 *     Uncaught SyntaxError: Cannot use import statement outside a module
 *
 * The bundle keeps `window.__ModuleLoader__.load({...})` as its only top-level
 * effect and inlines the DOM-free helpers from `model-picker-client.js`.
 */

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "src");
const target = join(root, "lib");
const toolsSource = join(root, "tools");
const toolsTarget = join(target, "tools");

/**
 * Recursively copy `.js` files from one tree to another.
 *
 * `client.js` is deliberately excluded at the top level: it is produced by
 * the esbuild step below, and copying the ESM source there first would leave
 * a broken classic script behind if bundling never ran (2026-11-09 真案：
 * 输出被管道截断 → EPIPE 提前退出 → lib/client.js 是原样 import 源码 →
 * 浏览器 "Cannot use import statement outside a module" 直接炸 boot)。
 *
 * @param from - source directory.
 * @param to - destination directory.
 * @param skip - top-level file names to skip.
 * @returns the number of files copied.
 */
async function copyTree(from, to, skip = new Set()) {
  let copied = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (!entry.isDirectory() && skip.has(entry.name)) continue;
    const fromPath = join(from, entry.name);
    const toPath = join(to, entry.name);
    if (entry.isDirectory()) {
      copied += await copyTree(fromPath, toPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      await mkdir(dirname(toPath), { recursive: true });
      await copyFile(fromPath, toPath);
      copied += 1;
    }
  }
  return copied;
}

const info = await stat(source).catch(() => undefined);
if (info === undefined || !info.isDirectory()) throw new Error(`build: missing source directory ${relative(root, source)}`);

await rm(target, { recursive: true, force: true });
const copied = await copyTree(source, target, new Set(["client.js"]));
console.log(`build: copied ${copied} file(s) ${relative(root, source)} -> ${relative(root, target)}`);

// ── tools（send.py / dsh_rpc.py / mcp-server.mjs / test_send.py）随包发布 ──────
if (await stat(toolsSource).catch(() => undefined)) {
  await rm(toolsTarget, { recursive: true, force: true });
  await mkdir(toolsTarget, { recursive: true });
  for (const entry of await readdir(toolsSource)) {
    if (entry.endsWith(".py") || entry.endsWith(".mjs")) {
      await copyFile(join(toolsSource, entry), join(toolsTarget, entry));
    }
  }
  console.log(`build: copied tools/ -> ${relative(root, toolsTarget)}`);
}

// ── client bundle（必须是普通脚本：DSH 用 <script> 串接，不是 ESM）────────────
const clientSource = join(source, "client.js");
const clientTarget = join(target, "client.js");
const clientInfo = await stat(clientSource).catch(() => undefined);
if (clientInfo === undefined) {
  console.log("build: no src/client.js — skipping client bundle");
} else {
  let esbuild;
  try {
    esbuild = await import("esbuild");
  } catch (error) {
    throw new Error(`build: bundling src/client.js needs esbuild (install it as a devDependency): ${error.message}`);
  }
  await esbuild.build({
    entryPoints: [clientSource],
    outfile: clientTarget,
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["es2020"],
    sourcemap: false,
    logLevel: "silent",
  });
  const bundle = await (await import("node:fs/promises")).readFile(clientTarget, "utf8");
  // 硬闸：client entry 一旦再次含 ESM 语句，DSH 会在 boot 阶段直接崩（2026-11-02 真案）。
  if (/^\s*(import|export)\s/m.test(bundle)) {
    throw new Error("build: bundled client.js still contains ESM import/export statements");
  }
  console.log(`build: bundled ${relative(root, clientSource)} -> ${relative(root, clientTarget)} (${bundle.length} bytes)`);
}

// ── final verification: a half-built lib/ must never pass ───────────────────
// (2026-11-09 真案复盘：输出被管道截断 → 本脚本在 esbuild 之前被 EPIPE 杀掉
//  → lib/client.js 留成原样 ESM 源码 → 浏览器 boot 直接 "Cannot use import
//  statement outside a module"。这里做终检，并把最后一行作为"完整跑完"的
//  哨兵：日志里没有 build: OK 就说明构建被截断，绝不可部署。)
{
  const { readFile } = await import("node:fs/promises");
  const client = await readFile(join(target, "client.js"), "utf8").catch(() => undefined);
  if (client === undefined) throw new Error("build: lib/client.js missing (client bundle did not run)");
  if (/^\s*(import|export)\s/m.test(client)) {
    throw new Error("build: lib/client.js contains ESM statements — bundling did not run to completion");
  }
  for (const required of ["index.js", "identity.js", "skill.js", "directory.js", "web-listener.js", "policy-proxy.js", "judge-engine.js", "signature.js"]) {
    const exists = await stat(join(target, required)).catch(() => undefined);
    if (exists === undefined) throw new Error(`build: lib/${required} missing`);
  }
}
console.log("build: OK");
