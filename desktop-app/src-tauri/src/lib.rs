use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RpcRequest {
    id: String,
    method: String,
    params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RpcResponse {
    id: String,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

struct AgentRuntimeProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for AgentRuntimeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct AgentRuntimeState {
    process: Arc<Mutex<Option<AgentRuntimeProcess>>>,
}

// save_projects removes and recreates project subdirectories. Serialize every
// writer so background memory updates cannot race with publishing or backups.
static PROJECT_SAVE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn node_executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = bundled_agent_resource("node") {
        candidates.push(path);
    }
    if let Some(path) = bundled_agent_resource("node.exe") {
        candidates.push(path);
    }
    if let Ok(value) = std::env::var("APISAVERWRITER_NODE") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    // Finder/launched applications do not inherit a shell's PATH, so probe the
    // common per-user Node locations before relying on the bare command name.
    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local/bin/node"));
        candidates.push(home.join(".volta/bin/node"));
        candidates.push(home.join(".fnm/current/bin/node"));
        if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions = entries.filter_map(Result::ok).map(|entry| entry.path()).collect::<Vec<_>>();
            versions.sort();
            versions.reverse();
            candidates.extend(versions.into_iter().map(|version| version.join("bin/node")));
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from("node"),
    ]);

    let mut attempted = Vec::new();
    let mut seen = HashSet::new();
    for candidate in candidates {
        let key = candidate.to_string_lossy().to_string();
        if !seen.insert(key.clone()) { continue; }
        attempted.push(key);
        if Command::new(&candidate).arg("--version").output().map(|output| output.status.success()).unwrap_or(false) {
            return Ok(candidate);
        }
    }
    Err(format!("找不到可用的 Node.js 运行时（已检查 {}）。可设置 APISAVERWRITER_NODE 指向 node 可执行文件。", attempted.join("、")))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("仅允许打开 http/https 链接".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut value = Command::new("open");
        value.arg(trimmed);
        value
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut value = Command::new("cmd");
        value.args(["/C", "start", "", trimmed]);
        value
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut value = Command::new("xdg-open");
        value.arg(trimmed);
        value
    };
    #[cfg(any(target_os = "ios", target_os = "android"))]
    return Err("移动端使用系统链接回退".to_string());
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    command.spawn().map(|_| ()).map_err(|error| format!("打开外部链接失败：{error}"))
}

fn spawn_agent_runtime() -> Result<AgentRuntimeProcess, String> {
    let script = agent_runtime_script()?;
    let node = node_executable()?;
    let mut child = Command::new(&node)
        .arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 Agent 进程失败: {error}"))?;
    let stdin = child.stdin.take().ok_or_else(|| "无法打开 Agent 输入通道".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "无法打开 Agent 输出通道".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok() {
                if line.is_empty() { break; }
                line.clear();
            }
        });
    }
    Ok(AgentRuntimeProcess { child, stdin, stdout: BufReader::new(stdout) })
}

#[tauri::command]
fn start_agent_runtime(state: State<'_, AgentRuntimeState>) -> Result<String, String> {
    let mut process = state.process.lock().map_err(|_| "Agent runtime 状态锁定失败".to_string())?;
    let script = agent_runtime_script()?;
    let running = process.as_mut().map(|runtime| runtime.child.try_wait().map(|status| status.is_none()).unwrap_or(false)).unwrap_or(false);
    if !running {
        if let Some(mut old) = process.take() { let _ = old.child.kill(); }
        *process = Some(spawn_agent_runtime()?);
    }
    Ok(format!("Agent runtime ready: {}", script.display()))
}

#[tauri::command]
fn call_agent_rpc_blocking(app: tauri::AppHandle, process: Arc<Mutex<Option<AgentRuntimeProcess>>>, method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let mut runtime = process.lock().map_err(|_| "Agent runtime 状态锁定失败".to_string())?;
    let request = serde_json::json!({ "id": 1, "method": method, "params": params });
    for attempt in 0..2 {
        let needs_spawn = runtime.as_mut().map(|process| process.child.try_wait().map(|status| status.is_some()).unwrap_or(true)).unwrap_or(true);
        if needs_spawn {
            if let Some(mut old) = runtime.take() { let _ = old.child.kill(); }
            *runtime = Some(spawn_agent_runtime()?);
        }
        let active = runtime.as_mut().ok_or_else(|| "Agent runtime 未启动".to_string())?;
        if let Err(error) = active.stdin.write_all(format!("{}\n", request).as_bytes()).and_then(|_| active.stdin.flush()) {
            let _ = active.child.kill();
            if attempt == 0 { continue; }
            return Err(format!("发送 Agent 请求失败: {error}"));
        }
        let mut response: Option<Value> = None;
        for line in active.stdout.by_ref().lines() {
            let line = line.map_err(|error| format!("读取 Agent 进度失败: {error}"))?;
            if line.trim().is_empty() { continue; }
            let payload: Value = serde_json::from_str(&line)
                .map_err(|error| format!("解析 Agent 输出失败: {error}"))?;
            if payload.get("type").and_then(Value::as_str) == Some("agent_stream") {
                if let Some(event) = payload.get("event") {
                    let mut event = event.clone();
                    if let Some(run_id) = payload.get("runId") { event["runId"] = run_id.clone(); }
                    app.emit("agent-progress", event)
                        .map_err(|error| format!("发送 Agent 进度失败: {error}"))?;
                }
                continue;
            }
            response = Some(payload);
            break;
        }
        if let Some(response) = response {
            if let Some(error) = response.get("error") {
                return Err(error.get("message").and_then(Value::as_str).unwrap_or("Agent 执行失败").to_string());
            }
            return Ok(response.get("result").cloned().unwrap_or(response));
        }
        if let Some(mut old) = runtime.take() { let _ = old.child.kill(); }
    }
    Err("Agent 重启后仍未返回结果，请检查网络设置".to_string())
}

#[tauri::command]
async fn call_agent_rpc(app: tauri::AppHandle, state: State<'_, AgentRuntimeState>, method: String, params: serde_json::Value) -> Result<serde_json::Value, String> {
    let process = state.process.clone();
    tauri::async_runtime::spawn_blocking(move || call_agent_rpc_blocking(app, process, method, params))
        .await
        .map_err(|error| format!("Agent 任务线程退出：{error}"))?
}

#[tauri::command]
fn publish_fanqie(app: tauri::AppHandle, payload: Value) -> Result<Value, String> {
    // Keep browser/driver failures inside the command boundary. A panic from
    // a platform subprocess must never take down the Tauri process.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| publish_fanqie_inner(app, payload)))
        .map_err(|_| "番茄发布进程发生异常，应用仍在运行，请重试".to_string())?
}

fn publish_fanqie_inner(app: tauri::AppHandle, payload: Value) -> Result<Value, String> {
    let script = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fanqie_publish.py"),
        app.path().resource_dir().unwrap_or_else(|_| PathBuf::from(".")).join("fanqie_publish.py"),
    ].into_iter().find(|path| path.exists()).ok_or_else(|| "找不到番茄发布脚本".to_string())?;
    let input = serde_json::to_vec(&payload).map_err(|error| format!("序列化发布参数失败：{error}"))?;
    let mut last_error = String::new();
    for executable in ["python3", "python", "/opt/anaconda3/bin/python"] {
        let mut child = match Command::new(executable)
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => { last_error = error.to_string(); continue; }
        };
        if let Some(mut stdin) = child.stdin.take() {
            if let Err(error) = stdin.write_all(&input) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("发送发布参数失败：{error}"));
            }
        }
        let output = child.wait_with_output().map_err(|error| format!("等待番茄发布失败：{error}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = stdout.lines().rev().find(|line| !line.trim().is_empty()) {
            let parsed: Value = serde_json::from_str(line).map_err(|error| format!("解析番茄发布结果失败：{error}"))?;
            if parsed.get("status").and_then(Value::as_str) == Some("missing_runtime") {
                last_error = parsed.get("message").and_then(Value::as_str).unwrap_or("Python Playwright 不可用").to_string();
                continue;
            }
            return Ok(parsed);
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        last_error = if stderr.is_empty() { format!("{executable} 退出状态 {}", output.status) } else { stderr };
    }
    Err(format!("找不到可用 Python 运行时：{last_error}"))
}

fn agent_runtime_script() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = bundled_agent_resource("main.cjs") {
        candidates.push(path);
    }
    candidates.extend([
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/agent-runtime/dist/main.js"),
        PathBuf::from("../sidecars/agent-runtime/dist/main.js"),
        PathBuf::from("sidecars/agent-runtime/dist/main.js"),
    ]);
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            // macOS bundle: Contents/MacOS/<binary> -> Contents/Resources/agent-runtime/main.js
            candidates.push(directory.join("../Resources/agent-runtime/main.cjs"));
            candidates.push(directory.join("agent-runtime/main.cjs"));
        }
    }
    candidates
        .into_iter()
        .find(|path| Path::new(path).exists())
        .ok_or_else(|| "找不到 Agent runtime，请先构建 sidecars/agent-runtime".to_string())
}

fn bundled_agent_resource(name: &str) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    let candidates = [
        directory.join("../Resources/agent-runtime").join(name),
        directory.join("agent-runtime").join(name),
    ];
    candidates.into_iter().find(|path| path.exists())
}

fn app_data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法确定应用数据目录: {error}"))?;
    Ok(directory)
}

