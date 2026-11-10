/**
 * rawText.d.ts — Vite `?raw` 导入的类型声明（2026-10-13 P1）。
 *
 * 用途：面板分工的**源码级回归测试**（src/panelsSplit.test.ts）要读组件源码做
 * "账号页不再渲染只读在线态"这类断言。此前同类测试用 node:fs/node:path（本项目没装
 * @types/node → tsc 基线多 3 条 TS2307）。走 Vite 原生 `?raw` 既不碰 node 类型，
 * 也不新增 tsc 错误（声明只对本工程的构建链生效，不污染全局 node 类型）。
 */
declare module '*?raw' {
  const text: string
  export default text
}
