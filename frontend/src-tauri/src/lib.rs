use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct BackendProcess {
    child: Mutex<Option<ManagedBackend>>,
}

impl BackendProcess {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }
}

struct ManagedBackend {
    child: Child,
    instance_id: String,
    data_root: PathBuf,
}

fn backend_http(method: &str, path: &str) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], 19871));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(350)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:19871\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    Some(response)
}

fn new_instance_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos}", std::process::id())
}

#[tauri::command]
fn read_legacy_ui_state() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let app_data = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "Windows APPDATA 环境变量不存在".to_string())?;
        let state_file = app_data
            .join("CS2 Insight Agent")
            .join("data")
            .join("desktop-ui-state-v1.json");
        if !state_file.is_file() {
            return Ok(None);
        }
        fs::read_to_string(&state_file)
            .map(Some)
            .map_err(|error| format!("无法读取旧版界面状态 {}：{error}", state_file.display()))
    }

    #[cfg(not(windows))]
    Ok(None)
}

fn validated_inspect_hex(value: &str) -> Result<&str, String> {
    let hex = value.trim();
    if hex.len() < 12
        || hex.len() > 8192
        || hex.len() % 2 != 0
        || !hex.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("CS2 检视载荷格式无效".to_string());
    }
    Ok(hex)
}

#[tauri::command]
fn launch_cs2_inspect(hex: String) -> Result<(), String> {
    let hex = validated_inspect_hex(&hex)?;
    let inspect_url = format!(
        "steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20{hex}"
    );

    #[cfg(windows)]
    {
        let mut command = Command::new("rundll32.exe");
        command
            .args(["url.dll,FileProtocolHandler", &inspect_url])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let status = command
            .status()
            .map_err(|error| format!("无法调用 Windows Steam 协议处理器：{error}"))?;
        if !status.success() {
            return Err(format!("Steam 协议处理器退出码：{status}"));
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = inspect_url;
        Err("当前平台尚未实现 CS2 检视启动".to_string())
    }
}

#[cfg(test)]
mod inspect_launch_tests {
    use super::validated_inspect_hex;

    #[test]
    fn accepts_only_bounded_even_hex_payloads() {
        assert_eq!(validated_inspect_hex("001807209A02"), Ok("001807209A02"));
        assert!(validated_inspect_hex("00180Z").is_err());
        assert!(validated_inspect_hex("001807209A0").is_err());
        assert!(validated_inspect_hex("steam://run/730").is_err());
    }
}

#[tauri::command]
async fn resolve_dropped_file_paths(
    window: tauri::WebviewWindow,
    token: String,
) -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            resolve_dropped_file_paths_windows(&window, &token)
        })
        .await
        .map_err(|error| format!("file path resolver task failed: {error}"))?
    }

    #[cfg(not(windows))]
    {
        let _ = (window, token);
        Ok(Vec::new())
    }
}

#[cfg(windows)]
fn call_webview2_devtools(
    window: &tauri::WebviewWindow,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let method_name = method.to_string();
    let params_json = params.to_string();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let dispatch_sender = sender.clone();
    window
        .with_webview(move |platform_webview| {
            let result = (|| -> Result<(), String> {
                let webview = unsafe { platform_webview.controller().CoreWebView2() }
                    .map_err(|error| error.to_string())?;
                let method = CoTaskMemPWSTR::from(method_name.as_str());
                let params = CoTaskMemPWSTR::from(params_json.as_str());
                let completion_sender = dispatch_sender.clone();
                let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                    move |status, payload| {
                        let result = status.map(|_| payload).map_err(|error| error.to_string());
                        let _ = completion_sender.send(result);
                        Ok(())
                    },
                ));
                unsafe {
                    webview.CallDevToolsProtocolMethod(
                        *method.as_ref().as_pcwstr(),
                        *params.as_ref().as_pcwstr(),
                        &callback,
                    )
                }
                .map_err(|error| error.to_string())
            })();
            if let Err(error) = result {
                let _ = dispatch_sender.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;

    let payload = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|error| format!("{method} timed out: {error}"))??;
    let response: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| format!("invalid {method} response: {error}"))?;
    if let Some(error) = response.get("error") {
        return Err(format!("{method} failed: {error}"));
    }
    Ok(response)
}

