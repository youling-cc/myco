//! Windows 电源护栏：存在活 vnet 数据连接时，阻止系统进入 Adaptive Connected Standby。
//! 活连接包含正向 TunnelStat.live>0 与反向已建立数据腿；空挂/拨号中的 listener 不阻止睡眠。

use std::sync::{Mutex, OnceLock};

static GUARD: OnceLock<Mutex<GuardState>> = OnceLock::new();

#[derive(Default)]
struct GuardState {
    #[cfg(windows)]
    request: Option<PowerRequest>,
}

#[cfg(windows)]
struct PowerRequest(windows_sys::Win32::Foundation::HANDLE, u32);

// REASON_CONTEXT / PowerCreateRequest / PowerClearRequest 的 ABI 与 Windows SDK 一致。
// 2026-10-29 笔记本真案：Modern Standby 机型上 `PowerSetRequest(SystemRequired)`
// 可能返回 ERROR_NOT_SUPPORTED(50)，导致活隧道仍进入 5h41m 的 Adaptive Connected
// Standby。同 handle 的 `PowerRequestExecutionRequired` 实测可设置成功，因此
// SystemRequired 失败时必须降级，而不是把电源护栏当成已持有。
#[cfg(windows)]
fn selected_request_type(system_required: bool, execution_required: bool) -> Option<u32> {
    if system_required {
        Some(windows_sys::Win32::System::Power::PowerRequestSystemRequired as u32)
    } else if execution_required {
        Some(windows_sys::Win32::System::Power::PowerRequestExecutionRequired as u32)
    } else {
        None
    }
}

// HANDLE 是裸指针所以默认 !Send；这里只在 GUARD 的 Mutex 内创建/清除，串行化访问。
#[cfg(windows)]
unsafe impl Send for PowerRequest {}

#[cfg(windows)]
impl Drop for PowerRequest {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Power::PowerClearRequest(
                self.0,
                self.1 as windows_sys::Win32::System::Power::POWER_REQUEST_TYPE,
            );
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn should_hold(vnet_busy: bool) -> bool {
    vnet_busy
}

/// vnet 活动/空闲状态变化后调用。测试态不碰系统电源。
pub fn vnet_activity_changed(vnet_busy: bool) {
    if cfg!(test) || !should_hold(vnet_busy) {
        release();
        return;
    }
    acquire();
}

fn state() -> &'static Mutex<GuardState> {
    GUARD.get_or_init(|| Mutex::new(GuardState::default()))
}

fn release() {
    let mut g = state().lock().unwrap();
    #[cfg(windows)]
    {
        g.request = None;
    }
    #[cfg(not(windows))]
    {
        let _ = &mut g;
    }
}

#[cfg(windows)]
fn acquire() {
    let mut g = state().lock().unwrap();
    if g.request.is_some() {
        return;
    }
    // REASON_CONTEXT 必须存活到 PowerCreateRequest 返回后；这里复制到固定宽缓冲，
    // 避免 UTF-16 局部 String 在调用期间被移动。
    let mut reason: [u16; 64] = [0; 64];
    let text = "myco active vnet tunnel";
    let mut n = 0usize;
    for (dst, src) in reason.iter_mut().zip(text.encode_utf16()) {
        *dst = src;
        n += 1;
    }
    debug_assert!(n < reason.len(), "reason must stay null-terminated");
    let ctx = windows_sys::Win32::System::Threading::REASON_CONTEXT {
        Version: 0,
        Flags: windows_sys::Win32::System::Threading::POWER_REQUEST_CONTEXT_SIMPLE_STRING,
        Reason: windows_sys::Win32::System::Threading::REASON_CONTEXT_0 {
            SimpleReasonString: reason.as_mut_ptr(),
        },
    };
    let handle = unsafe { windows_sys::Win32::System::Power::PowerCreateRequest(&ctx) };
    if handle.is_null() || handle == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
        eprintln!("[power-guard] PowerCreateRequest failed");
        return;
    }
    let ok = unsafe {
        windows_sys::Win32::System::Power::PowerSetRequest(
            handle,
            windows_sys::Win32::System::Power::PowerRequestSystemRequired,
        )
    };
    let execution_ok = if ok == 0 {
        unsafe {
            windows_sys::Win32::System::Power::PowerSetRequest(
                handle,
                windows_sys::Win32::System::Power::PowerRequestExecutionRequired,
            )
        }
    } else {
        1
    };
    let Some(request_type) = selected_request_type(ok != 0, execution_ok != 0) else {
        let err = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        eprintln!("[power-guard] PowerSetRequest failed (SystemRequired/ExecutionRequired): {err}");
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        return;
    };
    g.request = Some(PowerRequest(handle, request_type));
    let mode = if ok != 0 {
        "SystemRequired"
    } else {
        "ExecutionRequired"
    };
    eprintln!("[power-guard] SYSTEM power request acquired ({mode}, active vnet tunnel)");
}

#[cfg(not(windows))]
fn acquire() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn power_guard_holds_only_while_vnet_is_busy() {
        assert!(!should_hold(false), "空闲/残留 listener 不得阻止睡眠");
        assert!(should_hold(true), "活 vnet 连接必须阻止 Modern Standby");
    }

    #[cfg(windows)]
    #[test]
    fn modern_standby_falls_back_to_execution_required() {
        use windows_sys::Win32::System::Power::{
            PowerRequestExecutionRequired as EXEC, PowerRequestSystemRequired as SYSTEM,
        };
        // 常规桌面：SystemRequired 可用，保持原语义。
        assert_eq!(selected_request_type(true, false), Some(SYSTEM as u32));
        // 2026-10-29 笔记本真案：SystemRequired 返回 ERROR_NOT_SUPPORTED，
        // ExecutionRequired 可用——必须降级而不是静默放弃持醒。
        assert_eq!(selected_request_type(false, true), Some(EXEC as u32));
        assert_eq!(selected_request_type(false, false), None);
    }
}