fn export_file_name(value: &str) -> String {
    let mut name = value
        .chars()
        .map(|character| if matches!(character, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { character })
        .collect::<String>();
    name = name.trim().trim_matches('.').to_string();
    if name.is_empty() { "未命名小说".to_string() } else { name.chars().take(120).collect() }
}

#[tauri::command]
fn export_chapters_txt(app: tauri::AppHandle, book_title: String, content: String) -> Result<String, String> {
    let directory = if cfg!(any(target_os = "ios", target_os = "android")) {
        app.path().document_dir().unwrap_or(app_data_directory(&app)?)
    } else {
        app.path().download_dir().unwrap_or(app_data_directory(&app)?)
    };
    fs::create_dir_all(&directory).map_err(|error| format!("创建导出目录失败: {error}"))?;
    let path = directory.join(format!("{}.txt", export_file_name(&book_title)));
    fs::write(&path, content.as_bytes()).map_err(|error| format!("写入 TXT 文件失败: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

fn bdpan_command() -> Result<Command, String> {
    let mut candidates = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(home).join(".local/bin/bdpan"));
    }
    candidates.push(PathBuf::from("bdpan"));
    for candidate in candidates {
        if candidate.as_os_str() == "bdpan" || candidate.exists() {
            return Ok(Command::new(candidate));
        }
    }
    Err("未找到 bdpan 命令。请先安装百度网盘 Skill 的 CLI 工具。".to_string())
}

fn validate_cloud_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().trim_matches('/');
    if trimmed.is_empty() || trimmed.contains("..") || trimmed.starts_with('~') || trimmed.starts_with('.') {
        return Err("云端路径无效，只能使用 /apps/bdpan/ 下的相对路径".to_string());
    }
    Ok(trimmed.to_string())
}

fn validate_cloud_backup_path(remote_path: &str, backup_path: &str) -> Result<String, String> {
    let base = validate_cloud_path(remote_path)?;
    let normalized = backup_path.trim().replace('\\', "/").trim_matches('/').to_string();
    let relative = normalized.strip_prefix("apps/bdpan/").unwrap_or(&normalized);
    let prefix = format!("{base}/");
    let file_name = relative.strip_prefix(&prefix).ok_or_else(|| "所选备份文件不在当前云端备份目录中".to_string())?;
    if file_name.is_empty() || file_name.contains('/') || file_name.contains("..") || !file_name.to_ascii_lowercase().ends_with(".aswbackup") {
        return Err("所选云端文件不是有效的 ApiSaverWriter 备份包".to_string());
    }
    validate_cloud_path(relative)
}

fn run_bdpan(args: &[&str]) -> Result<String, String> {
    run_bdpan_at(args, None)
}

fn run_bdpan_at(args: &[&str], working_directory: Option<&Path>) -> Result<String, String> {
    let mut command = bdpan_command()?;
    if let Some(directory) = working_directory {
        command.current_dir(directory);
    }
    let output = command
        .args(args)
        .output()
        .map_err(|error| format!("启动百度网盘工具失败: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { format!("bdpan 退出码 {}", output.status) });
    }
    Ok(if !stdout.is_empty() { stdout } else { stderr })
}

fn copy_directory_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建恢复目录失败: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("读取云端恢复目录失败: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_directory_contents(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|error| format!("恢复文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn copy_cloud_backup_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建备份目录失败: {error}"))?;
    let entries = fs::read_dir(source).map_err(|error| format!("读取待备份目录失败: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let file_name = entry.file_name();
        if file_name.to_string_lossy().starts_with('.') {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| format!("读取备份文件类型失败: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let source_path = entry.path();
        let target_path = target.join(file_name);
        if file_type.is_dir() {
            copy_cloud_backup_contents(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| format!("备份文件失败: {error}"))?;
        }
    }
    Ok(())
}

const CLOUD_BACKUP_DIRECTORIES: [&str; 5] = ["projects", "books", "dismantles", "rankings", "styles"];
const CLOUD_BACKUP_BUNDLE_NAME: &str = "ApiSaverWriter-backup.aswbackup";
const CLOUD_BACKUP_MAGIC: &[u8] = b"ASWBACKUP\x01";

fn cloud_export_directory(app_data: &Path) -> PathBuf {
    app_data.join("cloud-export")
}

fn create_cloud_export(app_data: &Path, client_state: &Value) -> Result<PathBuf, String> {
    let export_root = cloud_export_directory(app_data);
    if export_root.exists() {
        fs::remove_dir_all(&export_root).map_err(|error| format!("清理旧备份缓存失败: {error}"))?;
    }
    fs::create_dir_all(&export_root).map_err(|error| format!("创建备份缓存失败: {error}"))?;
    for directory in CLOUD_BACKUP_DIRECTORIES {
        let source = app_data.join(directory);
        if source.exists() {
            copy_cloud_backup_contents(&source, &export_root.join(directory))?;
        }
    }
    let legacy_projects = app_data.join("projects.json");
    if legacy_projects.exists() {
        fs::copy(&legacy_projects, export_root.join("projects.json")).map_err(|error| format!("备份旧项目数据失败: {error}"))?;
    }
    let state = serde_json::to_vec_pretty(client_state).map_err(|error| format!("序列化本地设置失败: {error}"))?;
    fs::write(export_root.join("client-state.json"), state).map_err(|error| format!("写入本地设置备份失败: {error}"))?;
    Ok(export_root)
}

fn collect_cloud_backup_files(root: &Path, current: &Path, files: &mut Vec<(PathBuf, PathBuf)>) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|error| format!("读取备份包目录失败: {error}"))?;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| format!("读取备份包文件类型失败: {error}"))?;
        if file_type.is_dir() {
            collect_cloud_backup_files(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).map_err(|error| format!("计算备份相对路径失败: {error}"))?.to_path_buf();
            files.push((relative, path));
        }
    }
    Ok(())
}

fn write_cloud_backup_bundle(export_root: &Path, bundle_path: &Path) -> Result<u64, String> {
    let mut files = Vec::new();
    collect_cloud_backup_files(export_root, export_root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));

    let bundle_file = fs::File::create(bundle_path).map_err(|error| format!("创建完整备份包失败: {error}"))?;
    let mut bundle = GzEncoder::new(bundle_file, Compression::best());
    bundle.write_all(CLOUD_BACKUP_MAGIC).map_err(|error| format!("写入备份包标识失败: {error}"))?;
    bundle.write_all(&(files.len() as u64).to_le_bytes()).map_err(|error| format!("写入备份包索引失败: {error}"))?;

    for (relative, source) in files {
        let relative = relative.to_string_lossy().replace('\\', "/");
        let path_bytes = relative.as_bytes();
        let path_length = u32::try_from(path_bytes.len()).map_err(|_| "备份文件路径过长".to_string())?;
        let file_size = fs::metadata(&source).map_err(|error| format!("读取备份文件大小失败: {error}"))?.len();
        bundle.write_all(&path_length.to_le_bytes()).map_err(|error| format!("写入备份路径失败: {error}"))?;
        bundle.write_all(&file_size.to_le_bytes()).map_err(|error| format!("写入备份文件索引失败: {error}"))?;
        bundle.write_all(path_bytes).map_err(|error| format!("写入备份路径内容失败: {error}"))?;
        let mut input = fs::File::open(&source).map_err(|error| format!("打开备份文件失败: {error}"))?;
        std::io::copy(&mut input, &mut bundle).map_err(|error| format!("写入备份文件内容失败: {error}"))?;
    }
    bundle.flush().map_err(|error| format!("保存完整备份包失败: {error}"))?;
    let bundle_file = bundle.finish().map_err(|error| format!("完成备份包压缩失败: {error}"))?;
    bundle_file.sync_all().map_err(|error| format!("保存压缩备份包失败: {error}"))?;
    fs::metadata(bundle_path).map(|metadata| metadata.len()).map_err(|error| format!("读取完整备份包失败: {error}"))
}

fn read_bundle_number<const N: usize>(bundle: &mut dyn Read, label: &str) -> Result<[u8; N], String> {
    let mut bytes = [0_u8; N];
    bundle.read_exact(&mut bytes).map_err(|error| format!("读取备份包{label}失败: {error}"))?;
    Ok(bytes)
}

fn safe_bundle_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty() || path.is_absolute() || path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("备份包包含不安全路径: {value}"));
    }
    Ok(path.to_path_buf())
}

fn extract_cloud_backup_bundle(bundle_path: &Path, export_root: &Path) -> Result<u64, String> {
    if export_root.exists() {
        fs::remove_dir_all(export_root).map_err(|error| format!("清理恢复解包目录失败: {error}"))?;
    }
    fs::create_dir_all(export_root).map_err(|error| format!("创建恢复解包目录失败: {error}"))?;
    let mut preview = fs::File::open(bundle_path).map_err(|error| format!("打开云端备份包失败: {error}"))?;
    let mut signature = [0_u8; 2];
    preview.read_exact(&mut signature).map_err(|error| format!("读取云端备份包格式失败: {error}"))?;
    let input = fs::File::open(bundle_path).map_err(|error| format!("重新打开云端备份包失败: {error}"))?;
    let mut bundle: Box<dyn Read> = if signature == [0x1f, 0x8b] {
        Box::new(GzDecoder::new(input))
    } else {
        Box::new(input)
    };
    let mut magic = vec![0_u8; CLOUD_BACKUP_MAGIC.len()];
    bundle.read_exact(&mut magic).map_err(|error| format!("读取云端备份包标识失败: {error}"))?;
    if magic != CLOUD_BACKUP_MAGIC {
        return Err("云端文件不是有效的 ApiSaverWriter 完整备份包".to_string());
    }
    let file_count = u64::from_le_bytes(read_bundle_number::<8>(&mut *bundle, "文件数量")?);
    if file_count > 1_000_000 {
        return Err("云端备份包文件数量异常".to_string());
    }

    for _ in 0..file_count {
        let path_length = u32::from_le_bytes(read_bundle_number::<4>(&mut *bundle, "路径长度")?) as usize;
        let file_size = u64::from_le_bytes(read_bundle_number::<8>(&mut *bundle, "文件大小")?);
        if path_length == 0 || path_length > 1_048_576 {
            return Err("云端备份包路径长度异常".to_string());
        }
        let mut path_bytes = vec![0_u8; path_length];
        bundle.read_exact(&mut path_bytes).map_err(|error| format!("读取备份文件路径失败: {error}"))?;
        let relative_text = String::from_utf8(path_bytes).map_err(|error| format!("备份文件路径编码错误: {error}"))?;
        let relative = safe_bundle_relative_path(&relative_text)?;
        let destination = export_root.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("创建恢复文件目录失败: {error}"))?;
        }
        let mut output = fs::File::create(&destination).map_err(|error| format!("创建恢复文件失败: {error}"))?;
        let copied = std::io::copy(&mut (&mut *bundle).take(file_size), &mut output).map_err(|error| format!("解包恢复文件失败: {error}"))?;
        if copied != file_size {
            return Err(format!("云端备份包内容不完整: {relative_text}"));
        }
    }
    Ok(file_count)
}

