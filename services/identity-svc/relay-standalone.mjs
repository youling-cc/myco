// relay-standalone.mjs — 独立运行云端 TCP 中继（不经 identity-server）。
// 场景：服务器上只想（重）启中继不想动 identity 主进程时：
//   /opt/node22/bin/node relay-standalone.mjs   （nohup 后台，日志 relay.log）
// 逻辑与 relay.mjs 完全同一份（createRelay 单一真源），这里只做"启动器"。

import { createRelay } from './relay.mjs'

const server = createRelay()
server.on('error', (e) => {
  console.error('[relay-standalone] 监听失败:', e.message)
  process.exit(1)
})
process.on('SIGTERM', () => server.close(() => process.exit(0)))
