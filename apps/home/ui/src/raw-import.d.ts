/**
 * raw-import.d.ts — Vite `?raw` 导入的类型声明（2026-10-23）。
 *
 * 为什么需要：PC UI 的 tsconfig 没有装 `@types/node`（`tsc` 里 `node:fs` 会报 TS2307，
 * 见既有的 `task-env.test.tsx`）。测试要做"接线合同"（读源码断言列表行走
 * `runTaskOpen` 而不是旧的 `openExternalUrl(openUrl)`）时，用 Vite 的 `?raw`
 * 把源文件当字符串导入即可——不依赖 node 类型，也不把源码塞进测试文件里抄一份。
 */
declare module '*?raw' {
  const source: string
  export default source
}