fn find_cloud_export(root: &Path, depth: usize) -> Option<PathBuf> {
    if root.join("client-state.json").exists() {
        return Some(root.to_path_buf());
    }
    if depth == 0 { return None; }
    fs::read_dir(root).ok()?.filter_map(Result::ok).find_map(|entry| {
        let path = entry.path();
        path.is_dir().then(|| find_cloud_export(&path, depth - 1)).flatten()
    })
}

fn replace_cloud_data(app_data: &Path, export_root: &Path) -> Result<(), String> {
    for directory in CLOUD_BACKUP_DIRECTORIES {
        let source = export_root.join(directory);
        let target = app_data.join(directory);
        if target.exists() {
            fs::remove_dir_all(&target).map_err(|error| format!("清理本地 {directory} 数据失败: {error}"))?;
        }
        if source.exists() {
            copy_directory_contents(&source, &target)?;
        }
    }
    let source_legacy = export_root.join("projects.json");
    let target_legacy = app_data.join("projects.json");
    if source_legacy.exists() {
        fs::copy(source_legacy, target_legacy).map_err(|error| format!("恢复旧项目数据失败: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn cloud_sync_status() -> Result<Value, String> {
    let output = run_bdpan(&["whoami", "--json"])?;
    let parsed = serde_json::from_str::<Value>(&output).unwrap_or_else(|_| serde_json::json!({ "raw": output }));
    Ok(parsed)
}

#[tauri::command]
fn baidu_login_url() -> Result<String, String> {
    run_bdpan(&["login", "--get-auth-url", "--accept-disclaimer"])
}

#[tauri::command]
fn complete_baidu_login(code: String) -> Result<Value, String> {
    let code = code.trim();
    if code.len() != 32 || !code.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("授权码格式无效，请粘贴百度网盘页面返回的 32 位授权码".to_string());
    }
    let mut command = bdpan_command()?;
    let mut child = command
        .args(["login", "--set-code-stdin", "--accept-disclaimer"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动百度网盘登录失败: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(format!("{code}\n").as_bytes()).map_err(|error| format!("提交授权码失败: {error}"))?;
    }
    let output = child.wait_with_output().map_err(|error| format!("等待登录结果失败: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(if stderr.trim().is_empty() { "百度网盘授权失败，请重新获取授权链接后再试。".to_string() } else { stderr.trim().to_string() });
    }
    let status = cloud_sync_status()?;
    Ok(status)
}

#[tauri::command]
async fn backup_projects_to_baidu(app: tauri::AppHandle, remote_path: String, client_state: Value) -> Result<Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || backup_projects_to_baidu_blocking(handle, remote_path, client_state))
        .await
        .map_err(|error| format!("云端备份任务中断: {error}"))?
}

fn backup_projects_to_baidu_blocking(app: tauri::AppHandle, remote_path: String, client_state: Value) -> Result<Value, String> {
    let remote_path = validate_cloud_path(&remote_path)?;
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "backup", "stage": "prepare", "message": "正在整理小说、书籍、拆书、扫榜与本机设置..." }));
    let app_data = app_data_directory(&app)?;
    let export_root = create_cloud_export(&app_data, &client_state)?;
    let bundle_path = app_data.join(CLOUD_BACKUP_BUNDLE_NAME);
    if bundle_path.exists() {
        fs::remove_file(&bundle_path).map_err(|error| format!("清理旧完整备份包失败: {error}"))?;
    }
    let bundle_size = write_cloud_backup_bundle(&export_root, &bundle_path)?;
    let remote_target = format!("{remote_path}/{CLOUD_BACKUP_BUNDLE_NAME}");
    let _ = run_bdpan(&["mkdir", &remote_path]);
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "backup", "stage": "upload", "message": format!("完整备份包已生成（{:.1} MB），正在后台上传到百度网盘...", bundle_size as f64 / 1_048_576.0) }));
    let output = run_bdpan_at(&["upload", CLOUD_BACKUP_BUNDLE_NAME, &remote_target], Some(&app_data))?;
    fs::remove_dir_all(&export_root).ok();
    fs::remove_file(&bundle_path).ok();
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "backup", "stage": "done", "message": "完整备份已上传到百度网盘。" }));
    Ok(serde_json::json!({ "remotePath": remote_path, "remoteFile": remote_target, "message": output, "size": bundle_size, "scope": "projects, books, dismantles, rankings, styles, client-state" }))
}

#[tauri::command]
fn list_baidu_backups(remote_path: String) -> Result<Value, String> {
    let remote_path = validate_cloud_path(&remote_path)?;
    let output = run_bdpan(&["ls", &remote_path, "--json", "--order", "time", "--desc", "--limit", "1000"])?;
    let parsed: Value = serde_json::from_str(&output).map_err(|error| format!("百度网盘备份列表格式错误: {error}"))?;
    let entries = parsed.as_array().cloned().or_else(|| parsed.get("list").and_then(Value::as_array).cloned()).unwrap_or_default();
    let prefix = format!("/apps/bdpan/{remote_path}/");
    let files = entries.into_iter().filter_map(|entry| {
        if entry.get("isdir").and_then(Value::as_bool).unwrap_or(false) || entry.get("isdir").and_then(Value::as_i64).unwrap_or(0) != 0 {
            return None;
        }
        let path = entry.get("path").and_then(Value::as_str).unwrap_or_default();
        let name = entry.get("server_filename").and_then(Value::as_str)
            .or_else(|| entry.get("name").and_then(Value::as_str))
            .or_else(|| path.rsplit('/').next())
            .unwrap_or_default();
        if !path.starts_with(&prefix) || path[prefix.len()..].contains('/') || !name.to_ascii_lowercase().ends_with(".aswbackup") {
            return None;
        }
        let relative_path = format!("{remote_path}/{name}");
        Some(serde_json::json!({
            "name": name,
            "path": relative_path,
            "fsId": entry.get("fs_id").map(|value| value.to_string().trim_matches('"').to_string()),
            "size": entry.get("size").and_then(Value::as_u64).unwrap_or(0),
            "modifiedAt": entry.get("server_mtime").and_then(Value::as_str).or_else(|| entry.get("server_ctime").and_then(Value::as_str)).unwrap_or_default(),
            "isBundle": true,
            "source": "bundle"
        }))
    }).collect::<Vec<_>>();
    Ok(serde_json::json!({ "files": files }))
}

#[tauri::command]
async fn restore_projects_from_baidu(app: tauri::AppHandle, remote_path: String, backup_path: Option<String>, backup_fs_id: Option<String>) -> Result<Value, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || restore_projects_from_baidu_blocking(handle, remote_path, backup_path, backup_fs_id))
        .await
        .map_err(|error| format!("云端恢复任务中断: {error}"))?
}

fn restore_projects_from_baidu_blocking(app: tauri::AppHandle, remote_path: String, backup_path: Option<String>, _backup_fs_id: Option<String>) -> Result<Value, String> {
    let remote_path = validate_cloud_path(&remote_path)?;
    let app_data = app_data_directory(&app)?;
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "restore", "stage": "download", "message": "正在后台下载完整应用备份..." }));
    let restore_root = app_data.join(".cloud-restore");
    if restore_root.exists() {
        fs::remove_dir_all(&restore_root).map_err(|error| format!("清理上次恢复缓存失败: {error}"))?;
    }
    fs::create_dir_all(&restore_root).map_err(|error| format!("创建恢复缓存失败: {error}"))?;
    let selected_bundle = backup_path.as_deref().map(|path| validate_cloud_backup_path(&remote_path, path)).transpose()?;
    if backup_path.is_some() && selected_bundle.is_none() {
        return Err("请先选择要恢复的云端备份文件".to_string());
    }
    let remote_bundle = selected_bundle.clone().unwrap_or_else(|| format!("{remote_path}/{CLOUD_BACKUP_BUNDLE_NAME}"));
    let local_bundle = restore_root.join(CLOUD_BACKUP_BUNDLE_NAME);
    let local_bundle_text = format!(".cloud-restore/{CLOUD_BACKUP_BUNDLE_NAME}");
    let (output, export_root) = match run_bdpan_at(&["download", &remote_bundle, &local_bundle_text], Some(&app_data)) {
        Ok(output) => {
            let export_root = restore_root.join("cloud-export");
            extract_cloud_backup_bundle(&local_bundle, &export_root)?;
            (output, export_root)
        }
        Err(bundle_error) if backup_path.is_none() => {
            let output = run_bdpan_at(&["download", &remote_path, "cloud-restore"], Some(&app_data))
                .map_err(|legacy_error| format!("下载完整备份包失败: {bundle_error}\n兼容旧版目录备份也失败: {legacy_error}"))?;
            let export_root = find_cloud_export(&restore_root, 4)
                .ok_or_else(|| "云端下载完成，但没有找到完整应用备份。请确认云端目录包含有效备份。".to_string())?;
            (output, export_root)
        }
        Err(bundle_error) => return Err(format!("下载所选备份包失败: {bundle_error}")),
    };
    let client_state: Value = serde_json::from_str(&fs::read_to_string(export_root.join("client-state.json")).map_err(|error| format!("读取云端设置失败: {error}"))?)
        .map_err(|error| format!("云端设置格式错误: {error}"))?;
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "restore", "stage": "apply", "message": "下载完成，正在恢复小说与本机配置..." }));
    replace_cloud_data(&app_data, &export_root)?;
    fs::remove_dir_all(&restore_root).ok();
    let _ = app.emit("cloud-sync-progress", serde_json::json!({ "action": "restore", "stage": "done", "message": "完整应用数据已恢复，正在重新载入。" }));
    Ok(serde_json::json!({ "remotePath": remote_path, "backupPath": remote_bundle, "message": output, "reloaded": true, "clientState": client_state }))
}

