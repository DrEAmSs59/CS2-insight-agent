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

use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

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

fn backend_http(method: &str, path: &str, session_token: &str) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], 19871));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(350)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:19871\r\nX-CS2-Insight-Token: {session_token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
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

fn new_session_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("无法生成桌面会话令牌：{error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[tauri::command]
fn backend_session_token(state: State<'_, BackendProcess>) -> String {
    state.session_token.clone()
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
    let bundled_root = app
        .path()
        .resource_dir()
        .map_err(|error| format!("无法解析安装资源目录：{error}"))?;
    if bundled_root.join("backend/app/run_server.py").is_file()
        && bundled_root.join("python/python.exe").is_file()
    {
        return Ok(bundled_root);
    }
    if cfg!(debug_assertions) {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .map_err(|error| format!("无法解析开发目录：{error}"));
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
    let session_token = app.state::<BackendProcess>().session_token.clone();
    let mut command = Command::new(&python);
    command
        .arg(&run_server)
        .current_dir(&backend_dir)
        .env("CS2_INSIGHT_PORT", "19871")
        .env("CS2_INSIGHT_INSTANCE_ID", &instance_id)
        .env("CS2_INSIGHT_SESSION_TOKEN", &session_token)
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
        if backend_http("GET", "/api/app/runtime-state", &session_token)
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

    let response = backend_http("POST", "/api/app/shutdown", &session_token);
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BackendProcess::new())
        .invoke_handler(tauri::generate_handler![
            read_legacy_ui_state
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

#[cfg(test)]
mod tests {
    use super::new_session_token;

    #[test]
    fn session_token_is_256_bit_hex() {
        let token = new_session_token().expect("OS random source should be available");
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|value| value.is_ascii_hexdigit()));
    }
}
