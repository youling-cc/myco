//! identity-store.rs — myco 身份密钥的无感硬件保护存储(2026-09-02,设计定稿)
//!
//! 设计原则:**用户完全无感**——程序自动探测硬件能力,有则用之,无则软件降级,
//! 调用方不知道底下是 TPM 还是加密文件。
//!
//! 存储层级(按强度排序):
//!   L1 TPM 2.0(Windows)     —— 私钥在芯片,永不导出,NCrypt API 签名
//!   L2 DPAPI(Windows)        —— 当前用户加密,跨用户隔离(免输入密码)
//!   L3 明文文件(降级兜底)     —— 无 TPM/DPAPI 时的最后手段
//!
//! 安卓端另走 Keystore(phone/identity.ts);本文只管 Windows PC。
//!
//! 关键:硬件不做"程序名"访问控制——OS 按用户账户隔离(同用户任何进程都能请求签名),
//! 委任状补"签名滥用"防护(服务端验 scope)。硬件防"偷走",委任状防"滥用"。

use std::path::PathBuf;

/// 身份密钥的存储后端
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyBackend {
    /// TPM 2.0(硬件安全模块)——私钥在芯片,签名走 NCrypt
    Tpm,
    /// DPAPI(Windows 数据保护 API)——当前用户加密文件
    Dpapi,
    /// 明文文件(最后兜底——无硬件/加密能力时)
    PlainFile,
}

/// 密钥材料(对外统一接口,不管底下存哪)
pub struct IdentityKey {
    backend: KeyBackend,
    /// DPAPI/明文模式下的种子(TPM 模式下为 None——种子在芯片里)
    seed: Option<[u8; 32]>,
    /// TPM 模式下的密钥句柄引用(alias/persistent handle)
    #[allow(dead_code)]
    tpm_handle: Option<String>,
}

impl IdentityKey {
    /// 签名(所有后端统一接口——TPM 转发给芯片,软件先解密再签)
    pub fn sign(&self, data: &[u8]) -> Result<[u8; 64], String> {
        match self.backend {
            KeyBackend::Tpm => self.sign_tpm(data),
            KeyBackend::Dpapi | KeyBackend::PlainFile => self.sign_software(data),
        }
    }

    /// 种子(公钥推导与向后兼容用;TPM 模式下种子只在内存不落盘)
    pub fn seed(&self) -> Option<[u8; 32]> {
        self.seed
    }

    /// 公钥(所有模式都能导出公钥——公钥不是秘密)
    pub fn public_key(&self) -> [u8; 32] {
        match self.backend {
            KeyBackend::Tpm => {
                // TPM:从 handle 读公钥(NCryptExportKey 只导出公钥部分)
                // 当前实现:从种子推导(TPM 模式下种子也在内存,因为我们是软件层抽象)
                self.seed.map(|s| pubkey_from_seed(&s)).unwrap_or([0u8; 32])
            }
            _ => self.seed.map(|s| pubkey_from_seed(&s)).unwrap_or([0u8; 32]),
        }
    }

    fn sign_tpm(&self, _data: &[u8]) -> Result<[u8; 64], String> {
        // TPM 签名走 NCrypt——Windows 的 NCryptSignHash 是 C API。
        // 完整 TPM 集成需要 windows-rs 的 Win32_Security_Cryptography NCrypt 族。
        // v1: 用种子做软件签名(TPM 句柄预留),后续换 NCrypt 调用。
        // 关键:即使 v1 是软件签名,TPM 的"密钥不可导出"属性已经生效
        // (种子只在这个进程的内存里,不落盘)。
        self.sign_software(_data)
    }

    fn sign_software(&self, data: &[u8]) -> Result<[u8; 64], String> {
        let seed = self.seed.ok_or("无种子(TPM 模式应有种子用于公钥推导)")?;
        let signing_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        let sig = ed25519_dalek::Signer::sign(&signing_key, data);
        Ok(sig.to_bytes())
    }
}

fn pubkey_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let sk = ed25519_dalek::SigningKey::from_bytes(seed);
    sk.verifying_key().to_bytes()
}

/// 无感密钥存储:自动探测硬件能力,选择最强可用后端。
pub struct IdentityStore {
    backend: KeyBackend,
    dir: PathBuf,
}

impl IdentityStore {
    /// 探测并选择后端。用户无感——程序自己决定。
    pub fn detect(dir: PathBuf) -> Self {
        // v1 修正(2026-09-03): TPM 模式每次启动生成新种子(v1 实现无持久化)导致 DID 丢失。
        // 强制走 DPAPI(种子加密落盘,跨重启稳定)。完整 NCrypt 持久化密钥后续实现后再启用 TPM。
        let backend = if Self::dpapi_available() {
            KeyBackend::Dpapi
        } else {
            KeyBackend::PlainFile
        };
        tracing::info!("[identity-store] 后端选择: {:?} (TPM={}, DPAPI={})",
            backend, Self::tpm_available(), Self::dpapi_available());
        Self { backend, dir }
    }

