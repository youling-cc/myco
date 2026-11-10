/**
 * useChatTheme — phone 端聊天视图主题管理（localStorage 持久化）。
 * 与 canvas 的 uiStore.chatTheme 同一套主题（chat-themes.ts），
 * 支持预设 id（'blue'…）和自定义 'custom:#hex'。
 *
 * 双轨合一(2026-08-17):canvas/chatwin 的 ThemeSettings 面板写 uiStore.chatTheme
 * (myco-ui-prefs),而 ChatView 读本键——历史上互不相通。约定:任何写入方都
 * 同时写本 LS_KEY 并派发 window 事件 'myco-chat-theme';本 hook 监听该事件
 * + storage(跨标签),三端(canvas/chatwin/phone)同窗即时生效。
 */
import { useCallback, useEffect, useState } from 'react'
import { themeById, customTheme, type ChatTheme } from './chat-themes'

const LS_KEY = 'myco-phone.chatTheme'
const EVT = 'myco-chat-theme'

/** 写主题的唯一入口:LS + 同窗事件(写方自己也要收到,靠调用方 setId 不在此重复) */
export function writeChatTheme(v: string) {
  localStorage.setItem(LS_KEY, v)
  window.dispatchEvent(new CustomEvent(EVT, { detail: v }))
}

export function useChatTheme(): [ChatTheme, (id: string) => void] {
  const [id, setId] = useState<string>(() => localStorage.getItem(LS_KEY) || 'blue')

  useEffect(() => {
    const onEvt = (e: Event) => setId((e as CustomEvent<string>).detail || 'blue')
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_KEY) setId(e.newValue || 'blue')
    }
    window.addEventListener(EVT, onEvt)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(EVT, onEvt)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setTheme = useCallback((v: string) => {
    writeChatTheme(v)
    setId(v)
  }, [])

  const theme = id.startsWith('custom:') ? customTheme(id.slice(7)) : themeById(id)
  return [theme, setTheme]
}