#[tauri::command]
fn load_projects(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let app_data = app_data_directory(&app)?;
    let root = app_data.join("projects");

    if root.exists() {
        let mut projects = Vec::new();
        let mut entries: Vec<_> = fs::read_dir(&root)
            .map_err(|error| format!("读取小说目录失败: {error}"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .collect();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let project_dir = entry.path();
            let metadata_path = project_dir.join("metadata.json");
            if !metadata_path.exists() {
                continue;
            }
            let metadata_content = fs::read_to_string(&metadata_path)
                .map_err(|error| format!("读取小说元数据失败: {error}"))?;
            let mut project: Value = serde_json::from_str(&metadata_content)
                .map_err(|error| format!("小说元数据格式错误: {error}"))?;

            if let Some(chapters) = project.get_mut("chapters").and_then(Value::as_array_mut) {
                for chapter in chapters {
                    let chapter_title = chapter
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名章节");
                    let chapter_path = project_dir
                        .join("章节")
                        .join(format!("{}.md", safe_file_name(chapter_title)));
                    let legacy_chapter_id = chapter.get("id").and_then(Value::as_i64).unwrap_or(0);
                    let legacy_path = project_dir
                        .join("novel")
                        .join("chapters")
                        .join(format!("chapter-{legacy_chapter_id}.md"));
                    let source_path = if chapter_path.exists() {
                        chapter_path
                    } else {
                        legacy_path
                    };
                    if source_path.exists() {
                        let content = fs::read_to_string(source_path)
                            .map_err(|error| format!("读取章节 Markdown 失败: {error}"))?;
                        chapter["content"] = Value::String(content);
                    }
                }
            }

            if let Some(outlines) = project.get_mut("outlines").and_then(Value::as_array_mut) {
                for outline in outlines {
                    let title = outline
                        .get("title")
                        .and_then(Value::as_str)
                        .or_else(|| outline.get("kind").and_then(Value::as_str))
                        .unwrap_or("大纲");
                    let path = project_dir
                        .join("大纲")
                        .join(format!("{}.md", safe_file_name(title)));
                    if path.exists() {
                        if let Ok(content) = fs::read_to_string(path) {
                            outline["content"] = Value::String(content);
                        }
                    }
                }
            }
            if let Some(cards) = project.get_mut("cards").and_then(Value::as_array_mut) {
                for card in cards {
                    let card_type = card.get("type").and_then(Value::as_str).unwrap_or("角色卡");
                    let title = card
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("未命名卡片");
                    let path = project_dir
                        .join("卡片")
                        .join(card_type)
                        .join(format!("{}.md", safe_file_name(title)));
                    if path.exists() {
                        if let Ok(content) = fs::read_to_string(path) {
                            let (body, state_section) = content.split_once("\n## 当前状态\n").map(|(body, state)| (body, Some(state))).unwrap_or((content.as_str(), None));
                            card["content"] = Value::String(body.to_string());
                            if card.get("currentState").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
                                if let Some(state) = state_section {
                                    let state = state.split("\n## 状态历史\n").next().unwrap_or(state).trim();
                                    if !state.is_empty() && state != "暂无" { card["currentState"] = Value::String(state.to_string()); }
                                }
                            }
                        }
                    }
                }
            }
            // Chapter snapshots stay structured in metadata; aggregated documents are user-editable
            // Markdown, so read their file contents back into the project on every launch.
            if let Some(documents) = project.get_mut("memoryDocuments").and_then(Value::as_array_mut) {
                for document in documents {
                    let title = document
                        .get("title")
                        .or_else(|| document.get("kind"))
                        .and_then(Value::as_str)
                        .unwrap_or("章节快照");
                    let path = project_dir
                        .join("记忆")
                        .join(format!("{}.md", safe_file_name(title)));
                    if let Ok(content) = fs::read_to_string(path) {
                        document["content"] = Value::String(content);
                    }
                }
            }
            // 图谱节点的详细档案以 Markdown 作为事实来源；metadata 仅保留索引字段。
            if let Some(nodes) = project.get_mut("graphNodes").and_then(Value::as_array_mut) {
                for node in nodes {
                    let relative_path = node.get("sourcePath").and_then(Value::as_str)
                        .map(PathBuf::from)
                        .unwrap_or_else(|| graph_node_relative_path(node));
                    let path = project_dir.join(&relative_path);
                    if let Ok(content) = fs::read_to_string(&path) {
                        node["content"] = Value::String(graph_node_profile_from_markdown(&content));
                    }
                    node["sourcePath"] = Value::String(relative_path.to_string_lossy().into_owned());
                }
            }
            projects.push(project);
        }

        if !projects.is_empty() {
            return Ok(Some(Value::Array(projects)));
        }
    }

    // 兼容上一版单文件存储，下一次保存时会自动拆分为目录结构。
    let legacy_path = app_data.join("projects.json");
    if legacy_path.exists() {
        let content = fs::read_to_string(&legacy_path)
            .map_err(|error| format!("读取旧版小说文件失败: {error}"))?;
        let projects = serde_json::from_str(&content)
            .map_err(|error| format!("旧版小说文件格式错误: {error}"))?;
        return Ok(Some(projects));
    }

    Ok(None)
}