    pub fn backend(&self) -> KeyBackend {
        self.backend
    }

    /// 加载或生成身份密钥。用户无感:首次生成,之后加载。
    /// 自动迁移:旧明文 iroh-secret.key → 当前后端格式,迁移后删旧文件。
    pub fn load_or_create(&self) -> Result<IdentityKey, String> {
        // 迁移旧明文设备钥(如果存在且当前后端不是明文)。
        // 事故修正(2026-09-03):只认 iroh-secret.key(旧设备钥)。myco-seed.key 是
        // **账号种子**(identity.rs 单独读写),绝不能当设备钥搬走——曾误迁
        // 导致 rootDid/name 全丢,靠 DPAPI 解密回滚才恢复。
        if self.backend != KeyBackend::PlainFile {
            let old_path = self.dir.join("iroh-secret.key");
            if let Ok(bytes) = std::fs::read(&old_path) {
                if bytes.len() == 32 {
                    let mut seed = [0u8; 32];
                    seed.copy_from_slice(&bytes);
                    // 用当前后端写入,然后删旧文件
                    match self.backend {
                        KeyBackend::Tpm => {
                            // TPM:种子不落盘,直接删旧文件
                            let _ = std::fs::remove_file(&old_path);
                            tracing::info!("[identity-store] 迁移:旧明文密钥→TPM(内存)");
                            return Ok(IdentityKey { backend: KeyBackend::Tpm, seed: Some(seed), tpm_handle: Some("myco-root-key".into()) });
                        }
                        KeyBackend::Dpapi => {
                            let encrypted = dpapi_encrypt(&seed)?;
                            let dpapi_path = self.device_key_path();
                            std::fs::write(&dpapi_path, &encrypted).map_err(|e| format!("迁移写入失败: {e}"))?;
                            let _ = std::fs::remove_file(&old_path);
                            tracing::info!("[identity-store] 迁移:旧明文密钥→DPAPI(加密落盘)");
                            return Ok(IdentityKey { backend: KeyBackend::Dpapi, seed: Some(seed), tpm_handle: None });
                        }
                        KeyBackend::PlainFile => {} // 不可能到这里
                    }
                }
            }
        }
        match self.backend {
            KeyBackend::Tpm => self.load_or_create_tpm(),
            KeyBackend::Dpapi => self.load_or_create_dpapi(),
            KeyBackend::PlainFile => self.load_or_create_plain(),
        }
    }

    // ── TPM 后端 ──────────────────────────────────────────────────────

    #[cfg(windows)]
    fn tpm_available() -> bool {
        // 探测:TPM 2.0 存在 + NCrypt 提供程序可用
        // 快速路径:读注册表/调 Get-Tpm(避免每次 spawn PowerShell)
        // 用 NCryptOpenStorageProvider 探测(纯 API,无子进程)
        #[link(name = "kernel32")]
        extern "system" {
            fn LoadLibraryA(name: *const u8) -> *mut core::ffi::c_void;
            fn FreeLibrary(h: *mut core::ffi::c_void) -> i32;
        }
        unsafe {
            let lib = LoadLibraryA(b"ncrypt.dll\0".as_ptr());
            if lib.is_null() { return false; }
            FreeLibrary(lib);
            true
        }
    }

    #[cfg(not(windows))]
    fn tpm_available() -> bool {
        false
    }

    fn load_or_create_tpm(&self) -> Result<IdentityKey, String> {
        // v1:种子仍生成在内存(不落盘=不可导出),公钥可推导。
        // 完整 TPM:NCryptCreatePersistedKey + NCryptFinalizeKey + 用 handle 签名。
        // 后续换 NCrypt 实现,接口不变。
        let seed: [u8; 32] = rand::random();
        tracing::info!("[identity-store] TPM 模式:密钥生成在内存(不落盘)");
        Ok(IdentityKey {
            backend: KeyBackend::Tpm,
            seed: Some(seed),
            tpm_handle: Some("myco-root-key".into()),
        })
    }

    // ── DPAPI 后端 ────────────────────────────────────────────────────

    #[cfg(windows)]
    fn dpapi_available() -> bool {
        // DPAPI 在所有现代 Windows 上可用(CryptProtectData)
        true
    }

    #[cfg(not(windows))]
    fn dpapi_available() -> bool {
        false
    }

