/**
 * Identity Store — myco DID 身份的前端投影（连通层 design/07-connectivity）+ Youling 模型。
 *
 * 身份即 DID（did:myco:<base58>，本机 Ed25519 公钥的 base58 编码）。
 * Youling = 身份锚（主设备/肢体模型，见 design/08-identity/SOUL-MYCO-MODEL.md）：
 *   - 持 账号钥 = 主设备（能管理身份、招新设备）
 *   - 不持 = 肢体（只能被 attest）或未关联
 *
 * identity_get 本地即可算；myco_get 读 myco-seed.key 判定主设备。registerLogin/myco_create 需火山 :8321。
 */
import { create } from 'zustand'
import { client } from '../api/client'

export type IdentityStatus = 'loading' | 'guest' | 'authenticated'
/**
 * 本机在某账号下的角色（myco_get.role / 账号清单 role 注入）。
 *
 * 'lost' = 既无账号钥槽、也无绑定本机设备钥的未吊销委任状（凭据已失）——由
 * `core/myco-core/src/identity.rs` 的 `account_local_role()`（:314-331，无槽无委任状
 * → :329 `"lost"`）与 `accounts_load_with_roles()`（:351-355）真实产出，UI 侧
 * `accountDisplay.ts` 也已按它渲染「凭据已失」。此前类型漏了这一档（复核 M4）：
 * 运行时值经 `as DeviceRole` 断言蒙混过关，但 any 化断言外的判等/穷尽检查会失真。
 */
export type DeviceRole = 'embodiment' | 'agent' | 'lost' | 'unlinked'

export interface YoulingDevice {
  did: string
  name: string
  revoked: boolean
  isEmbodiment: boolean
  online: boolean
  lastSeen: number | null
  kind: string | null
}

interface IdentityState {
  did: string
  publicKeyB64: string
  sessionToken: string | null
  sessionExpiresAt: number | null
  status: IdentityStatus
  panelOpen: boolean
  loginBusy: boolean
  loginError: string | null
  // Youling
  rootDid: string | null
  _youlingRetryCount?: number
  role: DeviceRole
  accountDevices: YoulingDevice[]
  accountName: string
  cloudBackedUp: boolean
  accountBusy: boolean
  accountError: string | null
  /** 改名失败原因（紧贴账号资料输入框显示；成功即清）。2026-09-30 改名静默失败修复。 */
  renameError: string | null
  load: () => Promise<void>
  registerLogin: (password?: string, baseUrl?: string) => Promise<boolean>
  setPanelOpen: (v: boolean) => void
  loadYouling: () => Promise<void>
  createYouling: (name?: string, phone?: string, email?: string) => Promise<string | null>
  refreshYoulingDevices: () => Promise<void>
  setBackedUpCloud: () => Promise<void>
  importYouling: (text: string, password: string) => Promise<string>
  hasPassword: boolean
  locked: boolean
  /** 旧格式账号停试标记（2026-10-07 清档闸门）：myco_status.accountFormatLegacy 透出，
   *  名册自愈检出 create 400 unsupported_did_format 即 true——账号页/顶栏引导条数据源
   *  （lib/legacyAccount 单一文案源）。注意自愈是后台 fire-and-forget：本次 status 返回
   *  false 不代表没检出（可能还在飞），见 loadYouling 的延迟复核。 */
  accountFormatLegacy: boolean
  unlock: (password: string) => Promise<boolean>
  setPassword: (password: string) => Promise<boolean>
  removePassword: (password: string) => Promise<boolean>
  refreshYoulingStatus: () => Promise<void>
  // 添加设备：DID 互换（出示本机码/扫对方码/粘贴 DID）——join 6位配对码 2026-09-30 下线
  // （myco_claim_join/myco_issue_join_code/myco_poll_claimers/myco_attest_claimer 服务端从未实现，
  //  相关 UI/store 代码已删；复开条件登记在仓根 TODO.md）
  renameYouling: (name: string) => Promise<boolean>
}

