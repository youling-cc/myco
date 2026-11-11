import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Youling 身份/设备管理(2026-10-06 env 并入):IdentityPanel/MycoDevices/identityStore
// 源码已 git mv 进本工程 src/(env/ui 退役删除),@wsui alias 指向自身 src。
export default defineConfig({
  cacheDir: 'D:/Projects/labs/.vitecache/home',
  plugins: [react()],
  base: './',
  // 第63轮 env 合并：identity command 已在 home 自身注册，走 invoke 不再强制 HTTP//   define: { 'import.meta.env.VITE_FORCE_HTTP': JSON.stringify('1') },
  resolve: {
    alias: {
      '@wsui': path.resolve(__dirname, './src'),
    },
  },
  clearScreen: false,
  server: { port: 5177, strictPort: true },
  // 2026-10-07 分包：入口 chunk 曾 1.11MB——esbuild 对 >1MB 且需降级的输入改走临时
  // 文件，其 os.Remove 在本机被拒（[vite:esbuild-transpile] Access is denied），
  // 标准 `vite build` 必失败（发版链同步受阻）。把 node_modules 拆出后每块 <1MB，
  // 既修构建阻塞又改善首屏加载（vite 长期警告 chunk 过大）。
  build: {
    target: 'es2019',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // 2026-10-10 修（构建阻塞）：原 `id.includes('react')` 宽匹配把 react-* 生态
          // （依赖 vendor 的包，如 react-router / @radix 等）塞进 react-vendor →
          // 与 vendor 互相 import 成环，Rollup 报
          // 「Circular chunk: vendor -> react-vendor -> vendor」并中止构建。
          // 收紧为 react 核心三件（单向依赖）——与手机端 apps/phone/vite.config.ts
          // 同款修法（那边已修并留了说明，PC 端漏修，本批新 import 触发）。
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor'
          return 'vendor'
        },
      },
    },
  },
})
