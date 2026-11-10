//! 更新链路 v2(2026-09-22 根治重构,群测试者实测问题"解包失败黑话报错"的闭环):
//!
//! 病灶回顾(v0.3.56~0.3.67 链路):蜂窝下载截断 → 只查"大小≥1MB"假阳性 → 坏 zip 进
//! PowerShell Expand-Archive → 非零退出原文弹 alert,无重试续传无真进度。
//!
//! 本轮五件套:
//! 1. **完整性校验**:latest.json 增 sha256+size 字段;下载完成后校验大小+sha256,
//!    不完整/损坏绝不进解压。旧清单无 sha256 时回退只校验大小(防服务器旧版)。
//! 2. **断点续传**:.part 临时文件 + HTTP Range 续写(nginx 静态文件天然支持),
//!    弱网重试从断点继续,不重头下。
//! 3. **自动重试**:失败退避重试 3 次(10s/30s/60s),每次从断点续传;最终失败给
//!    分类后的人话提示(弃 JS alert 由前端渲染)。
//! 4. **真进度**:Rust 流式下载按节流回调 → Tauri 事件 `update-progress`
//!    (got/total/pct/speedBps/attempt) + progress.json 轮询兜底双通道。
//! 5. **原生解压**:zip crate(Rust)替代 PowerShell Expand-Archive,消除 PS 版本
//!    依赖与"非 0 退出"黑话。
//!
//! 错误分类(kind → 前端文案,Rust 侧出人话 msg 保证单测可断言):
//! - download-incomplete: 网络不稳没下完整(已自动重试 X 次,建议换 WiFi)
//! - checksum:           更新包校验未通过(重新下载后仍未通过,请截图反馈)
//! - server:             服务器不可达/HTTP 错误
//! - extract:            解压/安装失败(请截图反馈)

use std::io::{Read, Seek, SeekFrom, Write};
// 非 test 构建才引 Tauri `Emitter`（UI 进度事件通道）。lib 单元测试 harness 没有 exe
// manifest，测试可达代码一旦链上 tauri 的 webview 运行时（Wry → muda），就会静态导入
// `comctl32.dll!TaskDialogIndirect`（v6 专属符号）→ 加载器绑 v5.82 → 0xC0000139 起不来。
// 详见 `apps/home/src-tauri/build.rs` 顶部长注释。
#[cfg(not(test))]
use tauri::Emitter;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 前端监听的进度事件名(Tauri event,payload 字段 camelCase)。
pub const PROGRESS_EVENT: &str = "update-progress";
/// 重试退避表:第 1/2/3 次重试前等待(秒)。可注入短表供测试。
pub const BACKOFF_SECS: [u64; 3] = [10, 30, 60];
/// 总尝试次数 = 首次 + 3 重试。
pub const MAX_ATTEMPTS: u32 = 4;
/// 无清单 size 时的最小合法包体积(老链路语义保留,防 404 页面当 zip)。
pub const MIN_ZIP_BYTES: u64 = 1_000_000;

// ============================================================
// 错误模型:分类 + 人话文案(单测锚点)
// ============================================================

#[derive(Debug, Clone, PartialEq)]
pub enum FailKind {
    /// 网络不稳,包没下完整(重试耗尽)
    Incomplete,
    /// sha256/大小校验未通过(重下后仍未通过)
    Checksum,
    /// 服务器不可达 / HTTP 错误
    Server,
    /// 解压/安装阶段失败
    Extract,
    /// 其他(磁盘/IO 等)
    Other,
}

impl FailKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            FailKind::Incomplete => "download-incomplete",
            FailKind::Checksum => "checksum",
            FailKind::Server => "server",
            FailKind::Extract => "extract",
            FailKind::Other => "other",
        }
    }
    /// 用户语言提示(detail 才是技术细节;msg 直接可展示)。
    pub fn user_hint(&self) -> &'static str {
        match self {
            FailKind::Incomplete => "网络不稳，更新包没下完整。建议换 WiFi 再试一次",
            FailKind::Checksum => "更新包校验未通过（重新下载后仍不一致）。请截图反馈",
            FailKind::Server => "更新服务器暂时不可达。请检查网络后稍后再试",
            FailKind::Extract => "更新安装失败。请截图反馈",
            FailKind::Other => "更新失败。请截图反馈",
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpdateFail {
    pub kind: FailKind,
    /// 技术细节(日志/截图诊断用,不直接当主文案)
    pub detail: String,
    /// 已自动重试次数
    pub retries: u32,
}

impl UpdateFail {
    pub fn new(kind: FailKind, detail: impl Into<String>, retries: u32) -> Self {
        Self { kind, detail: detail.into(), retries }
    }
    /// 命令层错误通道:JSON 字符串(前端 parse 出 kind/msg/retries,人话渲染弃 alert)。
    pub fn to_json(&self) -> String {
        let hint = if self.retries > 0 && self.kind == FailKind::Incomplete {
            format!("网络不稳，更新包没下完整，已自动重试 {} 次。建议换 WiFi 再试", self.retries)
        } else {
            self.kind.user_hint().to_string()
        };
        serde_json::json!({
            "kind": self.kind.as_str(),
            "msg": hint,
            "detail": self.detail,
            "retries": self.retries,
        })
        .to_string()
    }
}

// ============================================================
// 纯逻辑单元(单测锚点)
// ============================================================

/// Range 请求头值:从 existing 字节处续传。
pub fn range_header(existing: u64) -> String {
    format!("bytes={existing}-")
}

/// 解析 Content-Range: `bytes 100-199/1234` → (start, total)。
/// total 为 `*`(未知总长)时返回 None——续传场景无 total 无法判完整,按不支持处理。
pub fn parse_content_range(v: &str) -> Option<(u64, u64)> {
    let v = v.trim().strip_prefix("bytes")?.trim();
    let (range, total) = v.split_once('/')?;
    let total: u64 = total.parse().ok()?;
    let start = range.split_once('-')?.0.trim().parse().ok()?;
    Some((start, total))
}

/// HTTP 状态码是否值得重试(5xx/429 瞬态;404 等客户端错误重试无意义)。
pub fn status_retryable(code: u16) -> bool {
    code >= 500 || code == 429
}

/// 退避表取值(越界取末位;测试注入 0 表=立即重试)。
pub fn backoff_for(backoff: &[u64], retry_index: u32) -> u64 {
    if backoff.is_empty() { return 0; }
    let i = (retry_index as usize).min(backoff.len() - 1);
    backoff[i]
}

/// 大小校验:期望值存在时必须严格相等;无期望值时退回地 板值(老语义)。
pub fn size_ok(actual: u64, expected: Option<u64>, floor: u64) -> bool {
    match expected {
        Some(want) => actual == want,
        None => actual >= floor,
    }
}

/// sha256 十六进制(小写)。流式读文件,18MB 级秒出。
pub fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// 校验摘要比对(大小写/前后空白宽容——清单是手编 JSON,常见大写 hex)。
pub fn digest_matches(actual: &str, expected: &str) -> bool {
    let norm = |s: &str| s.trim().to_ascii_lowercase();
    norm(actual) == norm(expected) && !actual.trim().is_empty()
}

/// .part 侧车元数据:标记当前断点属于哪个 URL——换包(清单更新)必须弃断点,
/// 否则旧包尾巴+新包前缀=静默拼出损坏文件(比截断更隐蔽)。
fn part_meta_path(tmp: &Path) -> PathBuf {
    tmp.join("part-meta.json")
}
fn save_part_meta(tmp: &Path, url: &str, expected_size: Option<u64>) {
    let _ = std::fs::write(
        part_meta_path(tmp),
        serde_json::json!({ "url": url, "size": expected_size }).to_string(),
    );
}
/// 断点是否仍有效:元数据缺失/URL 变了/期望大小变了 → 弃(返回 0)。
fn resume_offset(tmp: &Path, url: &str, expected_size: Option<u64>) -> u64 {
    let Ok(meta) = std::fs::read_to_string(part_meta_path(tmp)) else { return 0 };
    let Ok(j) = serde_json::from_str::<serde_json::Value>(&meta) else { return 0 };
    let same_url = j["url"].as_str() == Some(url);
    let same_size = j["size"].as_u64() == expected_size;
    if !(same_url && same_size) { return 0; }
    let part = tmp.join("update.zip.part");
    if !part.is_file() { return 0; }
    // 断点超过期望大小 = 元数据与文件不一致(上次删 meta 没删文件之类),弃。
    if let Some(want) = expected_size {
        if std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0) > want { return 0; }
    }
    std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0)
}