/** 旧格式延迟复核（一次性，非轮询）：名册自愈是 fire-and-forget 后台任务——
 *  myco_status 返回时可能还没检出（首次 false 后 2.5s 复核一次兜住异步置位；
 *  loadYouling/unlock 两个人口重新武装；检出为 true 后不再链式排程）。 */
let legacyRecheckTimer: ReturnType<typeof setTimeout> | null = null
function armLegacyRecheck(refresh: () => void) {
  if (legacyRecheckTimer) clearTimeout(legacyRecheckTimer)
  legacyRecheckTimer = setTimeout(() => { legacyRecheckTimer = null; refresh() }, 2500)
}

export const useIdentityStore = create<IdentityState>((set, get) => ({
  did: '',
  publicKeyB64: '',
  sessionToken: null,
  sessionExpiresAt: null,
  status: 'loading',
  panelOpen: false,
  loginBusy: false,
  loginError: null,
  rootDid: null,
  role: 'unlinked',
  _youlingRetryCount: 0,
  accountDevices: [],
  accountName: '',
  cloudBackedUp: false,
  hasPassword: false,
  locked: false,
  accountFormatLegacy: false,
  accountBusy: false,
  accountError: null,
  renameError: null,

  load: async () => {
    try {
      const idRes = await client.invoke<Record<string, unknown>>('identity_get')
      const token = (idRes.sessionToken as string | undefined) ?? null
      set({
        did: (idRes.did as string) ?? '',
        publicKeyB64: (idRes.publicKeyB64 as string) ?? '',
        sessionToken: token,
        sessionExpiresAt: (idRes.sessionExpiresAt as number | undefined) ?? null,
        status: token ? 'authenticated' : 'guest',
      })
    } catch {
      // 后端未就绪——保持 loading 态，下次 boot 重试
    }
    void get().loadYouling()
  },

  registerLogin: async (password, baseUrl) => {
    set({ loginBusy: true, loginError: null })
    try {
      await client.invoke('identity_register_login', {
        ...(password ? { password } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      })
      await get().load()
      set({ loginBusy: false })
      return true
    } catch (e) {
      set({ loginBusy: false, loginError: String(e).replace(/^Error:\s*/, '') })
      return false
    }
  },

  setPanelOpen: (v) => set({ panelOpen: v }),

  loadYouling: async () => {
    try {
      const res = await client.invoke<Record<string, unknown>>('myco_get')
      const rootDid = (res.rootDid as string | null) ?? null
      const role = (res.role as DeviceRole) ?? 'unlinked'
      // 2026-10-09（用户要求登出）：若当前账号已登出（accounts.json loggedOut=true），
      // 不自动进账号——显示"已登出"（用户主动登录/切换才进）。此前登出=假登出（重启自动回）。
      if (rootDid) {
        try {
          const accts = await client.invoke<{ accounts?: Array<{ did?: string; loggedOut?: boolean }> }>('myco_accounts')
          const cur = (accts.accounts ?? []).find((a) => a.did === rootDid)
          if (cur?.loggedOut) {
            set({ rootDid: null, role: 'unlinked', accountName: '', _youlingRetryCount: 0 } as Partial<IdentityState>)
            return
          }
        } catch { /* myco_accounts 未就绪——不阻塞登录（保守放行） */ }
      }
      // 分身态:账号名随归属带回(本地委任状/名册)——IdentityChip 直显昵称
      // (本体态名字仍走 refreshYoulingDevices,不在此覆盖)
      const agentName = role === 'agent' ? ((res.name as string | undefined) ?? '') : ''
      set({ ...(rootDid && agentName ? { rootDid, role, accountName: agentName } : { rootDid, role }), _youlingRetryCount: 0 } as Partial<IdentityState>)
      void get().refreshYoulingStatus()
      // 自愈在飞——2.5s 后复核一次 accountFormatLegacy（见 armLegacyRecheck 注释）
      armLegacyRecheck(() => void get().refreshYoulingStatus())
      if (rootDid) await get().refreshYoulingDevices()
    } catch {
      // myco_get 未就绪（env 宿主可能还在启动）——第47轮修：2s/6s/15s 退避重试，不再一次失败定死 unlinked
      const retry = get()._youlingRetryCount ?? 0
      if (retry < 3) {
        set({ _youlingRetryCount: retry + 1 } as Partial<IdentityState>)
        setTimeout(() => void get().loadYouling(), [2000, 6000, 15000][retry])
      }
    }
  },

  createYouling: async (name, phone, email) => {
    set({ accountBusy: true, accountError: null })
    try {
      const res = await client.invoke<{ rootDid: string; deviceDid: string }>('myco_create', {
        ...(name ? { name } : {}),
        ...(phone ? { phone } : {}),
        ...(email ? { email } : {}),
      })
      await get().loadYouling()
      set({ accountBusy: false })
      return res.rootDid
    } catch (e) {
      set({ accountBusy: false, accountError: String(e).replace(/^Error:\s*/, '') })
      return null
    }
  },

  refreshYoulingDevices: async () => {
    try {
      const ov = await client.invoke<{ name: string; backedUp: boolean; devices: YoulingDevice[] }>('myco_list_devices')
      set({ accountDevices: ov?.devices ?? [], accountName: ov?.name ?? '', cloudBackedUp: !!ov?.backedUp })
    } catch {
      // 旧后端无此命令——静默
    }
  },

  setBackedUpCloud: async () => {
    try { await client.invoke('myco_set_backed_up'); await get().refreshYoulingDevices() } catch { /* ignore */ }
  },

  importYouling: async (text, password) => {
    // 2026-09-30 批A：吞错修复——原 catch{return false} 把后端错误原文（备份格式不对/
    // 密码不对/无此账号）全吞成 false，UI 只能猜。改错误透传（剥 Error: 前缀），
    // 成功返回 rootDid 并走现有 loadYouling 链路刷新账号状态。
    try {
      const res = await client.invoke<{ rootDid: string }>('myco_import', { text, password })
      await get().loadYouling()
      return res.rootDid
    } catch (e) {
      throw new Error(String(e).replace(/^Error:\s*/, ''))
    }
  },

  refreshYoulingStatus: async () => {
    try {
      const s = await client.invoke<{ hasPassword: boolean; locked: boolean; accountFormatLegacy?: boolean }>('myco_status')
      set({ hasPassword: !!s?.hasPassword, locked: !!s?.locked, accountFormatLegacy: !!s?.accountFormatLegacy })
    } catch { /* 旧后端无此命令 */ }
  },
  renameYouling: async (name: string) => {
    // 2026-09-30：改名失败不再静默——后端错误串（HTTP 404/网络…）进 renameError，
    // 面板紧贴输入框展示；成功清错并刷新名册（新名经 myco_list_devices 回流）。
    try {
      await client.invoke('myco_rename', { name })
      set({ renameError: null })
      await get().refreshYoulingDevices()
      return true
    } catch (e) {
      set({ renameError: String(e).replace(/^Error:\s*/, '') })
      return false
    }
  },
  unlock: async (password) => {
    try {
      await client.invoke('myco_unlock', { password })
      await get().refreshYoulingStatus()
      // 解锁后种子可用，自愈首次真正在飞——同款一次性复核
      armLegacyRecheck(() => void get().refreshYoulingStatus())
      return true
    }
    catch { return false }
  },
  setPassword: async (password) => {
    try { await client.invoke('myco_set_password', { password }); await get().refreshYoulingStatus(); return true }
    catch { return false }
  },
  removePassword: async (password) => {
    try { await client.invoke('myco_remove_password', { password }); await get().refreshYoulingStatus(); return true }
    catch { return false }
  },
}))

let booted = false
/** App 挂载时调一次：拉取本地身份 + 账号状态。失败静默（后端可能还没起）。 */
export function bootIdentitySync() {
  if (booted) return
  booted = true
  useIdentityStore.getState().load()
}
