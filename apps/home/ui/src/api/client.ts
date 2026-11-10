/**
 * API Client - 适配 Tauri 桌面环境和浏览器环境
 *
 * 浏览器环境通过 HTTP API (127.0.0.1:3001) 调用 Rust 后端功能
 */

// 检测是否在 Tauri 环境
let isTauriCache: boolean | null = null

const checkIsTauri = (): boolean => {
  if (isTauriCache !== null) return isTauriCache

  if (typeof window === 'undefined') {
    isTauriCache = false
    return false
  }

  if (!!(window as any).__TAURI_INTERNALS__) {
    isTauriCache = true
    return true
  }

  if (!!(window as any).__TAURI__) {
    isTauriCache = true
    return true
  }

  isTauriCache = false
  return false
}

// 成员窗逃生门:myco-graph 等独立 exe 复用 canvas 组件时,自家 webview 里也有
// __TAURI_INTERNALS__——不强制 HTTP 会把 invoke 打进自家 Rust(无此命令,全灭)。
const FORCE_HTTP = (import.meta.env?.VITE_FORCE_HTTP as string | undefined) === '1'

const isTauri = !FORCE_HTTP && checkIsTauri()

// HTTP API 配置:VITE_CANVAS_API 可指开发栈第二实例(多任务并行),默认共享栈 :3002
const HTTP_API_BASE_URL = (import.meta.env?.VITE_CANVAS_API as string | undefined) || 'http://127.0.0.1:3102/api'

// Tauri command names → HTTP route paths (browser mode)
const CMD_ROUTE_MAP: Record<string, string> = {
  terminal_create_session: 'terminal/create',
  terminal_focus_session: 'terminal/focus',
  terminal_send_input: 'terminal/input',
  terminal_kill_session: 'terminal/kill',
  terminal_list_sessions: 'terminal/list',
  terminal_get_session_status: 'terminal/status',
  provider_get_config: 'provider_list',
}

// HTTP API 调用函数
async function httpInvoke<T>(cmd: string, args?: any): Promise<T> {
  const route = CMD_ROUTE_MAP[cmd] || cmd
  const url = `${HTTP_API_BASE_URL}/${route}`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: args ? JSON.stringify(args) : undefined,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`HTTP error: ${response.status} - ${errorText}`)
  }

  const result = await response.json()

  if (!result.success) {
    throw new Error(result.error || 'Unknown error')
  }

  return result.data as T
}

// HTTP GET 调用（用于获取数据）— args 转 query string(如 terminal_get_session_status 的 sessionId)
async function httpGet<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const route = CMD_ROUTE_MAP[cmd] || cmd
  let url = `${HTTP_API_BASE_URL}/${route}`
  if (args && Object.keys(args).length > 0) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== null) qs.append(k, String(v))
    }
    const s = qs.toString()
    if (s) url += `?${s}`
  }
  const response = await fetch(url)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`HTTP error: ${response.status} - ${errorText}`)
  }

  const result = await response.json()

  if (!result.success) {
    throw new Error(result.error || 'Unknown error')
  }

  return result.data as T
}

// 浏览器环境实现 - 所有命令通过 HTTP API
async function browserInvoke<T>(cmd: string, args?: any): Promise<T> {
  // 需要 GET 的请求
  const getCommands = ['ping', 'get_task_graph', 'get_recent_paths', 'terminal_list_sessions', 'terminal_get_session_status']

  if (getCommands.includes(cmd)) {
    return httpGet<T>(cmd, args)
  }

  // 其他请求使用 POST
  return httpInvoke<T>(cmd, args)
}

async function browserListen<T>(
  _event: string,
  _handler: (e: { payload: T }) => void
): Promise<() => void> {
  // 浏览器环境暂不支持事件监听
  console.warn('[Browser] Event listening not supported in browser mode')
  return () => {}
}

// Tauri 实现（第63轮：动态 import '@tauri-apps/api/core' 在 WebView 运行时解析失败，
// 改直调 __TAURI_INTERNALS__.invoke——这是 Tauri 底层 API，@tauri-apps/api 内部也是走它）
async function tauriInvoke<T>(cmd: string, args?: any): Promise<T> {
  return (window as any).__TAURI_INTERNALS__.invoke(cmd, args)
}

async function tauriListen<T>(
  event: string,
  handler: (e: { payload: T }) => void
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen(event, handler)
}

// 统一的 API Client
export const client = {
  get isTauri() {
    return checkIsTauri()
  },

  async invoke<T>(cmd: string, args?: any): Promise<T> {
    if (isTauri) {
      return tauriInvoke<T>(cmd, args)
    }
    return browserInvoke<T>(cmd, args)
  },

  async listen<T>(
    event: string,
    handler: (e: { payload: T }) => void
  ): Promise<() => void> {
    if (isTauri) {
      return tauriListen<T>(event, handler)
    }
    return browserListen<T>(event, handler)
  },
}

export default client
