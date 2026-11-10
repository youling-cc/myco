import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 手机端 PWA。phone↔PC 走 WebRTC 直连（浏览器原生 API，无 wasm）；HttpTransport 走 /ta 代理。
// dev 下 terminal-agent 只绑 127.0.0.1:8100，浏览器跨端口会被 CORS 挡——
// 用 /ta 代理到本机 terminal-agent，同源 fetch 不触发预检。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 菌光 tokens/孢子图标单一源(packages/ui-kit)——与 home/aop 同源
      '@myco': path.resolve(__dirname, '../../packages/ui-kit/src'),
    },
  },
  // vitest 只收 src 下的纯函数单测；tests/ 是 Playwright E2E（npx playwright test 跑）。
  test: { include: ['src/**/*.test.{ts,tsx}'] },
  // 相对路径产物(顶层选项):APK 离线壳 file:///android_asset 下 '/assets/x.js' 会解析到
  // 文件系统根(file:///assets/)→JS 全 404(真机"JS资源=无"根因);'./' 双兼容 file:// 与云。
  base: './',
  build: {
    // ES2019：??（空值合并）/.?（可选链，ES2020）被 esbuild 转译成老式写法让老内核能解析；
    // 同时保留 **（幂，ES2016）为原生——若降到 ES2015，esbuild 会把 BigInt 的 ** 误转成
    // Math.pow(bigint,...)，对 BigInt 必然抛 "Cannot convert a BigInt value to a number"（百度灰屏根因）。
    target: 'es2019',
    // 2026-10-07 分包：入口 chunk 曾 2.2MB——esbuild 对 >1MB 且需降级（本端必须 es2019）的
    // 输入改走临时文件，其 os.Remove 在本机被拒（Access is denied）→ 标准 build/发版链必失败。
    // 把 node_modules 拆出后每块 <1MB，既修阻塞又改善手机端首屏（弱网收益更明显）。
    rollupOptions: {
      output: {
        // 2026-10-07 修循环 chunk + 大 chunk 双坑：
        // ① 原宽匹配 includes('react') 把 react-* 生态（依赖 vendor 的包）塞进
        //   react-vendor → 与 vendor 互相 import 成环——收紧为 react 核心三件（单向依赖）。
        // ② vendor 未压缩 3.67MB —— esbuild 对 >1MB 输入走临时文件，本机 %TEMP%
        //    写删异常（CLI 探针：60s 完成+产物即消失），标准 build 必炸。按包细拆
        //    （katex/noble 各一块）让每块 <1MB 走内存快路径。
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor'
          if (/[\\/]node_modules[\\/](katex|@noble)[\\/]/.test(id)) return 'katex-noble'
          if (/[\\/]node_modules[\\/](highlight\.js|rehype-highlight|lowlight)[\\/]/.test(id)) return 'hljs'
          if (/[\\/]node_modules[\\/]([\w@.-]*(react-markdown|remark-|rehype-|micromark|mdast-|hast-|unified|unist-|vfile|decode-named|property-information|web-namespaces|zwitch|html-void|ccount|escape-string|markdown-table|longest-streak|html-entities|html-urls)[\w@.-]*[\\/])/.test(id)) return 'md'
          return 'vendor'
        },
      },
    },
  },
  server: {
    host: true, // 允许手机经 LAN 访问 dev server
    port: 5174,
    proxy: {
      '/ta': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ta/, ''),
      },
    },
  },
})