#[cfg(windows)]
fn devtools_remote_object_id(response: &serde_json::Value) -> Option<&str> {
    response
        .pointer("/result/objectId")
        .and_then(serde_json::Value::as_str)
}

#[cfg(windows)]
fn devtools_indexed_object_ids(response: &serde_json::Value) -> Vec<String> {
    let mut indexed = response
        .pointer("/result")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|property| {
            let index = property.get("name")?.as_str()?.parse::<usize>().ok()?;
            let object_id = property.pointer("/value/objectId")?.as_str()?.to_string();
            Some((index, object_id))
        })
        .collect::<Vec<_>>();
    indexed.sort_unstable_by_key(|(index, _)| *index);
    indexed
        .into_iter()
        .map(|(_, object_id)| object_id)
        .collect()
}

#[cfg(windows)]
fn devtools_file_path(response: &serde_json::Value) -> Option<&str> {
    response.get("path").and_then(serde_json::Value::as_str)
}

#[cfg(windows)]
fn resolve_dropped_file_paths_windows(
    window: &tauri::WebviewWindow,
    token: &str,
) -> Result<Vec<String>, String> {
    if token.is_empty()
        || token.len() > 128
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("invalid file drop token".to_string());
    }

    let object_group = format!("litecut-file-drop-{token}");
    let token_json = serde_json::to_string(token).map_err(|error| error.to_string())?;
    let evaluated = call_webview2_devtools(
        window,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": format!(
                "globalThis.__LITECUT_DROPPED_FILES__?.[{token_json}] ?? null"
            ),
            "objectGroup": object_group,
            "returnByValue": false,
            "awaitPromise": false,
        }),
    )?;
    let object_id = devtools_remote_object_id(&evaluated)
        .ok_or_else(|| "dropped FileList is unavailable".to_string())?
        .to_string();

    let result = (|| {
        let properties = call_webview2_devtools(
            window,
            "Runtime.getProperties",
            serde_json::json!({
                "objectId": object_id,
                "ownProperties": true,
                "generatePreview": false,
            }),
        )?;
        let mut paths = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for file_object_id in devtools_indexed_object_ids(&properties) {
            let file_info = call_webview2_devtools(
                window,
                "DOM.getFileInfo",
                serde_json::json!({ "objectId": file_object_id }),
            )?;
            let Some(path) = devtools_file_path(&file_info)
                .map(str::trim)
                .filter(|path| !path.is_empty())
            else {
                continue;
            };
            if seen.insert(path.to_ascii_lowercase()) {
                paths.push(path.to_string());
            }
        }
        Ok(paths)
    })();

    let _ = call_webview2_devtools(
        window,
        "Runtime.releaseObjectGroup",
        serde_json::json!({ "objectGroup": object_group }),
    );
    result
}

#[cfg(all(test, windows))]
mod dropped_file_path_tests {
    use super::{devtools_file_path, devtools_indexed_object_ids, devtools_remote_object_id};

    #[test]
    fn reads_runtime_evaluate_object_id() {
        let response = serde_json::json!({
            "result": { "type": "object", "objectId": "list-7" }
        });
        assert_eq!(devtools_remote_object_id(&response), Some("list-7"));
    }

    #[test]
    fn orders_file_objects_and_ignores_non_index_properties() {
        let response = serde_json::json!({
            "result": [
                { "name": "length", "value": { "value": 2 } },
                { "name": "1", "value": { "objectId": "file-b" } },
                { "name": "0", "value": { "objectId": "file-a" } }
            ]
        });
        assert_eq!(
            devtools_indexed_object_ids(&response),
            vec!["file-a".to_string(), "file-b".to_string()]
        );
    }

    #[test]
    fn reads_dom_get_file_info_path() {
        let response = serde_json::json!({ "path": "C:\\captures\\match.mp4" });
        assert_eq!(
            devtools_file_path(&response),
            Some("C:\\captures\\match.mp4")
        );
    }
}