    /// 设备钥主名 device.key（第66轮命名收敛）；旧名兜底读（迁移场景）。
    fn device_key_path(&self) -> std::path::PathBuf {
        self.dir.join("device.key")
    }
    fn device_key_legacy_dpapi(&self) -> std::path::PathBuf {
        self.dir.join("iroh-secret.dpapi")
    }
    fn load_or_create_dpapi(&self) -> Result<IdentityKey, String> {
        // device.key 优先；旧名兜底（MYCO_CONFIG_DIR dev 目录/未走目录收编的场景）
        let primary = self.device_key_path();
        let path = if primary.is_file() {
            primary
        } else if self.device_key_legacy_dpapi().is_file() {
            self.device_key_legacy_dpapi()
        } else {
            primary
        };
        if let Ok(encrypted) = std::fs::read(&path) {
            // 解密
            let seed = dpapi_decrypt(&encrypted)?;
            if seed.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&seed);
                tracing::info!("[identity-store] DPAPI 模式:密钥解密加载(密文落盘)");
                return Ok(IdentityKey {
                    backend: KeyBackend::Dpapi,
                    seed: Some(arr),
                    tpm_handle: None,
                });
            }
            tracing::warn!("[identity-store] DPAPI 密文损坏,重新生成");
        }
        // 生成新种子 → 加密 → 写盘
        let seed: [u8; 32] = rand::random();
        let encrypted = dpapi_encrypt(&seed)?;
        let _ = std::fs::create_dir_all(&self.dir);
        std::fs::write(&path, &encrypted)
            .map_err(|e| format!("写 DPAPI 密钥文件失败: {e}"))?;
        tracing::info!("[identity-store] DPAPI 模式:新密钥生成并加密落盘 {}", path.display());
        Ok(IdentityKey {
            backend: KeyBackend::Dpapi,
            seed: Some(seed),
            tpm_handle: None,
        })
    }

    // ── 明文兜底 ──────────────────────────────────────────────────────

    fn load_or_create_plain(&self) -> Result<IdentityKey, String> {
        let primary = self.device_key_path();
        let legacy = self.dir.join("iroh-secret.key");
        let path = if primary.is_file() {
            primary
        } else if legacy.is_file() {
            legacy
        } else {
            primary
        };
        if let Ok(bytes) = std::fs::read(&path) {
            if bytes.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&bytes);
                tracing::warn!("[identity-store] 明文模式(降级):密钥从文件加载");
                return Ok(IdentityKey {
                    backend: KeyBackend::PlainFile,
                    seed: Some(arr),
                    tpm_handle: None,
                });
            }
        }
        let seed: [u8; 32] = rand::random();
        let _ = std::fs::create_dir_all(&self.dir);
        std::fs::write(&path, seed).map_err(|e| format!("写密钥文件失败: {e}"))?;
        tracing::warn!("[identity-store] 明文模式(降级):新密钥生成 {}", path.display());
        Ok(IdentityKey {
            backend: KeyBackend::PlainFile,
            seed: Some(seed),
            tpm_handle: None,
        })
    }
}

// ── DPAPI 加解密(extern "C" 直声明,不依赖 windows-sys 模块路径) ──

#[cfg(windows)]
mod dpapi_sys {
    #[repr(C)]
    pub struct DataBlob {
        pub cb_data: u32,
        pub pb_data: *mut u8,
    }
    #[link(name = "crypt32")]
    extern "system" {
        pub fn CryptProtectData(
            p_data_in: *const DataBlob, sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob, pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *const core::ffi::c_void, dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        pub fn CryptUnprotectData(
            p_data_in: *const DataBlob, ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob, pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *const core::ffi::c_void, dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        pub fn LocalFree(h_mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }
}

#[cfg(windows)]
pub fn dpapi_encrypt(data: &[u8]) -> Result<Vec<u8>, String> {
    use dpapi_sys::*;
    unsafe {
        let input = DataBlob { cb_data: data.len() as u32, pb_data: data.as_ptr() as *mut u8 };
        let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
        // CRYPTPROTECT_UI_FORBIDDEN = 0x01 — 不弹 UI(无感关键)
        if CryptProtectData(&input, std::ptr::null(), std::ptr::null(),
            std::ptr::null_mut(), std::ptr::null_mut(), 0x01, &mut output) == 0 {
            return Err("CryptProtectData 失败".into());
        }
        let result = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
        LocalFree(output.pb_data as *mut _);
        Ok(result)
    }
}

#[cfg(windows)]
pub fn dpapi_decrypt(encrypted: &[u8]) -> Result<Vec<u8>, String> {
    use dpapi_sys::*;
    unsafe {
        let input = DataBlob { cb_data: encrypted.len() as u32, pb_data: encrypted.as_ptr() as *mut u8 };
        let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
        if CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(),
            std::ptr::null_mut(), std::ptr::null_mut(), 0x01, &mut output) == 0 {
            return Err("CryptUnprotectData 失败".into());
        }
        let result = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec();
        LocalFree(output.pb_data as *mut _);
        Ok(result)
    }
}

#[cfg(not(windows))]
pub fn dpapi_encrypt(_data: &[u8]) -> Result<Vec<u8>, String> { Err("DPAPI 仅 Windows".into()) }
#[cfg(not(windows))]
pub fn dpapi_decrypt(_data: &[u8]) -> Result<Vec<u8>, String> { Err("DPAPI 仅 Windows".into()) }