#[tauri::command]
fn save_projects(app: tauri::AppHandle, projects: Value) -> Result<String, String> {
    let save_lock = PROJECT_SAVE_LOCK.get_or_init(|| Mutex::new(()));
    let _save_guard = save_lock.lock().map_err(|_| "小说数据保存锁定失败".to_string())?;
    let app_data = app_data_directory(&app)?;
    let root = app_data.join("projects");
    fs::create_dir_all(&root).map_err(|error| format!("创建小说目录失败: {error}"))?;
    let project_array = projects
        .as_array()
        .ok_or_else(|| "小说数据必须是数组".to_string())?;

    let mut current_directories = Vec::new();
    let mut used_directory_names = HashSet::new();
    for project in project_array {
        let id = project.get("id").and_then(Value::as_i64).unwrap_or(0);
        let title = project
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("未命名小说");
        let base = safe_folder_name(title);
        let mut directory_name = base.clone();
        if !used_directory_names.insert(directory_name.clone()) {
            directory_name = format!("{base}-{id}");
            used_directory_names.insert(directory_name.clone());
        }
        current_directories.push(directory_name);
    }

    // 删除已在应用中删除的小说目录，避免留下用户误以为仍存在的旧项目。
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !current_directories.contains(&name) {
                fs::remove_dir_all(entry.path())
                    .map_err(|error| format!("清理旧小说目录失败: {error}"))?;
            }
        }
    }

    for (index, project) in project_array.iter().enumerate() {
        project
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "小说缺少有效 ID".to_string())?;
        let project_dir = root.join(&current_directories[index]);
        let chapters_dir = project_dir.join("章节");
        let outline_dir = project_dir.join("大纲");
        let cards_dir = project_dir.join("卡片");
        let memories_dir = project_dir.join("记忆");
        let graph_dir = project_dir.join("图谱");
        fs::create_dir_all(&chapters_dir).map_err(|error| format!("创建章节目录失败: {error}"))?;
        fs::create_dir_all(&outline_dir).map_err(|error| format!("创建大纲目录失败: {error}"))?;
        fs::create_dir_all(&cards_dir).map_err(|error| format!("创建卡片目录失败: {error}"))?;
        fs::create_dir_all(&memories_dir).map_err(|error| format!("创建记忆目录失败: {error}"))?;
        fs::create_dir_all(&graph_dir).map_err(|error| format!("创建图谱目录失败: {error}"))?;
        if let Ok(entries) = fs::read_dir(&chapters_dir) {
            for entry in entries.filter_map(Result::ok).filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("md")
            }) {
                fs::remove_file(entry.path())
                    .map_err(|error| format!("清理旧章节 Markdown 失败: {error}"))?;
            }
        }
        if let Ok(entries) = fs::read_dir(&outline_dir) {
            for entry in entries.filter_map(Result::ok).filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("md")
            }) {
                fs::remove_file(entry.path())
                    .map_err(|error| format!("清理旧大纲 Markdown 失败: {error}"))?;
            }
        }
        if let Ok(entries) = fs::read_dir(&cards_dir) {
            for entry in entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
            {
                if let Ok(files) = fs::read_dir(entry.path()) {
                    for file in files.filter_map(Result::ok).filter(|file| {
                        file.path().extension().and_then(|value| value.to_str()) == Some("md")
                    }) {
                        fs::remove_file(file.path())
                            .map_err(|error| format!("清理旧卡片 Markdown 失败: {error}"))?;
                    }
                }
            }
        }

        let mut metadata = project.clone();
        if let Some(chapters) = metadata.get_mut("chapters").and_then(Value::as_array_mut) {
            for chapter in chapters.iter_mut() {
                let content = chapter.get("content").and_then(Value::as_str).unwrap_or("");
                let chapter_title = chapter
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("未命名章节");
                fs::write(
                    chapters_dir.join(format!("{}.md", safe_file_name(chapter_title))),
                    content,
                )
                .map_err(|error| format!("保存章节 Markdown 失败: {error}"))?;
                chapter["content"] = Value::String(String::new());
            }
        }

        if let Some(outlines) = metadata.get_mut("outlines").and_then(Value::as_array_mut) {
            for outline in outlines.iter_mut() {
                let title = outline
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("大纲");
                let content = outline.get("content").and_then(Value::as_str).unwrap_or("");
                fs::write(
                    outline_dir.join(format!("{}.md", safe_file_name(title))),
                    content,
                )
                .map_err(|error| format!("保存大纲 Markdown 失败: {error}"))?;
                outline["content"] = Value::String(String::new());
            }
        }
        // 兼容旧版本的树形大纲，同时让目录中始终存在可打开的大纲文件。
        if metadata
            .get("outlines")
            .and_then(Value::as_array)
            .map(|items| items.is_empty())
            .unwrap_or(true)
        {
            let outline_markdown = outline_to_markdown(project.get("outline"));
            fs::write(outline_dir.join("大纲.md"), outline_markdown)
                .map_err(|error| format!("保存大纲 Markdown 失败: {error}"))?;
        }

        if let Some(cards) = metadata.get_mut("cards").and_then(Value::as_array_mut) {
            for card in cards.iter_mut() {
                let card_type = card.get("type").and_then(Value::as_str).unwrap_or("角色卡");
                let title = card
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("未命名卡片");
                let content = card.get("content").and_then(Value::as_str).unwrap_or("");
                let current_state = card.get("currentState").and_then(Value::as_str).unwrap_or("");
                let state_history = card.get("stateHistory").and_then(Value::as_array).map(|items| {
                    items.iter().rev().take(5).filter_map(|item| {
                        let chapter_title = item.get("chapterTitle").and_then(Value::as_str).unwrap_or("全文检索");
                        let changes = item.get("changes").and_then(Value::as_str).unwrap_or("");
                        if changes.trim().is_empty() { None } else { Some(format!("- {chapter_title}：{changes}")) }
                    }).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
                }).unwrap_or_default();
                let type_dir = cards_dir.join(card_type);
                fs::create_dir_all(&type_dir)
                    .map_err(|error| format!("创建卡片分类目录失败: {error}"))?;
                fs::write(
                    type_dir.join(format!("{}.md", safe_file_name(title))),
                    format!("{content}\n\n## 当前状态\n{}\n\n## 状态历史\n{}\n", if current_state.trim().is_empty() { "暂无" } else { current_state }, if state_history.trim().is_empty() { "- 暂无" } else { &state_history }),
                )
                .map_err(|error| format!("保存卡片 Markdown 失败: {error}"))?;
                card["content"] = Value::String(String::new());
            }
        }
        if let Some(memories) = metadata.get_mut("memories").and_then(Value::as_array_mut) {
            for memory in memories.iter_mut() {
                let title = memory
                    .get("chapterTitle")
                    .and_then(Value::as_str)
                    .unwrap_or("章节记忆");
                let content = chapter_memory_to_markdown(memory);
                fs::write(
                    memories_dir.join(format!("{}.md", safe_file_name(title))),
                    content,
                )
                .map_err(|error| format!("保存章节记忆 Markdown 失败: {error}"))?;
            }
        }
        if let Some(documents) = metadata.get_mut("memoryDocuments").and_then(Value::as_array_mut) {
            for document in documents.iter_mut() {
                let title = document
                    .get("title")
                    .or_else(|| document.get("kind"))
                    .and_then(Value::as_str)
                    .unwrap_or("章节快照");
                let content = document.get("content").and_then(Value::as_str).unwrap_or("");
                fs::write(
                    memories_dir.join(format!("{}.md", safe_file_name(title))),
                    content,
                )
                .map_err(|error| format!("保存聚合记忆 Markdown 失败: {error}"))?;
            }
        }
        let graph_edges = project.get("graphEdges").and_then(Value::as_array).cloned().unwrap_or_default();
        let graph_node_snapshots = project.get("graphNodes").and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(nodes) = metadata.get_mut("graphNodes").and_then(Value::as_array_mut) {
            for node in nodes.iter_mut() {
                let relative_path = graph_node_relative_path(node);
                let path = project_dir.join(&relative_path);
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(|error| format!("创建图谱档案目录失败: {error}"))?;
                }
                fs::write(&path, graph_node_to_markdown(node, &graph_node_snapshots, &graph_edges))
                    .map_err(|error| format!("保存图谱档案 Markdown 失败: {error}"))?;
                node["sourcePath"] = Value::String(relative_path.to_string_lossy().into_owned());
                node["content"] = Value::String(String::new());
            }
        }

        let metadata_content = serde_json::to_vec_pretty(&metadata)
            .map_err(|error| format!("序列化小说元数据失败: {error}"))?;
        fs::write(project_dir.join("metadata.json"), metadata_content)
            .map_err(|error| format!("保存小说元数据失败: {error}"))?;
    }

    let legacy_path = app_data.join("projects.json");
    if legacy_path.exists() {
        let _ = fs::remove_file(legacy_path);
    }
    Ok(root.to_string_lossy().into_owned())
}

fn dismantle_chapter_stem(chapter: &Value, index: usize) -> String {
    let number = chapter.get("number").and_then(Value::as_u64).unwrap_or((index + 1) as u64);
    let title = chapter.get("title").and_then(Value::as_str).unwrap_or("未命名章节");
    format!("{number:03}-{}", safe_file_name(title))
}

#[tauri::command]
fn load_dismantle_books(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let root = app_data_directory(&app)?.join("dismantles");
    if !root.exists() {
        return Ok(None);
    }
    let mut books = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&root)
        .map_err(|error| format!("读取拆书目录失败: {error}"))?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let directory = entry.path();
        let metadata_path = directory.join("metadata.json");
        if !metadata_path.exists() {
            continue;
        }
        let content = fs::read_to_string(&metadata_path)
            .map_err(|error| format!("读取拆书元数据失败: {error}"))?;
        let mut book: Value = serde_json::from_str(&content)
            .map_err(|error| format!("拆书元数据格式错误: {error}"))?;
        if let Some(chapters) = book.get_mut("chapters").and_then(Value::as_array_mut) {
            for (index, chapter) in chapters.iter_mut().enumerate() {
                let stem = dismantle_chapter_stem(chapter, index);
                let source_path = chapter.get("sourcePath").and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("原文").join(format!("{stem}.txt")));
                let outline_path = chapter.get("outlinePath").and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("章纲").join(format!("{stem}.md")));
                let rewrite_path = chapter.get("rewritePath").and_then(Value::as_str)
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("原创改写").join(format!("{stem}.md")));
                if let Ok(source) = fs::read_to_string(directory.join(&source_path)) {
                    chapter["sourceContent"] = Value::String(source);
                }
                if let Ok(outline) = fs::read_to_string(directory.join(&outline_path)) {
                    chapter["detailedOutline"] = Value::String(outline);
                }
                if let Ok(rewrite) = fs::read_to_string(directory.join(&rewrite_path)) {
                    chapter["rewriteContent"] = Value::String(rewrite);
                }
                chapter["sourcePath"] = Value::String(source_path.to_string_lossy().into_owned());
                chapter["outlinePath"] = Value::String(outline_path.to_string_lossy().into_owned());
                chapter["rewritePath"] = Value::String(rewrite_path.to_string_lossy().into_owned());
            }
        }
        books.push(book);
    }
    Ok(Some(Value::Array(books)))
}

#[tauri::command]
fn save_dismantle_books(app: tauri::AppHandle, books: Value) -> Result<String, String> {
    let root = app_data_directory(&app)?.join("dismantles");
    fs::create_dir_all(&root).map_err(|error| format!("创建拆书目录失败: {error}"))?;
    let books = books.as_array().ok_or_else(|| "拆书数据必须是数组".to_string())?;
    let mut used_directory_names = HashSet::new();
    let mut current_directory_names = HashSet::new();

    for book in books {
        let id = book.get("id").and_then(Value::as_str).unwrap_or("book");
        let title = book.get("title").and_then(Value::as_str).unwrap_or("未命名拆书");
        let mut name = safe_folder_name(title);
        if !used_directory_names.insert(name.clone()) {
            name = format!("{name}-{id}");
            used_directory_names.insert(name.clone());
        }
        current_directory_names.insert(name.clone());
        let directory = root.join(name);
        let source_dir = directory.join("原文");
        let outline_dir = directory.join("章纲");
        let rewrite_dir = directory.join("原创改写");
        fs::create_dir_all(&source_dir).map_err(|error| format!("创建拆书原文目录失败: {error}"))?;
        fs::create_dir_all(&outline_dir).map_err(|error| format!("创建拆书章纲目录失败: {error}"))?;
        fs::create_dir_all(&rewrite_dir).map_err(|error| format!("创建原创改写目录失败: {error}"))?;

        let mut metadata = book.clone();
        if let Some(chapters) = metadata.get_mut("chapters").and_then(Value::as_array_mut) {
            for (index, chapter) in chapters.iter_mut().enumerate() {
                let stem = dismantle_chapter_stem(chapter, index);
                let source = chapter.get("sourceContent").and_then(Value::as_str).unwrap_or("");
                let outline = chapter.get("detailedOutline").and_then(Value::as_str).unwrap_or("");
                let rewrite = chapter.get("rewriteContent").and_then(Value::as_str).unwrap_or("");
                let source_path = PathBuf::from("原文").join(format!("{stem}.txt"));
                let outline_path = PathBuf::from("章纲").join(format!("{stem}.md"));
                let rewrite_path = PathBuf::from("原创改写").join(format!("{stem}.md"));
                fs::write(directory.join(&source_path), source)
                    .map_err(|error| format!("保存拆书原文失败: {error}"))?;
                if !outline.trim().is_empty() {
                    fs::write(directory.join(&outline_path), outline)
                        .map_err(|error| format!("保存拆书章纲失败: {error}"))?;
                }
                if !rewrite.trim().is_empty() {
                    fs::write(directory.join(&rewrite_path), rewrite)
                        .map_err(|error| format!("保存原创改写稿失败: {error}"))?;
                }
                chapter["sourcePath"] = Value::String(source_path.to_string_lossy().into_owned());
                chapter["outlinePath"] = Value::String(outline_path.to_string_lossy().into_owned());
                chapter["rewritePath"] = Value::String(rewrite_path.to_string_lossy().into_owned());
                chapter["sourceContent"] = Value::String(String::new());
                chapter["detailedOutline"] = Value::String(String::new());
                chapter["rewriteContent"] = Value::String(String::new());
            }
        }
        fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec_pretty(&metadata).map_err(|error| format!("序列化拆书元数据失败: {error}"))?,
        ).map_err(|error| format!("保存拆书元数据失败: {error}"))?;
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !current_directory_names.contains(&name) {
                fs::remove_dir_all(entry.path()).map_err(|error| format!("清理已删除拆书失败: {error}"))?;
            }
        }
    }
    Ok(root.to_string_lossy().into_owned())
}

