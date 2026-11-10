/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** X-Did-Auth 签名头开关（did-auth.ts）：'1'=开启。默认不设=关闭——激活等服务端
   *  hbl_sign_check 切 "did" 模式时同步开。 */
  readonly VITE_DID_AUTH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