fn writable_data_root(_app: &AppHandle, root: &Path, python: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        let app_data = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or_else(|| "Windows APPDATA 环境变量不存在".to_string())?;
        let migration_script = root.join("backend/app/desktop_data_migration.py");
        if !migration_script.is_file() {
            return Err(format!(
                "未找到桌面数据迁移脚本：{}",
                migration_script.display()
            ));
        }

        let mut command = Command::new(python);
        command
            .arg("-I")
            .arg(&migration_script)
            .arg("--appdata")
            .arg(&app_data)
            .env("PYTHONNOUSERSITE", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command
            .output()
            .map_err(|error| format!("无法执行桌面数据迁移：{error}"))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("桌面数据迁移失败，退出码：{}", output.status)
            } else {
                format!("桌面数据迁移失败：{detail}")
            });
        }

        let data_root = app_data.join("CS2 Insight Agent").join("data");
        fs::create_dir_all(data_root.join("logs"))
            .map_err(|error| format!("无法创建应用数据目录 {}：{error}", data_root.display()))?;
        Ok(data_root)
    }

    #[cfg(not(windows))]
    {
        let data_root = _app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法解析应用数据目录：{error}"))?
            .join("data");
        fs::create_dir_all(data_root.join("logs"))
            .map_err(|error| format!("无法创建应用数据目录 {}：{error}", data_root.display()))?;
        Ok(data_root)
    }
}

fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    // `tauri dev` copies configured bundle resources into target/debug. Those
    // files may be leftovers from the last NSIS staging run, so preferring the
    // resource directory in a debug build silently runs a stale backend and
    // bundled Python. Development must always use the live checkout and its
    // .venv; release builds continue to use the packaged resources below.
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .map_err(|error| format!("无法解析开发目录：{error}"));
    }

    let bundled_root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法解析安装资源目录：{error}"))?;
    if bundled_root.join("backend/app/run_server.py").is_file()
        && bundled_root.join("python/python.exe").is_file()
    {
        return Ok(bundled_root);
    }
    Ok(bundled_root)
}

fn python_executable(root: &Path) -> Option<PathBuf> {
    let candidates = if cfg!(debug_assertions) {
        vec![
            root.join(".venv/Scripts/python.exe"),
            root.join("python/python.exe"),
        ]
    } else {
        vec![root.join("python/python.exe")]
    };
    candidates.into_iter().find(|path| path.is_file())
}

fn append_desktop_log(logs_dir: &Path, message: &str) {
    let path = logs_dir.join("desktop.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write;
        let _ = writeln!(file, "{message}");
    }
}