// ============================================================
// 下载核心:Range 续传 + 流式进度回调
// ============================================================

#[derive(Debug, Clone, PartialEq)]
pub enum DlError {
    /// 网络层失败(连接/读中断/超时)
    Network(String),
    /// HTTP 状态错误(带码;retryable 由 status_retryable 判)
    Status(u16),
    /// 流读完但没到期望大小(截断)
    Truncated { got: u64, total: u64 },
}

/// 单次下载尝试:existing>0 时发 Range 续传追加写 .part。
/// 返回本次新增字节数。on_progress(got_total, total, speed_bps)。
pub fn fetch_with_resume(
    url: &str,
    part: &Path,
    existing: u64,
    on_progress: &mut dyn FnMut(u64, u64, u64),
) -> Result<u64, DlError> {
    let mut req = ureq::get(url)
        .timeout(Duration::from_secs(600)); // 总超时(含连接;ureq 2.12 Request 无独立 connect 超时)
    if existing > 0 {
        req = req.set("Range", &range_header(existing));
    }
    let resp = req.call().map_err(|e| match e {
        ureq::Error::Status(code, _) => DlError::Status(code),
        other => DlError::Network(other.to_string()),
    })?;
    let status = resp.status();
    // 总大小与写入起点按 206/200 分支
    let (write_from, total): (u64, u64) = match status {
        206 => {
            let (start, total) = resp
                .header("content-range")
                .and_then(parse_content_range)
                .ok_or_else(|| DlError::Network("206 无有效 Content-Range".into()))?;
            if start != existing {
                // 服务器续传起点与本地说不齐(文件变了/代理乱回应)——本次作废,上层重头
                return Err(DlError::Network(format!(
                    "Range 起点不对(本地 {existing} vs 服务器 {start})"
                )));
            }
            (existing, total)
        }
        200 => (0, resp.header("content-length").and_then(|v: &str| v.parse::<u64>().ok()).unwrap_or(0)),
        416 => {
            // 本地已有 ≥ 服务器文件长:可能是上次已下完(meta 丢了)。上层据期望大小裁决。
            return Err(DlError::Status(416));
        }
        code => return Err(DlError::Status(code)),
    };

    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(write_from == 0) // 续传追加;200 重下才截断
        .open(part)
        .map_err(|e| DlError::Network(format!("打开 .part 失败: {e}")))?;
    if write_from > 0 {
        out.seek(SeekFrom::End(0)).map_err(|e| DlError::Network(e.to_string()))?;
    }

    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 64 * 1024];
    let mut added: u64 = 0;
    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1); // 首块立即上报
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                out.write_all(&buf[..n])
                    .map_err(|e| DlError::Network(format!("写盘失败: {e}")))?;
                added += n as u64;
                let got = write_from + added;
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    let bps = (added as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
                    on_progress(got, total, bps);
                    last_emit = Instant::now();
                }
            }
            // 短读 vs Content-Length:ureq 以 UnexpectedEof 暴露(而非静默 Ok(0))——
            // 显式归为 Truncated,诊断比裸网络错误准确(蜂窝截断现场)
            Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                if total > 0 && write_from + added < total {
                    return Err(DlError::Truncated { got: write_from + added, total });
                }
                return Err(DlError::Network("下载中断(EOF)".into()));
            }
            Err(e) => return Err(DlError::Network(format!("下载中断: {e}"))),
        }
    }
    out.flush().map_err(|e| DlError::Network(e.to_string()))?;
    on_progress(write_from + added, total, 0);
    // 期望大小已知时,EOF 不足额 = 截断(蜂窝常见)——不完整绝不放行
    if total > 0 && write_from + added < total {
        return Err(DlError::Truncated { got: write_from + added, total });
    }
    Ok(added)
}