fn library_chapter_stem(chapter: &Value, index: usize) -> String {
    let number = chapter.get("number").and_then(Value::as_u64).unwrap_or((index + 1) as u64);
    let title = chapter.get("title").and_then(Value::as_str).unwrap_or("未命名章节");
    format!("{number:03}-{}", safe_file_name(title))
}

#[tauri::command]
fn load_library_books(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let root = app_data_directory(&app)?.join("books");
    if !root.exists() { return Ok(None); }
    let mut books = Vec::new();
    let mut entries: Vec<_> = fs::read_dir(&root).map_err(|error| format!("读取书籍目录失败: {error}"))?
        .filter_map(Result::ok).filter(|entry| entry.path().is_dir()).collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let directory = entry.path();
        let metadata_path = directory.join("metadata.json");
        if !metadata_path.exists() { continue; }
        let content = fs::read_to_string(&metadata_path).map_err(|error| format!("读取书籍元数据失败: {error}"))?;
        let mut book: Value = serde_json::from_str(&content).map_err(|error| format!("书籍元数据格式错误: {error}"))?;
        if let Some(chapters) = book.get_mut("chapters").and_then(Value::as_array_mut) {
            for (index, chapter) in chapters.iter_mut().enumerate() {
                let relative = chapter.get("sourcePath").and_then(Value::as_str).map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("章节").join(format!("{}.md", library_chapter_stem(chapter, index))));
                if let Ok(text) = fs::read_to_string(directory.join(&relative)) {
                    let has_content = !text.trim().is_empty();
                    let was_downloaded = chapter.get("downloaded").and_then(Value::as_bool).unwrap_or(has_content);
                    let incomplete = chapter.get("unavailableReason").and_then(Value::as_str).is_some_and(|reason| !reason.trim().is_empty());
                    chapter["content"] = Value::String(text);
                    chapter["downloaded"] = Value::Bool(has_content && was_downloaded && !incomplete);
                }
                chapter["sourcePath"] = Value::String(relative.to_string_lossy().into_owned());
            }
        }
        book["localPath"] = Value::String(directory.to_string_lossy().into_owned());
        books.push(book);
    }
    Ok(Some(Value::Array(books)))
}

#[tauri::command]
fn save_library_books(app: tauri::AppHandle, books: Value) -> Result<String, String> {
    let root = app_data_directory(&app)?.join("books");
    fs::create_dir_all(&root).map_err(|error| format!("创建书籍目录失败: {error}"))?;
    let books = books.as_array().ok_or_else(|| "书籍数据必须是数组".to_string())?;
    let mut active = HashSet::new();
    for book in books {
        let id = book.get("id").and_then(Value::as_str).unwrap_or("book");
        let title = book.get("title").and_then(Value::as_str).unwrap_or("未命名书籍");
        let directory = root.join(format!("{}-{}", safe_folder_name(title), safe_file_name(id)));
        active.insert(directory.file_name().unwrap_or_default().to_string_lossy().into_owned());
        let chapter_dir = directory.join("章节");
        fs::create_dir_all(&chapter_dir).map_err(|error| format!("创建书籍章节目录失败: {error}"))?;
        let mut metadata = book.clone();
        if let Some(chapters) = metadata.get_mut("chapters").and_then(Value::as_array_mut) {
            let mut combined = String::new();
            for (index, chapter) in chapters.iter_mut().enumerate() {
                let relative = PathBuf::from("章节").join(format!("{}.md", library_chapter_stem(chapter, index)));
                let content = chapter.get("content").and_then(Value::as_str).unwrap_or("");
                fs::write(directory.join(&relative), content).map_err(|error| format!("保存书籍章节失败: {error}"))?;
                if !content.trim().is_empty() {
                    if !combined.is_empty() { combined.push_str("\n\n"); }
                    combined.push_str(chapter.get("title").and_then(Value::as_str).unwrap_or("未命名章节"));
                    combined.push('\n');
                    combined.push_str(content);
                }
                chapter["sourcePath"] = Value::String(relative.to_string_lossy().into_owned());
                chapter["content"] = Value::String(String::new());
            }
            fs::write(directory.join(format!("{}.txt", safe_file_name(title))), combined)
                .map_err(|error| format!("保存书籍 TXT 失败: {error}"))?;
        }
        metadata["localPath"] = Value::String(directory.to_string_lossy().into_owned());
        fs::write(directory.join("metadata.json"), serde_json::to_vec_pretty(&metadata).map_err(|error| format!("序列化书籍元数据失败: {error}"))?)
            .map_err(|error| format!("保存书籍元数据失败: {error}"))?;
    }
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()) {
            if !active.contains(&entry.file_name().to_string_lossy().into_owned()) {
                fs::remove_dir_all(entry.path()).map_err(|error| format!("清理已删除书籍失败: {error}"))?;
            }
        }
    }
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_library_book(app: tauri::AppHandle, book_id: String, book_title: String) -> Result<String, String> {
    let root = app_data_directory(&app)?.join("books");
    if !root.exists() { return Ok(root.to_string_lossy().into_owned()); }
    let preferred = root.join(format!("{}-{}", safe_folder_name(&book_title), safe_file_name(&book_id)));
    let directory = if preferred.exists() { Some(preferred) } else {
        fs::read_dir(&root).ok().and_then(|entries| entries.filter_map(Result::ok).find(|entry| {
            if !entry.path().is_dir() { return false; }
            let metadata = fs::read_to_string(entry.path().join("metadata.json")).ok();
            metadata.and_then(|content| serde_json::from_str::<Value>(&content).ok())
                .and_then(|value| value.get("id").and_then(Value::as_str).map(|id| id == book_id))
                .unwrap_or(false)
        }).map(|entry| entry.path()))
    };
    if let Some(directory) = directory {
        fs::remove_dir_all(&directory).map_err(|error| format!("删除书籍目录失败: {error}"))?;
        return Ok(directory.to_string_lossy().into_owned());
    }
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn load_ranking_books(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let path = app_data_directory(&app)?.join("rankings").join("metadata.json");
    if !path.exists() { return Ok(None); }
    let content = fs::read_to_string(path).map_err(|error| format!("读取榜单缓存失败: {error}"))?;
    serde_json::from_str(&content).map(Some).map_err(|error| format!("榜单缓存格式错误: {error}"))
}

#[tauri::command]
fn save_ranking_books(app: tauri::AppHandle, books: Value) -> Result<String, String> {
    let directory = app_data_directory(&app)?.join("rankings");
    fs::create_dir_all(&directory).map_err(|error| format!("创建榜单目录失败: {error}"))?;
    fs::write(directory.join("metadata.json"), serde_json::to_vec_pretty(&books).map_err(|error| format!("序列化榜单缓存失败: {error}"))?)
        .map_err(|error| format!("保存榜单缓存失败: {error}"))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_library_book_location(app: tauri::AppHandle, book_id: String, book_title: String) -> Result<String, String> {
    let root = app_data_directory(&app)?.join("books");
    let preferred = root.join(format!("{}-{}", safe_folder_name(&book_title), safe_file_name(&book_id)));
    let directory = if preferred.exists() { preferred } else {
        fs::read_dir(&root).ok().and_then(|entries| entries.filter_map(Result::ok).find(|entry| entry.path().is_dir() && entry.file_name().to_string_lossy().contains(&safe_file_name(&book_id))).map(|entry| entry.path())).unwrap_or(preferred)
    };
    if !directory.exists() { return Err("书籍尚未保存到本地".to_string()); }
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&directory).status().map_err(|error| format!("打开书籍位置失败: {error}"))?;
    #[cfg(target_os = "windows")]
    Command::new("explorer").arg(&directory).status().map_err(|error| format!("打开书籍位置失败: {error}"))?;
    #[cfg(target_os = "linux")]
    Command::new("xdg-open").arg(&directory).status().map_err(|error| format!("打开书籍位置失败: {error}"))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
fn load_writing_styles(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let directory = app_data_directory(&app)?.join("styles");
    let metadata_path = directory.join("metadata.json");
    if !metadata_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&metadata_path).map_err(|error| format!("读取文风索引失败: {error}"))?;
    let mut styles: Value = serde_json::from_str(&content).map_err(|error| format!("文风索引格式错误: {error}"))?;
    if let Some(items) = styles.as_array_mut() {
        for style in items {
            let source_path = style.get("sourcePath").and_then(Value::as_str)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(format!("{}.md", safe_file_name(style.get("name").and_then(Value::as_str).unwrap_or("未命名文风")))));
            if let Ok(markdown) = fs::read_to_string(directory.join(&source_path)) {
                style["content"] = Value::String(markdown);
            }
            style["sourcePath"] = Value::String(source_path.to_string_lossy().into_owned());
        }
    }
    Ok(Some(styles))
}