fn start_backend(app: &AppHandle) -> Result<(), String> {
    let root = runtime_root(app)?;
    let python = python_executable(&root).ok_or_else(|| {
        format!(
            "未找到 Python 运行时。已检查 {}。",
            root.join("python/python.exe").display()
        )
    })?;
    let run_server = root.join("backend/app/run_server.py");
    if !run_server.is_file() {
        return Err(format!("未找到后端入口：{}", run_server.display()));
    }

    let data_root = writable_data_root(app, &root, &python)?;
    let logs_dir = data_root.join("logs");
    let backend_dir = root.join("backend");
    let bundle_data_dir = root.join("data");
    append_desktop_log(
        &logs_dir,
        &format!(
            "[desktop] starting backend: {} {}",
            python.display(),
            run_server.display()
        ),
    );

    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_dir.join("backend-stdio.log"))
        .map_err(|error| format!("无法打开后端日志：{error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("无法复制后端日志句柄：{error}"))?;

    let instance_id = new_instance_id();
    let mut command = Command::new(&python);
    command
        .arg(&run_server)
        .current_dir(&backend_dir)
        .env("CS2_INSIGHT_PORT", "19871")
        .env("CS2_INSIGHT_INSTANCE_ID", &instance_id)
        .env("PYTHONNOUSERSITE", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONFAULTHANDLER", "1")
        .env(
            "CS2_INSIGHT_CONFIG",
            data_root.join("cs2-insight.config.json"),
        )
        .env("CS2_INSIGHT_LOG_DIR", &logs_dir)
        .env("CS2_INSIGHT_DATA_DIR", &data_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if bundle_data_dir.is_dir() {
        command.env("CS2_INSIGHT_BUNDLE_DATA_DIR", bundle_data_dir);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let child = command
        .spawn()
        .map_err(|error| format!("无法启动 Python 后端：{error}"))?;

    // Register the child immediately so a window close during startup still
    // reaps the backend process instead of leaking it.
    {
        let state = app.state::<BackendProcess>();
        let mut backend_state = state
            .child
            .lock()
            .map_err(|_| "后端进程状态锁已损坏".to_string())?;
        *backend_state = Some(ManagedBackend {
            child,
            instance_id: instance_id.clone(),
            data_root,
        });
    }

    let mut verified = false;
    for _ in 0..120 {
        {
            let state = app.state::<BackendProcess>();
            let mut guard = state
                .child
                .lock()
                .map_err(|_| "后端进程状态锁已损坏".to_string())?;
            let Some(backend) = guard.as_mut() else {
                // stop_backend already took ownership: the app is shutting down.
                return Ok(());
            };
            if backend.child.try_wait().ok().flatten().is_some() {
                *guard = None;
                return Err(
                    "Python 后端在启动阶段退出，请查看应用数据目录中的 backend-stdio.log。"
                        .to_string(),
                );
            }
        }
        if backend_http("GET", "/api/app/runtime-state")
            .is_some_and(|response| response.contains(&instance_id))
        {
            verified = true;
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    if !verified {
        let state = app.state::<BackendProcess>();
        if let Ok(mut guard) = state.child.lock() {
            if let Some(mut backend) = guard.take() {
                let _ = backend.child.kill();
                let _ = backend.child.wait();
            }
        }
        return Err(
            "Backend startup identity check failed; port 19871 may belong to another process."
                .to_string(),
        );
    }
    Ok(())
}

fn stop_backend(app: &AppHandle) {
    let state = app.state::<BackendProcess>();
    let Ok(mut guard) = state.child.lock() else {
        return;
    };
    let Some(mut backend) = guard.take() else {
        return;
    };
    drop(guard);
    if backend.child.try_wait().ok().flatten().is_some() {
        return;
    }

    let response = backend_http("POST", "/api/app/shutdown");
    append_desktop_log(
        &backend.data_root.join("logs"),
        &format!(
            "[desktop] shutdown requested for instance {} response={}",
            backend.instance_id,
            response.as_deref().unwrap_or("unavailable")
        ),
    );
    for _ in 0..180 {
        if backend.child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }

    let _ = fs::write(
        backend.data_root.join("recovery-required.json"),
        "{\"reason\":\"desktop forced backend termination after graceful shutdown timeout\"}\n",
    );

    #[cfg(windows)]
    {
        let mut taskkill = Command::new("taskkill");
        taskkill.args(["/pid", &backend.child.id().to_string(), "/f", "/t"]);
        taskkill.creation_flags(CREATE_NO_WINDOW);
        let _ = taskkill.status();
    }
    let _ = backend.child.kill();
    let _ = backend.child.wait();
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BackendProcess::new())
        .invoke_handler(tauri::generate_handler![
            read_legacy_ui_state,
            launch_cs2_inspect,
            resolve_dropped_file_paths
        ])
        .setup(|app| {
            // Start the backend on a worker thread so the window (and its
            // "connecting to backend" splash) appears immediately instead of
            // after the Python process answers HTTP.
            let handle = app.handle().clone();
            thread::spawn(move || {
                if let Err(error) = start_backend(&handle) {
                    handle
                        .dialog()
                        .message(format!(
                            "{error}\n\n请重新安装完整安装包，或查看应用数据目录中的日志。"
                        ))
                        .title("CS2 Insight Agent — 后端启动失败")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build CS2 Insight Agent desktop shell");

    app.run(|handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            // Destroy the webview first so EventSource/HTTP connections close
            // immediately. Otherwise uvicorn waits on the still-live renderer
            // while this handler waits on uvicorn.
            api.prevent_close();
            if let Some(window) = handle.get_webview_window(&label) {
                let _ = window.destroy();
            }
            // window.destroy() is only queued on the event loop; blocking on
            // the backend here would keep a frozen window on screen for the
            // whole graceful-shutdown wait. Stop the backend on a worker
            // thread so the window disappears instantly.
            let handle = handle.clone();
            thread::spawn(move || {
                stop_backend(&handle);
                handle.exit(0);
            });
        }
        RunEvent::ExitRequested { code, api, .. } => {
            // The last window closing must not tear down the process while the
            // worker thread is still stopping the backend; explicit exit()
            // calls (which carry a code) pass through.
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_backend(handle),
        _ => {}
    });
}