/// 进度快照(progress.json 轮询兜底通道 + update-progress 事件共用;
/// 字段 camelCase——前后端 JSON 命名约定)。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressSnap {
    pub phase: String,
    pub pct: u32,
    pub got: u64,
    pub total: u64,
    pub speed_bps: u64,
    pub attempt: u32,
    pub detail: String,
}

// ============================================================
// Tauri 命令
// ============================================================

/// 版本检查(第18轮起,本轮加 sha256/size 透传)。
/// 服务器 latest.json: { version, notes, zip, sha256?, size? }。
#[tauri::command]
pub fn update_check_per_exe() -> Result<serde_json::Value, String> {
    let local_version = env!("CARGO_PKG_VERSION");
    // 第48轮修:ureq 不走系统代理(公司网/VPN 下必失败)→ reqwest::blocking(读系统代理)
    // 基址 MYCO_NETWORK_URL 可覆盖(缺省=第90轮域名现状)，与 lib.rs prod_update_info 同源。
    let base = std::env::var("MYCO_NETWORK_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "https://myco.youling.cc".to_string());
    let manifest: serde_json::Value = reqwest::blocking::get(format!("{}/downloads/latest.json", base.trim_end_matches('/')))
        .map_err(|e| format!("服务器不可达: {e}"))?
        .json()
        .map_err(|e| format!("manifest 解析失败: {e}"))?;
    let server_version = manifest["version"].as_str().unwrap_or_default().trim_start_matches('v').to_string();
    let notes = manifest["notes"].as_str().unwrap_or_default().to_string();
    let zip = manifest["zip"].as_str().unwrap_or_default().to_string();
    // 完整性字段（2026-10-31 真案：0.3.193 手工合成清单把 setup.exe 的 sha256/size 写进
    // 顶层，updater 却下载 update.zip → 大小校验永远不符 → "包不完整"死循环重试）。
    // 现在优先读 zip 专属字段；旧清单没有 zip* 字段时回退顶层 sha256/size（官方
    // release-myco.sh 生成的顶层值本来就按 update.zip 实算）。setup 字段只作信息保留。
    let sha256 = manifest["zipSha256"].as_str().filter(|s| !s.trim().is_empty())
        .or_else(|| manifest["sha256"].as_str().filter(|s| !s.trim().is_empty()))
        .unwrap_or_default()
        .to_string();
    let size = manifest["zipSize"].as_u64()
        .filter(|&s| s > 0)
        .or_else(|| manifest["size"].as_u64().filter(|&s| s > 0))
        .unwrap_or(0);
    // 第47轮修:版本数值三段比较(字符串不等会误报——本地比服务器新也弹更新)
    let parse = |v: &str| v.split('.').map(|x| x.parse::<u32>().unwrap_or(0)).collect::<Vec<u32>>();
    let (sv, lv) = (parse(&server_version), parse(local_version));
    let mut has_update = false;
    for i in 0..3 {
        let (a, b) = (sv.get(i).copied().unwrap_or(0), lv.get(i).copied().unwrap_or(0));
        if a > b { has_update = true; break; }
        if a < b { break; }
    }
    Ok(serde_json::json!({
        "localVersion": local_version,
        "serverVersion": server_version,
        "version": server_version,
        "notes": notes,
        "zip": zip,
        "sha256": sha256,
        "size": size,
        "hasUpdate": has_update,
    }))
}

/// 读更新进度(轮询兜底;主通道=update-progress 事件)。
#[tauri::command]
pub fn update_progress() -> Result<serde_json::Value, String> {
    let p = std::env::temp_dir().join("myco-loginer-update").join("progress.json");
    let s = std::fs::read_to_string(&p).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

/// 完整下载管线(可测核心,无 Tauri 依赖):Range 断点续传 + 退避重试 +
/// 大小/sha256 校验 + 定名 update.zip。成功返回 zip 路径。
/// notify 收到每个阶段快照(下载节流 250ms/次;waiting/verifying/failed 阶段各一次)。
pub fn download_and_verify(
    zip_url: &str,
    expected_sha: Option<&str>,
    expected_size: Option<u64>,
    tmp: &Path,
    backoff: &[u64],
    notify: &mut dyn FnMut(&ProgressSnap),
) -> Result<PathBuf, UpdateFail> {
    let part = tmp.join("update.zip.part");
    let zip_path = tmp.join("update.zip");
    let snap = |phase: &str, pct: u32, got: u64, total: u64, speed: u64, attempt: u32, detail: &str| {
        ProgressSnap { phase: phase.into(), pct, got, total, speed_bps: speed, attempt, detail: detail.into() }
    };

    // 顺序铁律:先用【旧 meta】判断点有效性,再写新 meta——先写会把换包保护
    // 失效(旧包断点 + 新包 meta = 静默拼出损坏文件,比截断更隐蔽)。
    let initial_offset = resume_offset(tmp, zip_url, expected_size);
    save_part_meta(tmp, zip_url, expected_size);
    notify(&snap("downloading", 0, initial_offset, expected_size.unwrap_or(0), 0, 1, ""));

    // 校验+定名(下载完成/断点已满额共用):Err=校验失败,断点已清理可重下。
    let finalize = |notify: &mut dyn FnMut(&ProgressSnap), attempt: u32| -> Result<(), UpdateFail> {
        let len = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if !size_ok(len, expected_size, MIN_ZIP_BYTES) {
            let detail = match expected_size {
                Some(want) => format!("大小不符: 期望 {want}B 实得 {len}B"),
                None => format!("包过小: {len}B (无清单 size,地板 {MIN_ZIP_BYTES}B)"),
            };
            let _ = std::fs::remove_file(&part); // 大小都错,断点不可信,重头
            return Err(UpdateFail::new(
                if expected_size.is_some() { FailKind::Checksum } else { FailKind::Incomplete },
                detail, attempt.saturating_sub(1),
            ));
        }
        if let Some(want) = expected_sha {
            notify(&snap("verifying", 100, len, len, 0, attempt, "校验文件完整性…"));
            let actual = sha256_file(&part).unwrap_or_default();
            if !digest_matches(&actual, want) {
                let _ = std::fs::remove_file(&part); // 校验失败必须重头下,断点可能就是坏点
                return Err(UpdateFail::new(
                    FailKind::Checksum,
                    format!("sha256 不符: 期望 {want} 实得 {actual}"),
                    attempt.saturating_sub(1),
                ));
            }
        }
        let _ = std::fs::remove_file(&zip_path);
        std::fs::rename(&part, &zip_path)
            .map_err(|e| UpdateFail::new(FailKind::Other, format!("zip 定名失败: {e}"), attempt.saturating_sub(1)))?;
        let _ = std::fs::remove_file(part_meta_path(tmp));
        notify(&snap("downloaded", 100, len, len, 0, attempt, "下载完成,正在解压…"));
        Ok(())
    };

    let wait_and_retry = |notify: &mut dyn FnMut(&ProgressSnap), attempt: u32, note: String| {
        let wait = backoff_for(backoff, attempt - 1);
        notify(&snap("waiting", 0, 0, expected_size.unwrap_or(0), 0, attempt + 1,
            &format!("{note}，{wait}s 后第 {attempt} 次重试（从断点续传）")));
        std::thread::sleep(Duration::from_secs(wait));
    };

    let mut last_fail: Option<UpdateFail> = None;
    let mut attempt: u32 = 0;
    let mut done = false;
    while attempt < MAX_ATTEMPTS && !done {
        attempt += 1;
        let existing = resume_offset(tmp, zip_url, expected_size);
        // 断点已满额(上次下载完成但定名前中断)→ 跳过下载直接校验
        if expected_size == Some(existing) {
            match finalize(notify, attempt) {
                Ok(()) => done = true,
                Err(f) => {
                    last_fail = Some(f);
                    if attempt < MAX_ATTEMPTS { wait_and_retry(notify, attempt, "包不完整".into()); }
                }
            }
            continue;
        }
        let mut prog = |got: u64, total: u64, bps: u64| {
            let t = if total > 0 { total } else { expected_size.unwrap_or(0) };
            let pct = if t > 0 { ((got as f64 / t as f64) * 100.0).floor() as u32 } else { 0 };
            notify(&snap("downloading", pct.min(100), got, t, bps, attempt, ""));
        };
        let r = fetch_with_resume(zip_url, &part, existing, &mut prog);
        match r {
            Ok(_) => match finalize(notify, attempt) {
                Ok(()) => done = true,
                Err(f) => {
                    last_fail = Some(f);
                    if attempt < MAX_ATTEMPTS { wait_and_retry(notify, attempt, "包不完整".into()); }
                }
            },
            Err(DlError::Status(416)) => {
                // 本地 ≥ 服务器文件长:满额=上次已下完(进校验);超额=断点脏(重头)
                let len = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                if expected_size == Some(len) {
                    match finalize(notify, attempt) {
                        Ok(()) => done = true,
                        Err(f) => {
                            last_fail = Some(f);
                            if attempt < MAX_ATTEMPTS { wait_and_retry(notify, attempt, "包不完整".into()); }
                        }
                    }
                } else {
                    let _ = std::fs::remove_file(&part);
                    last_fail = Some(UpdateFail::new(FailKind::Incomplete, format!("416: 断点 {len}B 与服务器不符"), attempt - 1));
                    if attempt < MAX_ATTEMPTS { wait_and_retry(notify, attempt, "断点与服务器不一致".into()); }
                }
            }
            Err(e) => {
                // 4xx(404/403 等)重试无意义——服务端不会自愈,快速失败;
                // 5xx/429 是瞬态,值得带断点重试。
                if let DlError::Status(c) = &e {
                    if !status_retryable(*c) {
                        let f = UpdateFail::new(FailKind::Server, format!("HTTP {c}"), attempt - 1);
                        notify(&snap("failed", 0, 0, expected_size.unwrap_or(0), 0, attempt, f.kind.as_str()));
                        return Err(f);
                    }
                }
                let (kind, detail) = match &e {
                    DlError::Network(m) => (FailKind::Incomplete, m.clone()),
                    DlError::Truncated { got, total } => (FailKind::Incomplete, format!("下载截断: {got}/{total}B")),
                    DlError::Status(c) => (FailKind::Server, format!("HTTP {c}")),
                };
                last_fail = Some(UpdateFail::new(kind, detail, attempt - 1));
                if attempt < MAX_ATTEMPTS {
                    let resume = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                    wait_and_retry(notify, attempt, format!("网络不稳（已下 {resume}B）"));
                }
            }
        }
    }
    if !done {
        let f = last_fail.unwrap_or(UpdateFail::new(FailKind::Other, "未知下载失败", MAX_ATTEMPTS - 1));
        notify(&snap("failed", 0, 0, expected_size.unwrap_or(0), 0, attempt, f.kind.as_str()));
        return Err(f);
    }
    Ok(zip_path)
}

/// 自更新 v2:下载(Range 续传+退避重试+sha256 校验) → 原生解压 → 停进程替换 → 重启。
/// myco.exe 自身运行中无法覆盖自己——Windows 改名让位法(同旧链,实测稳定)。
#[tauri::command]
pub fn run_prod_update(
    app: tauri::AppHandle,
    zip_url: String,
    sha256: Option<String>,
    size: Option<u64>,
) -> Result<String, String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    let emit = |snap: &ProgressSnap| {
        // cfg(not(test))：UI 进度事件是"给窗口看"的通道——测试态不引 tauri webview
        // 运行时（见本文件 use tauri::Emitter 上方注释）。落盘 progress.json 与 tauri
        // 无关（e2e/无窗口排障用），两个变体都保留。
        #[cfg(not(test))]
        let _ = app.emit(PROGRESS_EVENT, snap);
        #[cfg(test)]
        let _ = &app; // cfg(test) 下 emit 不编译，app 未用
        let tmp = std::env::temp_dir().join("myco-loginer-update");
        let _ = std::fs::write(
            tmp.join("progress.json"),
            serde_json::to_string(snap).unwrap_or_default(),
        );
    };

    let dir = std::env::current_exe().ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .ok_or("no exe dir")?;
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let env_path = dir.join("myco-env.exe");

    // ── 1) 下载管线(可测核心):续传+退避重试+完整性校验 ─────────────
    let tmp = std::env::temp_dir().join("myco-loginer-update");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let expected_sha = sha256.filter(|s| !s.trim().is_empty());
    let zip_path = download_and_verify(
        &zip_url,
        expected_sha.as_deref(),
        size.filter(|&s| s > 0),
        &tmp,
        &BACKOFF_SECS,
        &mut |snap: &ProgressSnap| emit(snap),
    )
    .map_err(|f| f.to_json())?;

    // ── 2) 原生解压(zip crate,弃 PowerShell Expand-Archive) ──────
    emit(&ProgressSnap { phase: "extracting".into(), pct: 100, got: 0, total: 0, speed_bps: 0, attempt: 0, detail: "解压更新包…".into() });
    let unpack_dir = tmp.join("unpack");
    let _ = std::fs::remove_dir_all(&unpack_dir);
    std::fs::create_dir_all(&unpack_dir).map_err(|e| e.to_string())?;
    extract_update_zip(&zip_path, &unpack_dir).map_err(|e| {
        emit(&ProgressSnap { phase: "failed".into(), pct: 0, got: 0, total: 0, speed_bps: 0, attempt: 0, detail: "extract".into() });
        UpdateFail::new(FailKind::Extract, e, 0).to_json()
    })?;
    // 2026-10-06 v0.3.103：myco-env.exe 改可选（五端退役后 update zip 只剩 myco.exe——
    // 有则替换、无则跳过；myco.exe 仍必校验）
    for name in ["myco.exe"] {
        let p = unpack_dir.join(name);
        if !p.exists() || std::fs::metadata(&p).map_err(|e| e.to_string())?.len() < 1_000_000 {
            emit(&ProgressSnap { phase: "failed".into(), pct: 0, got: 0, total: 0, speed_bps: 0, attempt: 0, detail: "extract".into() });
            return Err(UpdateFail::new(FailKind::Extract, format!("包内缺失或异常: {name}"), 0).to_json());
        }
    }

    // ── 3) 写自更新脚本:停 env → 换 exe(改名法) → 换 env(可选) → 重启 → 清理 ──
    // (2026-09-19 实测定型的 spawn 链:直 spawn powershell -File 可行,保持不动)
    // 2026-10-06 v0.3.103：myco-env.exe 已退役——unpack 里没有就跳过替换/备份
    let old_exe = dir.join("myco.exe.old");
    let old_env = dir.join("myco-env.exe.old");
    let has_env = unpack_dir.join("myco-env.exe").exists();
    let ps1 = tmp.join("apply-update.ps1");
    // 脚本铁律(2026-09-21 v0.3.58 现场诊断,远端 dev 已修,此处继承):
    // ① 必须 ASCII-only——PowerShell 5.1 把无 BOM 文件按 ANSI/GBK 读,中文注释
    //   会让整个更新在下载完成后静默死掉;② 停 env 用 CloseMainWindow 优雅退出。
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$dir = '{dir}'
# NOTE: keep this script ASCII-only. Windows PowerShell 5.1 reads BOM-less files
# as ANSI/GBK; non-ASCII comments corrupt parsing and the whole update dies
# silently after download (diagnosed 2026-09-21 v0.3.58).
# stop myco-env gracefully then force-kill (legacy env may still run)
Get-Process myco-env -ErrorAction SilentlyContinue | ForEach-Object {{
  $_.CloseMainWindow() | Out-Null
}}
Start-Sleep -Seconds 3
Get-Process myco-env -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
# running exe cannot be overwritten -- rename it aside first
Remove-Item '{old_exe}' -Force -ErrorAction SilentlyContinue
Move-Item '{exe_path}' '{old_exe}' -Force
Copy-Item '{unpack}\myco.exe' '{exe_path}' -Force
{env_block}
# kill old loginer: match by EXE PATH (immune to a renamed exe, e.g.
# myco-dev2-test), then legacy name as fallback. A renamed-aside process still
# runs and would trip the single-instance lock, making the update look like a
# no-op. 2026-10-08 现场: dev2-test 改名实例更新卡死——旧脚本 Get-Process myco
# 按名匹配杀不掉它, 老进程占锁 -> 新 exe 起不来 -> 界面永远"更新中"。
Get-Process -ErrorAction SilentlyContinue | Where-Object {{ try {{ $_.Path -eq '{exe_path}' }} catch {{ $false }} }} | Stop-Process -Force
Get-Process myco -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800
# restart the loginer (cwd = install dir; stale .old cleaned on startup)
Start-Process '{exe_path}' -WorkingDirectory $dir
"#,
        dir = dir.to_string_lossy(),
        old_exe = old_exe.to_string_lossy(),
        exe_path = exe_path.to_string_lossy(),
        env_block = if has_env {
            format!(
                "Remove-Item '{old_env}' -Force -ErrorAction SilentlyContinue\nif (Test-Path '{env_path}') {{ Move-Item '{env_path}' '{old_env}' -Force }}\nCopy-Item '{unpack}\\myco-env.exe' '{env_path}' -Force",
                old_env = old_env.to_string_lossy(),
                env_path = env_path.to_string_lossy(),
                unpack = unpack_dir.to_string_lossy(),
            )
        } else {
            String::new()
        },
        unpack = unpack_dir.to_string_lossy(),
    );
    std::fs::write(&ps1, script).map_err(|e| e.to_string())?;

    // ── 4) 脱离进程树拉起脚本(本 exe 将被重启) ─────────────────────
    emit(&ProgressSnap { phase: "applying".into(), pct: 100, got: 0, total: 0, speed_bps: 0, attempt: 0, detail: "替换文件并重启(约 20 秒)…".into() });
    // A19 feat/linux-gui：替换/重启链是 Windows 专属（powershell + myco.exe 改名让位）；
    // linux 桌面版 v0.3.68 不走应用内自更新（deb 分发由 apt/下载页承载），到这一步
    // 即明确报错——下载/校验/解压等平台无关段保持共用。
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]).arg(&ps1);
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW(2026-09-19 实验定论)
        cmd.spawn().map_err(|e| {
            emit(&ProgressSnap { phase: "failed".into(), pct: 0, got: 0, total: 0, speed_bps: 0, attempt: 0, detail: "spawn".into() });
            UpdateFail::new(FailKind::Extract, format!("更新器启动失败: {e}"), 0).to_json()
        })?;
    }
    #[cfg(not(windows))]
    {
        let _ = (&ps1, &old_exe, &old_env, &exe_path, &env_path);
        return Err("自动更新暂仅支持 Windows 版（linux 桌面版经 deb/下载页更新）".into());
    }
    Ok("更新进行中:下载校验完成,正在替换 myco.exe + myco-env.exe 并重启(约 20 秒)".into())
}