#[tauri::command]
fn save_writing_styles(app: tauri::AppHandle, styles: Value) -> Result<String, String> {
    let directory = app_data_directory(&app)?.join("styles");
    fs::create_dir_all(&directory).map_err(|error| format!("创建文风目录失败: {error}"))?;
    let styles = styles.as_array().ok_or_else(|| "文风数据必须是数组".to_string())?;
    let mut metadata = styles.clone();
    let mut current_files = HashSet::from(["metadata.json".to_string()]);
    for style in metadata.iter_mut() {
        let id = style.get("id").and_then(Value::as_str).unwrap_or("style");
        let name = style.get("name").and_then(Value::as_str).unwrap_or("未命名文风");
        let content = style.get("content").and_then(Value::as_str).unwrap_or("");
        let source_path = PathBuf::from(format!("{}-{}.md", safe_file_name(name), safe_file_name(id)));
        current_files.insert(source_path.to_string_lossy().into_owned());
        fs::write(directory.join(&source_path), content).map_err(|error| format!("保存文风 Markdown 失败: {error}"))?;
        style["sourcePath"] = Value::String(source_path.to_string_lossy().into_owned());
        style["content"] = Value::String(String::new());
    }
    fs::write(
        directory.join("metadata.json"),
        serde_json::to_vec_pretty(&metadata).map_err(|error| format!("序列化文风索引失败: {error}"))?,
    ).map_err(|error| format!("保存文风索引失败: {error}"))?;
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.filter_map(Result::ok).filter(|entry| entry.path().is_file()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !current_files.contains(&name) {
                fs::remove_file(entry.path()).map_err(|error| format!("清理已删除文风失败: {error}"))?;
            }
        }
    }
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_dismantle_location(app: tauri::AppHandle, book_title: String) -> Result<String, String> {
    let root = app_data_directory(&app)?.join("dismantles");
    let mut directory = root.join(safe_folder_name(&book_title));
    if !directory.exists() {
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()) {
                let metadata_path = entry.path().join("metadata.json");
                let matches = fs::read_to_string(metadata_path).ok()
                    .and_then(|content| serde_json::from_str::<Value>(&content).ok())
                    .and_then(|value| value.get("title").and_then(Value::as_str).map(|title| title == book_title))
                    .unwrap_or(false);
                if matches {
                    directory = entry.path();
                    break;
                }
            }
        }
    }
    if !directory.exists() {
        return Err("拆书资料尚未保存，请稍后再试".to_string());
    }
    #[cfg(target_os = "macos")]
    Command::new("open").arg(&directory).status().map_err(|error| format!("打开拆书位置失败: {error}"))?;
    #[cfg(target_os = "windows")]
    Command::new("explorer").arg(&directory).status().map_err(|error| format!("打开拆书位置失败: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open").arg(&directory).status().map_err(|error| format!("打开拆书位置失败: {error}"))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_dismantle_book(app: tauri::AppHandle, book_id: String, book_title: String) -> Result<String, String> {
    let root = app_data_directory(&app)?.join("dismantles");
    if !root.exists() { return Ok(root.to_string_lossy().into_owned()); }
    let mut directory = None;
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()) {
            let metadata = fs::read_to_string(entry.path().join("metadata.json")).ok();
            let matches = metadata.and_then(|content| serde_json::from_str::<Value>(&content).ok())
                .map(|value| {
                    value.get("id").and_then(Value::as_str).map(|id| id == book_id).unwrap_or(false)
                        || value.get("title").and_then(Value::as_str).map(|title| title == book_title).unwrap_or(false)
                }).unwrap_or(false);
            if matches {
                directory = Some(entry.path());
                break;
            }
        }
    }
    if let Some(directory) = directory {
        fs::remove_dir_all(&directory).map_err(|error| format!("删除拆书目录失败: {error}"))?;
        return Ok(directory.to_string_lossy().into_owned());
    }
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command]
fn projects_storage_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app_data_directory(&app)?
        .join("projects")
        .to_string_lossy()
        .into_owned())
}

fn find_project_directory(app: &tauri::AppHandle, project_id: i64) -> Result<PathBuf, String> {
    let root = app_data_directory(app)?.join("projects");
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
        {
            let metadata_path = entry.path().join("metadata.json");
            if let Ok(content) = fs::read_to_string(metadata_path) {
                if serde_json::from_str::<Value>(&content)
                    .ok()
                    .and_then(|value| value.get("id").and_then(Value::as_i64))
                    == Some(project_id)
                {
                    return Ok(entry.path());
                }
            }
        }
    }
    Err("找不到这本小说的本地目录".to_string())
}

