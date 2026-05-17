const { app, BrowserWindow, ipcMain, screen, protocol, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 注册自定义协议以支持 Vite 的 ES 模块加载
protocol.registerSchemesAsPrivileged([
  { 
    scheme: 'app', 
    privileges: { 
      standard: true, 
      secure: true, 
      supportFetchAPI: true, 
      corsEnabled: true, 
      allowServiceWorkers: true
    } 
  }
]);

// 配置更新日志
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// 每次启动时清除旧日志，仅保留当次运行记录
try {
  log.transports.file.getFile().clear();
} catch (e) {
  // 忽略清除失败
}

log.info('App starting...');

let mainWindow;
let backendProcess;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const initWidth = Math.min(1440, Math.floor(width * 0.8));
  const initHeight = Math.min(900, Math.floor(height * 0.8));

  mainWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    minWidth: 1024,
    minHeight: 768,
    frame: false, // 移除原生菜单和标题栏
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'public/cs2-insight-logo.png'), // 使用提供的图标
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // 允许跨域请求后端 API，并加载本地模块 (解决 blocked:origin)
      webSecurity: false, 
      allowRunningInsecureContent: true
    }
  });

  mainWindow.setMenu(null); // 显式移除原生菜单

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools(); // 在开发模式下打开开发者工具
  } else {
    // 使用更标准的 app://local 域名，避免 blocked:origin 错误
    log.info('Production mode: loading app://local/index.html');
    mainWindow.loadURL('app://local/index.html').catch((err) => {
      log.error('加载应用界面失败:', err);
    });
    // 生产环境白屏问题已修复，关闭默认开启的开发者工具
    // mainWindow.webContents.openDevTools();
  }

  // 加载生命周期监听
  mainWindow.webContents.on('did-start-loading', () => {
    log.info('Renderer: did-start-loading');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    log.info('Renderer: did-finish-load');
  });
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log.error(`Renderer: did-fail-load - ${errorCode} ${errorDescription} at ${validatedURL}`);
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximize-change', true);
  });
  
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximize-change', false);
  });
}

function killBackend() {
  if (backendProcess) {
    log.info(`[Backend] Killing process ${backendProcess.pid}`);
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', backendProcess.pid, '/f', '/t']);
      } catch (e) {}
    } else {
      backendProcess.kill();
    }
    backendProcess = null;
  }
}

function startBackend() {
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  
  if (isDev) {
    console.log('在开发模式下运行。假设后端单独启动或使用代理。');
    return;
  }

  // 启动前清理
  killBackend();

  // 增强的路径探测逻辑
  // 1. 尝试 process.resourcesPath (真实打包后的位置)
  // 2. 尝试 __dirname 向上两级 (模拟生产环境运行时的位置)
  const possibleBaseDirs = [
    process.resourcesPath,
    path.join(__dirname, '..'), // dist 目录在项目根目录下，所以向上走一级
    path.join(__dirname, '../..')
  ];

  let pythonExe = '';
  let runServerPy = '';
  let finalBaseDir = '';

  for (const base of possibleBaseDirs) {
    const py = path.join(base, 'python', 'python.exe');
    const rs = path.join(base, 'backend', 'app', 'run_server.py');
    if (fs.existsSync(py) && fs.existsSync(rs)) {
      pythonExe = py;
      runServerPy = rs;
      finalBaseDir = base;
      break;
    }
  }

  const userDataPath = app.getPath('userData');
  const configPath = path.join(userDataPath, 'cs2-insight.config.json');
  const logsPath = path.join(userDataPath, 'logs');

  if (pythonExe && runServerPy) {
    log.info(`[Backend] Starting from: ${pythonExe}`);
    backendProcess = spawn(pythonExe, [runServerPy], {
      cwd: path.join(finalBaseDir, 'backend'),
      env: {
        ...process.env,
        CS2_INSIGHT_PORT: '19871',
        PYTHONUNBUFFERED: '1',
        PYTHONFAULTHANDLER: '1',
        CS2_INSIGHT_CONFIG: configPath,
        CS2_INSIGHT_LOG_DIR: logsPath
      }
    });

    backendProcess.stdout.on('data', (data) => {
      console.log(`后端 stdout: ${data}`);
    });

    backendProcess.stderr.on('data', (data) => {
      console.error(`后端 stderr: ${data}`);
    });

    backendProcess.on('close', (code) => {
      console.log(`后端进程已退出，退出码 ${code}`);
    });
  } else {
    console.error('未能在以下位置找到 Python 可执行文件或后端脚本:', baseDir);
  }
}

app.whenReady().then(() => {
  // 使用更稳健的 registerFileProtocol
  protocol.registerFileProtocol('app', (request, callback) => {
    // 移除 app://local/ 前缀
    const urlPath = request.url.replace(/^app:\/\/local\//, '');
    // 去除参数
    const cleanPath = urlPath.split('?')[0].split('#')[0];
    
    // 关键修复：如果是请求 api，说明前端代码写错了（生产环境必须用 http 绝对路径）
    // 我们返回错误，而不是 index.html，避免掩盖真实的连接问题
    if (cleanPath.startsWith('api/') || cleanPath === 'api') {
      return callback({ error: -6 }); // net::ERR_FILE_NOT_FOUND
    }

    // 现在的路径相对于 app.asar，由于我们把 dist 整个打进去了
    let filePath = path.join(app.getAppPath(), 'dist', cleanPath || 'index.html');
    
    // 如果是目录或不存在，回退到 index.html
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(app.getAppPath(), 'dist', 'index.html');
    }
    
    callback({ path: filePath });
  });

  startBackend();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 手动检查更新的 IPC 处理程序
ipcMain.on('check-for-updates', () => {
  log.info('Manual update check requested');
  autoUpdater.checkForUpdatesAndNotify();
});

// 更新相关的事件监听，通过 IPC 发送到前端
autoUpdater.on('checking-for-update', () => {
  log.info('Checking for update...');
  mainWindow?.webContents.send('update-status', { status: 'checking', message: '正在检查更新...' });
});
autoUpdater.on('update-available', (info) => {
  log.info('Update available.');
  mainWindow?.webContents.send('update-status', { status: 'available', message: '发现新版本', info });
});
autoUpdater.on('update-not-available', (info) => {
  log.info('Update not available.');
  mainWindow?.webContents.send('update-status', { status: 'not-available', message: '当前已是最新版本' });
});
autoUpdater.on('error', (err) => {
  log.error('Error in auto-updater. ' + err);
  mainWindow?.webContents.send('update-status', { status: 'error', message: '更新检查失败', error: err.message });
});
autoUpdater.on('download-progress', (progressObj) => {
  let log_message = "Download speed: " + progressObj.bytesPerSecond;
  log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
  log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
  log.info(log_message);
  mainWindow?.webContents.send('update-status', { status: 'downloading', message: '正在下载更新...', progress: progressObj });
});
autoUpdater.on('update-downloaded', (info) => {
  log.info('Update downloaded');
  mainWindow?.webContents.send('update-status', { status: 'downloaded', message: '更新下载完成，准备重启安装' });
  setTimeout(function() {
    autoUpdater.quitAndInstall();
  }, 3000);
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    killBackend();
    app.quit();
  }
});

app.on('before-quit', () => {
  killBackend();
});

// 自定义标题栏的 IPC 处理程序
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.restore();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-unmaximize', () => {
  if (mainWindow) {
    mainWindow.unmaximize();
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false;
});

ipcMain.handle('is-packaged', () => {
  return app.isPackaged;
});