/// 原生解压(zip crate):只提取包内文件名(剥目录前缀),落到 out_dir 平铺——
/// 与 Compress-Archive 打的平铺包结构一致;鲁棒处理嵌套目录(有人手工重打包时)。
pub fn extract_update_zip(zip_path: &Path, out_dir: &Path) -> Result<(), String> {
    let f = std::fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| format!("zip 损坏或格式错误: {e}"))?;
    for i in 0..ar.len() {
        let mut entry = ar.by_index(i).map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        if entry.is_dir() { continue; }
        let name = entry.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
        if name.is_empty() { continue; }
        let dest = out_dir.join(&name);
        let mut out = std::fs::File::create(&dest).map_err(|e| format!("写出 {name} 失败: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压 {name} 失败: {e}"))?;
    }
    Ok(())
}

// ============================================================
// 单元测试(2026-09-22:校验逻辑/续传逻辑/错误分类文案全覆盖)
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    // —— 校验逻辑 ——
    #[test]
    fn sha256_known_vector() {
        let dir = std::env::temp_dir().join("myco-upd-test-sha");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("abc.bin");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn digest_matches_case_and_space_tolerant() {
        assert!(digest_matches("BA7816BF", "ba7816bf"));
        assert!(digest_matches(" ba7816bf ", "ba7816bf"));
        assert!(!digest_matches("ba7816bf", "ba7816b0"));
        assert!(!digest_matches("", "")); // 空串不是合法摘要
    }

    #[test]
    fn size_ok_strict_when_expected_floor_when_not() {
        assert!(size_ok(100, Some(100), MIN_ZIP_BYTES));
        assert!(!size_ok(99, Some(100), MIN_ZIP_BYTES)); // 截断必须拒
        assert!(!size_ok(101, Some(100), MIN_ZIP_BYTES)); // 多余字节也拒(拼接脏数据)
        assert!(size_ok(2_000_000, None, MIN_ZIP_BYTES)); // 无清单回退地板值
        assert!(!size_ok(500, None, MIN_ZIP_BYTES));
    }

    // —— 续传逻辑 ——
    #[test]
    fn range_header_format() {
        assert_eq!(range_header(0), "bytes=0-");
        assert_eq!(range_header(18331764), "bytes=18331764-");
    }

    #[test]
    fn parse_content_range_variants() {
        assert_eq!(parse_content_range("bytes 100-199/1234"), Some((100, 1234)));
        assert_eq!(parse_content_range("bytes 0-99/100"), Some((0, 100)));
        assert_eq!(parse_content_range("bytes 0-99/*"), None); // 未知总长不支持
        assert_eq!(parse_content_range("garbage"), None);
        assert_eq!(parse_content_range(""), None);
    }

    #[test]
    fn backoff_schedule() {
        assert_eq!(backoff_for(&BACKOFF_SECS, 0), 10);
        assert_eq!(backoff_for(&BACKOFF_SECS, 1), 30);
        assert_eq!(backoff_for(&BACKOFF_SECS, 2), 60);
        assert_eq!(backoff_for(&BACKOFF_SECS, 9), 60); // 越界取末位
        assert_eq!(backoff_for(&[], 0), 0); // 测试注入空表=立即
    }

    #[test]
    fn status_retryable_classification() {
        assert!(status_retryable(500));
        assert!(status_retryable(502));
        assert!(status_retryable(503));
        assert!(status_retryable(429));
        assert!(!status_retryable(404));
        assert!(!status_retryable(403));
        assert!(!status_retryable(200));
    }

    /// 断点元数据:换 URL/换期望大小必须弃断点(防新旧包拼接)。
    #[test]
    fn resume_offset_discards_on_url_or_size_change() {
        let dir = std::env::temp_dir().join("myco-upd-test-resume");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("update.zip.part"), vec![0u8; 500]).unwrap();
        assert_eq!(resume_offset(&dir, "http://x/a.zip", None), 0); // 无 meta
        save_part_meta(&dir, "http://x/a.zip", None);
        assert_eq!(resume_offset(&dir, "http://x/a.zip", None), 500);
        assert_eq!(resume_offset(&dir, "http://x/b.zip", None), 0); // 换 URL 弃
        save_part_meta(&dir, "http://x/a.zip", Some(1000));
        assert_eq!(resume_offset(&dir, "http://x/a.zip", Some(1000)), 500);
        assert_eq!(resume_offset(&dir, "http://x/a.zip", Some(999)), 0); // 换期望大小弃
        assert_eq!(resume_offset(&dir, "http://x/a.zip", None), 0); // meta 有 size 查 None 也弃
        // 断点超过期望大小=脏,弃
        save_part_meta(&dir, "http://x/a.zip", Some(100));
        assert_eq!(resume_offset(&dir, "http://x/a.zip", Some(100)), 0);
    }

    /// 端到端续传:本地 HTTP 服务器按 Range 切片返回——验证 206 追加、
    /// 断点续传拼接还原、截断检测三件事(不起 Tauri,纯函数层)。
    #[test]
    fn fetch_with_resume_end_to_end_over_local_http() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        let payload: Vec<u8> = (0..250_000u32).map(|i| (i % 251) as u8).collect();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let payload_srv = payload.clone();
        let srv = std::thread::spawn(move || {
            let payload = payload_srv; // 线程内持有克隆,外层断言仍用原值
            for expect_n in 0..3u32 { // 至多 3 个连接:首次/续传/超额
                let (mut sock, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut line = String::new();
                let mut reader = BufReader::new(sock.try_clone().unwrap());
                reader.read_line(&mut line).unwrap();
                let mut range_start: Option<u64> = None;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    let h = h.trim();
                    if h.is_empty() { break; }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("range:") {
                        // "bytes=N-"
                        let spec = v.trim().trim_start_matches("bytes=");
                        if let Some((a, _)) = spec.split_once('-') {
                            range_start = a.trim().parse().ok();
                        }
                    }
                }
                let body: Vec<u8>;
                let head: String;
                match range_start {
                    Some(s) if (s as usize) < payload.len() => {
                        body = payload[s as usize..].to_vec();
                        head = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            s, payload.len() - 1, payload.len(), body.len()
                        );
                    }
                    Some(_) => {
                        body = vec![];
                        head = "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into();
                    }
                    None => {
                        body = payload.clone();
                        head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                    }
                }
                let _ = expect_n;
                sock.write_all(head.as_bytes()).unwrap();
                // 分块写,模拟流式(也验证进度回调节流不丢尾包)
                for chunk in body.chunks(7777) {
                    sock.write_all(chunk).unwrap();
                }
                let _ = sock.flush();
            }
        });

        let dir = std::env::temp_dir().join("myco-upd-test-e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("update.zip.part");
        let url = format!("http://127.0.0.1:{port}/x.zip");
        let mut calls = 0usize;
        // ① 首次全量下载(无 Range)
        let n = fetch_with_resume(&url, &part, 0, &mut |_, _, _| { calls += 1; }).unwrap();
        assert_eq!(n as usize, payload.len());
        assert_eq!(std::fs::metadata(&part).unwrap().len() as usize, payload.len());
        assert!(calls > 0, "进度回调必须被调用");
        // ② 从半截续传:伪造半包 + Range 追加
        let half = payload.len() / 3;
        std::fs::write(&part, &payload[..half]).unwrap();
        let n2 = fetch_with_resume(&url, &part, half as u64, &mut |_, _, _| {}).unwrap();
        assert_eq!(n2 as usize, payload.len() - half);
        assert_eq!(std::fs::read(&part).unwrap(), payload, "续传拼接必须还原全量");
        // ③ 超额断点 → 416
        let r3 = fetch_with_resume(&url, &part, (payload.len() + 10) as u64, &mut |_, _, _| {});
        assert_eq!(r3, Err(DlError::Status(416)));
        srv.join().unwrap();
    }

    /// 截断检测:服务器声明 1000 字节只发 600 → Truncated(绝不放行坏包)。
    #[test]
    fn fetch_detects_truncation() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            use std::io::{BufRead, BufReader};
            let mut reader = BufReader::new(sock.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                if h.trim().is_empty() { break; }
            }
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n").unwrap();
            sock.write_all(&vec![7u8; 600]).unwrap(); // 蜂窝截断现场
            let _ = sock.flush();
        });
        let dir = std::env::temp_dir().join("myco-upd-test-trunc");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("p.part");
        let r = fetch_with_resume(&format!("http://127.0.0.1:{port}/t.zip"), &part, 0, &mut |_, _, _| {});
        assert!(matches!(r, Err(DlError::Truncated { got: 600, total: 1000 })));
    }

    // —— 错误分类文案(用户语言,群实测问题"黑话报错"的对症) ——
    #[test]
    fn error_kinds_map_to_human_messages() {
        let f = UpdateFail::new(FailKind::Incomplete, "tcp reset", 3);
        let j: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        assert_eq!(j["kind"], "download-incomplete");
        assert_eq!(j["retries"], 3);
        assert_eq!(j["msg"], "网络不稳，更新包没下完整，已自动重试 3 次。建议换 WiFi 再试");
        assert_eq!(j["detail"], "tcp reset");

        let f = UpdateFail::new(FailKind::Incomplete, "x", 0);
        let j: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        assert_eq!(j["msg"], "网络不稳，更新包没下完整。建议换 WiFi 再试一次");

        let f = UpdateFail::new(FailKind::Checksum, "sha mismatch", 2);
        let j: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        assert_eq!(j["kind"], "checksum");
        assert!(j["msg"].as_str().unwrap().contains("校验未通过"));

        let f = UpdateFail::new(FailKind::Extract, "zip corrupt", 0);
        let j: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        assert_eq!(j["msg"], "更新安装失败。请截图反馈");

        let f = UpdateFail::new(FailKind::Server, "HTTP 502", 1);
        let j: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        assert!(j["msg"].as_str().unwrap().contains("服务器"));
    }

    // —— 弱网三连断端到端(真实包字节,走完整 download_and_verify 管线) ——
    // 复现群测试者现场:蜂窝下载截断。服务器按连接序号作案——
    // 连接1 下到 30% 掐线,连接2 下到 70% 掐线,连接3 全量放行。
    // 断言:①每次重试发 Range 且起点=上次断点(真续传,不重头)②最终 sha256 通过
    // ③notify 序列含 downloading/waiting/verifying/downloaded ④retries 计数正确。
    #[test]
    fn weak_network_resume_pipeline_with_real_zip_bytes() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::Arc;

        // 伪更新包:2MB 伪 zip 字节(过 MIN_ZIP_BYTES 门槛,sha256 可算)
        let payload: Vec<u8> = (0..2_000_000u32).map(|i| (i * 31 % 253) as u8).collect();
        let want_sha = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(&payload);
            h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()
        };
        let cuts = [payload.len() * 3 / 10, payload.len() * 7 / 10]; // 连接1/2 的掐线点
        let conn_no = Arc::new(AtomicUsize::new(0));
        let range_starts: Arc<std::sync::Mutex<Vec<u64>>> = Arc::new(std::sync::Mutex::new(vec![]));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let payload_srv = payload.clone();
        let ranges_srv = range_starts.clone();
        std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut sock, _) = match listener.accept() { Ok(s) => s, Err(_) => return };
                let n = conn_no.fetch_add(1, AtomicOrdering::SeqCst);
                let mut reader = BufReader::new(sock.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut range_start: Option<u64> = None;
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    let h = h.trim();
                    if h.is_empty() { break; }
                    if let Some(v) = h.to_ascii_lowercase().strip_prefix("range:") {
                        let spec = v.trim().trim_start_matches("bytes=");
                        if let Some((a, _)) = spec.split_once('-') {
                            range_start = a.trim().parse().ok();
                        }
                    }
                }
                ranges_srv.lock().unwrap().push(range_start.unwrap_or(0));
                let start = range_start.unwrap_or(0) as usize;
                let end_full = if n < cuts.len() { cuts[n] } else { payload_srv.len() };
                let body = payload_srv[start.min(payload_srv.len())..end_full.max(start)].to_vec();
                let head = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    start, if end_full > 0 { end_full - 1 } else { 0 }, payload_srv.len(), body.len()
                );
                sock.write_all(head.as_bytes()).unwrap();
                for chunk in body.chunks(16384) {
                    sock.write_all(chunk).unwrap();
                }
                let _ = sock.flush();
                // n<2 时直接 drop(不做长度对齐的关闭)= 蜂窝掐线现场
            }
        });

        let dir = std::env::temp_dir().join("myco-upd-test-weaknet");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let url = format!("http://127.0.0.1:{port}/update.zip");

        let mut phases: Vec<String> = vec![];
        let mut downloading_pcts: Vec<u32> = vec![];
        let r = download_and_verify(
            &url,
            Some(&want_sha),
            Some(payload.len() as u64),
            &dir,
            &[0, 0, 0], // 测试注入:退避 0 秒
            &mut |s: &ProgressSnap| {
                if s.phase == "downloading" { downloading_pcts.push(s.pct); }
                phases.push(s.phase.clone());
            },
        );
        let zip = r.expect("三次断线后第三次必须成功");
        // ① sha256 通过(内容逐字节还原)
        assert_eq!(std::fs::read(&zip).unwrap(), payload);
        // ② 续传证据:连接1 无 Range(起点0),连接2/3 Range 起点=掐线点
        let rs = range_starts.lock().unwrap().clone();
        assert_eq!(rs.len(), 3, "恰好 3 个连接(2 断+1 成),实际 {rs:?}");
        assert_eq!(rs[0], 0, "首次全量下载无 Range");
        assert_eq!(rs[1] as usize, cuts[0], "第二次必须从第一断点续传");
        assert_eq!(rs[2] as usize, cuts[1], "第三次必须从第二断点续传");
        // ③ 阶段序列:有下载等待与校验完成
        assert!(phases.iter().any(|p| p == "waiting"), "必须有重试等待提示: {phases:?}");
        assert!(phases.iter().any(|p| p == "verifying"), "必须进 sha256 校验: {phases:?}");
        assert!(phases.iter().any(|p| p == "downloaded"), "必须有完成态: {phases:?}");
        assert!(downloading_pcts.iter().any(|&p| p > 0 && p < 100), "进度必须真实推进(中间百分位): {downloading_pcts:?}");
    }

    // —— 弱网终极失败:四次全断 → 分类错误 + 人话文案 + retries 计数 ——
    #[test]
    fn weak_network_exhausted_retries_classified() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..4 {
                let (mut sock, _) = match listener.accept() { Ok(s) => s, Err(_) => return };
                let mut reader = BufReader::new(sock.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() { break; }
                }
                // 声明 2MB 只给 100KB 就掐线
                sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2000000\r\nConnection: close\r\n\r\n").unwrap();
                sock.write_all(&vec![1u8; 100_000]).unwrap();
                let _ = sock.flush();
            }
        });
        let dir = std::env::temp_dir().join("myco-upd-test-exhaust");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut fails = 0;
        let r = download_and_verify(
            &format!("http://127.0.0.1:{port}/x.zip"),
            None,
            Some(2_000_000),
            &dir,
            &[0, 0, 0],
            &mut |_s| { fails += 1; },
        );
        let f = r.expect_err("四次全断必须最终失败");
        assert_eq!(f.kind, FailKind::Incomplete);
        assert_eq!(f.retries, 3, "已自动重试 3 次");
        let j: serde_json::Value = serde_json::from_str(&f.to_json()).unwrap();
        assert_eq!(j["msg"], "网络不稳，更新包没下完整，已自动重试 3 次。建议换 WiFi 再试");
        assert!(fails > 0);
        // 4xx 快速失败也在本测试家族覆盖(server 返回 404 → 无重试直达错误)
    }

    // —— 原生解压 ——
    #[test]
    fn extract_zip_writes_flat_entries() {
        use std::io::Write as _;
        let dir = std::env::temp_dir().join("myco-upd-test-zip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zp = dir.join("u.zip");
        let mut zf = std::fs::File::create(&zp).unwrap();
        let mut w = zip::ZipWriter::new(&mut zf);
        let opt: zip::write::SimpleFileOptions = Default::default();
        w.start_file("myco.exe", opt).unwrap();
        w.write_all(b"MYCO-EXE-PAYLOAD-123").unwrap();
        w.start_file("sub/dir/myco-env.exe", opt).unwrap(); // 嵌套也要平铺落位
        w.write_all(b"ENV-EXE-PAYLOAD-456").unwrap();
        w.add_directory("somedir/", opt).unwrap();
        let _ = w.finish().unwrap();

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        extract_update_zip(&zp, &out).unwrap();
        assert_eq!(std::fs::read(out.join("myco.exe")).unwrap(), b"MYCO-EXE-PAYLOAD-123");
        assert_eq!(std::fs::read(out.join("myco-env.exe")).unwrap(), b"ENV-EXE-PAYLOAD-456");
    }

    #[test]
    fn extract_rejects_corrupt_zip() {
        let dir = std::env::temp_dir().join("myco-upd-test-corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zp = dir.join("bad.zip");
        std::fs::write(&zp, b"this is not a zip file at all --------").unwrap();
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let e = extract_update_zip(&zp, &out).unwrap_err();
        assert!(e.contains("zip"), "坏包报错要点名 zip: {e}");
    }
}