fn reveal_location(path: &PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    Command::new("open")
        .args(["-R"])
        .arg(path)
        .status()
        .map_err(|error| format!("打开文件位置失败: {error}"))?;
    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status()
        .map_err(|error| format!("打开文件位置失败: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(path.parent().unwrap_or(path))
        .status()
        .map_err(|error| format!("打开文件位置失败: {error}"))?;
    Ok(())
}

#[tauri::command]
fn open_project_location(app: tauri::AppHandle, project_id: i64) -> Result<String, String> {
    let target = find_project_directory(&app, project_id)?;
    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&target)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    #[cfg(target_os = "windows")]
    Command::new("explorer")
        .arg(&target)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&target)
        .status()
        .map_err(|error| format!("打开文件夹失败: {error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_chapter_location(
    app: tauri::AppHandle,
    project_id: i64,
    chapter_title: String,
) -> Result<String, String> {
    let path = find_project_directory(&app, project_id)?
        .join("章节")
        .join(format!("{}.md", safe_file_name(&chapter_title)));
    if !path.exists() {
        return Err("章节 Markdown 尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_outline_location(
    app: tauri::AppHandle,
    project_id: i64,
    outline_title: Option<String>,
) -> Result<String, String> {
    let title = outline_title.unwrap_or_else(|| "大纲".to_string());
    let path = find_project_directory(&app, project_id)?
        .join("大纲")
        .join(format!("{}.md", safe_file_name(&title)));
    if !path.exists() {
        return Err("大纲 Markdown 尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_card_location(
    app: tauri::AppHandle,
    project_id: i64,
    card_type: String,
    card_title: String,
) -> Result<String, String> {
    let path = find_project_directory(&app, project_id)?
        .join("卡片")
        .join(safe_file_name(&card_type))
        .join(format!("{}.md", safe_file_name(&card_title)));
    if !path.exists() {
        return Err("卡片 Markdown 尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_graph_node_location(
    app: tauri::AppHandle,
    project_id: i64,
    node_id: String,
) -> Result<String, String> {
    let project_dir = find_project_directory(&app, project_id)?;
    let metadata: Value = serde_json::from_str(&fs::read_to_string(project_dir.join("metadata.json"))
        .map_err(|error| format!("读取图谱索引失败: {error}"))?)
        .map_err(|error| format!("图谱索引格式错误: {error}"))?;
    let node = metadata.get("graphNodes").and_then(Value::as_array)
        .and_then(|nodes| nodes.iter().find(|node| node.get("id").and_then(Value::as_str) == Some(node_id.as_str())))
        .ok_or_else(|| "找不到图谱节点档案".to_string())?;
    let relative_path = node.get("sourcePath").and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| graph_node_relative_path(node));
    let path = project_dir.join(relative_path);
    if !path.exists() {
        return Err("图谱档案尚未保存，请稍后再试".to_string());
    }
    reveal_location(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

fn graph_node_folder(node: &Value) -> &'static str {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("entity");
    let category = node.get("category").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "chapter" => "章节事件",
        "outline" => "大纲设定",
        "card" if category.contains("角色") || category.contains("人物") => "重要角色",
        "card" if category.contains("地点") => "地点与场景",
        "card" if category.contains("势力") => "组织与势力",
        "card" => "物品与设定",
        "entity" if category.contains("人物") || category.contains("角色") => "重要角色",
        "entity" if category.contains("地点") || category.contains("场景") => "地点与场景",
        "entity" if category.contains("势力") || category.contains("组织") => "组织与势力",
        "entity" if category.contains("物品") || category.contains("金手指") => "物品与设定",
        _ => "其他实体",
    }
}

fn graph_node_type_label(node: &Value) -> String {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or("entity");
    let category = node.get("category").and_then(Value::as_str).unwrap_or("");
    match node_type {
        "chapter" => "章节".to_string(),
        "outline" => "大纲".to_string(),
        "card" => if category.is_empty() { "知识卡".to_string() } else { category.to_string() },
        _ => if category.is_empty() { "实体".to_string() } else { category.to_string() },
    }
}

fn graph_node_relative_path(node: &Value) -> PathBuf {
    let title = node.get("label").and_then(Value::as_str).unwrap_or("未命名节点");
    PathBuf::from("图谱")
        .join(graph_node_folder(node))
        .join(format!("{}.md", safe_file_name(title)))
}

fn graph_node_profile_from_markdown(content: &str) -> String {
    let marker = "\n## 档案内容\n";
    let Some((_, after)) = content.split_once(marker) else { return content.trim().to_string(); };
    after.split("\n## 关系网络\n").next().unwrap_or(after).trim().to_string()
}

fn graph_edge_default_weight(label: &str) -> f64 {
    match label {
        "本章引用" => 1.0,
        "状态更新" => 0.95,
        "章节主角" => 0.92,
        "状态引用" => 0.88,
        "正文提及" => 0.75,
        "章节提及" => 0.70,
        _ => 0.65,
    }
}

fn graph_node_to_markdown(node: &Value, nodes: &[Value], edges: &[Value]) -> String {
    let id = node.get("id").and_then(Value::as_str).unwrap_or("");
    let title = node.get("label").and_then(Value::as_str).unwrap_or("未命名节点");
    let content = node.get("content").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("待补充。");
    let status = node.get("status").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("待补充");
    let mut relation_lines = Vec::new();
    for edge in edges {
        let source = edge.get("source").and_then(Value::as_str).unwrap_or("");
        let target = edge.get("target").and_then(Value::as_str).unwrap_or("");
        if source != id && target != id { continue; }
        let other_id = if source == id { target } else { source };
        let other_label = nodes.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(other_id))
            .and_then(|item| item.get("label").and_then(Value::as_str)).unwrap_or(other_id);
        let relation = edge.get("label").and_then(Value::as_str).unwrap_or("关联");
        let direction = if source == id { "指向对方" } else { "来自对方" };
        let weight = edge.get("weight").and_then(Value::as_f64).unwrap_or_else(|| graph_edge_default_weight(relation)).clamp(0.1, 1.0);
        relation_lines.push(format!("- {other_label}｜{relation}｜{direction}｜权重：{weight:.2}"));
    }
    let relation_text = if relation_lines.is_empty() { "- 暂无".to_string() } else { relation_lines.join("\n") };
    format!("# {title}\n\n<!-- ApiSaverWriter Graph Node: {id} -->\n\n## 基础信息\n- 节点类型：{}\n- 当前状态：{status}\n- 来源路径：{}\n\n## 档案内容\n{content}\n\n## 关系网络\n{relation_text}\n", graph_node_type_label(node), graph_node_relative_path(node).to_string_lossy())
}

fn safe_folder_name(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .map(|character| {
            if "\\/:*?\"<>|".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches(['.', ' ']).trim();
    if cleaned.is_empty() {
        "未命名小说".to_string()
    } else {
        cleaned.to_string()
    }
}

fn safe_file_name(value: &str) -> String {
    let name = safe_folder_name(value);
    if name.is_empty() {
        "未命名".to_string()
    } else {
        name
    }
}

fn markdown_list(memory: &Value, field: &str) -> String {
    memory
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            let rendered = items
                .iter()
                .filter_map(Value::as_str)
                .filter(|item| !item.trim().is_empty())
                .map(|item| format!("- {item}"))
                .collect::<Vec<_>>();
            if rendered.is_empty() { "- 暂无".to_string() } else { rendered.join("\n") }
        })
        .unwrap_or_else(|| "- 暂无".to_string())
}

fn chapter_memory_to_markdown(memory: &Value) -> String {
    let title = memory
        .get("chapterTitle")
        .and_then(Value::as_str)
        .unwrap_or("章节记忆");
    let summary = memory.get("summary").and_then(Value::as_str).unwrap_or("暂无摘要");
    let ending_hook = memory.get("endingHook").and_then(Value::as_str).unwrap_or("暂无");
    format!(
        "# {title} 记忆快照\n\n## 章节摘要\n{summary}\n\n## 关键词\n{}\n\n## 人物状态变化\n{}\n\n## 角色认知变化\n{}\n\n## 伏笔变化\n{}\n\n## 时间线事件\n{}\n\n## 设定事实\n{}\n\n## 冲突\n{}\n\n## 章末钩子\n{ending_hook}\n",
        markdown_list(memory, "keywords"),
        markdown_list(memory, "characterStateChanges"),
        markdown_list(memory, "knowledgeChanges"),
        markdown_list(memory, "foreshadowingChanges"),
        markdown_list(memory, "timelineEvents"),
        markdown_list(memory, "canonFacts"),
        markdown_list(memory, "conflicts"),
    )
}

fn outline_to_markdown(outline: Option<&Value>) -> String {
    fn visit(nodes: &[Value], output: &mut String, depth: usize) {
        for node in nodes {
            let title = node
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("未命名节点");
            let description = node
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            output.push_str(&format!("{} {}\n", "#".repeat((depth + 1).min(6)), title));
            if !description.is_empty() {
                output.push_str(description);
                output.push_str("\n\n");
            }
            if let Some(children) = node.get("children").and_then(Value::as_array) {
                visit(children, output, depth + 1);
            }
        }
    }

    let mut output = String::from("# 小说大纲\n\n");
    if let Some(nodes) = outline.and_then(Value::as_array) {
        visit(nodes, &mut output, 0);
    }
    output
}

#[tauri::command]
fn detect_system_proxy() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("scutil").arg("--proxy").output() {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut http_enabled = false;
            let mut https_enabled = false;
            let mut host = String::new();
            let mut port = String::new();
            for line in text.lines() {
                let mut parts = line.splitn(2, ':').map(str::trim);
                let key = parts.next().unwrap_or_default();
                let value = parts.next().unwrap_or_default();
                match key {
                    "HTTPEnable" => http_enabled = value == "1",
                    "HTTPSEnable" => https_enabled = value == "1",
                    "HTTPProxy" | "HTTPSProxy" if host.is_empty() => host = value.to_string(),
                    "HTTPPort" | "HTTPSPort" if port.is_empty() => port = value.to_string(),
                    _ => {}
                }
            }
            if (http_enabled || https_enabled) && !host.is_empty() && !port.is_empty() {
                return Ok(Some(format!("http://{host}:{port}")));
            }
        }
    }
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Ok(Some(value.trim().to_string()));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selected_cloud_backup_must_stay_in_configured_directory() {
        assert_eq!(
            validate_cloud_backup_path(
                "ApiSaverWriter/backup",
                "/apps/bdpan/ApiSaverWriter/backup/ApiSaverWriter-backup-2026-08-18.aswbackup"
            ).unwrap(),
            "ApiSaverWriter/backup/ApiSaverWriter-backup-2026-08-18.aswbackup"
        );
        assert!(validate_cloud_backup_path("ApiSaverWriter/backup", "ApiSaverWriter/other/backup.aswbackup").is_err());
        assert!(validate_cloud_backup_path("ApiSaverWriter/backup", "ApiSaverWriter/backup/../secret.aswbackup").is_err());
        assert!(validate_cloud_backup_path("ApiSaverWriter/backup", "ApiSaverWriter/backup/client-state.json").is_err());
    }

    #[test]
    fn cloud_backup_bundle_round_trip_supports_novel_paths() {
        let root = std::env::temp_dir().join(format!(
            "apisaverwriter-backup-test-{}",
            std::process::id()
        ));
        let source = root.join("source");
        let restored = root.join("restored");
        let chapter = source.join("projects/测试小说/章节/第 1 章 F级？可我隐藏天赋是SSS啊？.md");
        fs::create_dir_all(chapter.parent().unwrap()).unwrap();
        fs::write(&chapter, "第一章正文\n完整内容").unwrap();
        fs::write(source.join("client-state.json"), "{\"theme\":\"light\"}").unwrap();
        let bundle = root.join(CLOUD_BACKUP_BUNDLE_NAME);

        let size = write_cloud_backup_bundle(&source, &bundle).unwrap();
        let count = extract_cloud_backup_bundle(&bundle, &restored).unwrap();

        assert!(size > CLOUD_BACKUP_MAGIC.len() as u64);
        assert_eq!(&fs::read(&bundle).unwrap()[..2], &[0x1f, 0x8b]);
        assert_eq!(count, 2);
        assert_eq!(fs::read_to_string(restored.join(chapter.strip_prefix(&source).unwrap())).unwrap(), "第一章正文\n完整内容");
        assert_eq!(fs::read_to_string(restored.join("client-state.json")).unwrap(), "{\"theme\":\"light\"}");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn cloud_backup_restore_accepts_legacy_uncompressed_bundle() {
        let root = std::env::temp_dir().join(format!(
            "apisaverwriter-legacy-backup-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let bundle_path = root.join("legacy.aswbackup");
        let restored = root.join("restored");
        let relative = "projects/旧版小说/章节/第一章.md";
        let content = "旧版备份正文".as_bytes();
        let mut bundle = fs::File::create(&bundle_path).unwrap();
        bundle.write_all(CLOUD_BACKUP_MAGIC).unwrap();
        bundle.write_all(&1_u64.to_le_bytes()).unwrap();
        bundle.write_all(&(relative.len() as u32).to_le_bytes()).unwrap();
        bundle.write_all(&(content.len() as u64).to_le_bytes()).unwrap();
        bundle.write_all(relative.as_bytes()).unwrap();
        bundle.write_all(content).unwrap();
        bundle.flush().unwrap();

        assert_eq!(extract_cloud_backup_bundle(&bundle_path, &restored).unwrap(), 1);
        assert_eq!(fs::read_to_string(restored.join(relative)).unwrap(), "旧版备份正文");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn graph_node_document_preserves_profile_and_relationships() {
        let node = json!({
            "id": "entity:林舟",
            "label": "林舟",
            "type": "entity",
            "category": "人物",
            "status": "重伤后恢复中",
            "content": "## 人物状态\n- 在城南客栈养伤。\n- 对沈砚保持戒备。"
        });
        let related = json!({
            "id": "chapter:3",
            "label": "第3章 城南夜雨",
            "type": "chapter"
        });
        let edge = json!({
            "id": "chapter:3->entity:林舟",
            "source": "chapter:3",
            "target": "entity:林舟",
            "label": "章节提及",
            "weight": 0.7
        });

        let markdown = graph_node_to_markdown(&node, &[node.clone(), related], &[edge]);

        assert_eq!(graph_node_relative_path(&node), PathBuf::from("图谱/重要角色/林舟.md"));
        assert!(markdown.contains("- 当前状态：重伤后恢复中"));
        assert!(markdown.contains("第3章 城南夜雨｜章节提及｜来自对方｜权重：0.70"));
        assert_eq!(
            graph_node_profile_from_markdown(&markdown),
            "## 人物状态\n- 在城南客栈养伤。\n- 对沈砚保持戒备。"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(AgentRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            start_agent_runtime,
            call_agent_rpc,
            publish_fanqie,
            cloud_sync_status,
            baidu_login_url,
            complete_baidu_login,
            backup_projects_to_baidu,
            list_baidu_backups,
            restore_projects_from_baidu,
            load_projects,
            save_projects,
            export_chapters_txt,
            load_dismantle_books,
            save_dismantle_books,
            load_library_books,
            save_library_books,
            delete_library_book,
            load_ranking_books,
            save_ranking_books,
            load_writing_styles,
            save_writing_styles,
            projects_storage_path,
            open_project_location,
            open_dismantle_location,
            delete_dismantle_book,
            open_library_book_location,
            open_chapter_location,
            open_outline_location,
            open_card_location,
            open_graph_node_location,
            open_external_url,
            detect_system_proxy
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
