const { app, BrowserWindow, ipcMain, screen, protocol, net, dialog } = require('electron');
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

function resolveWindowIconPath() {
  const icoPath = path.join(__dirname, 'build', 'icon.ico');
  const pngPath = path.join(__dirname, 'public', 'cs2-insight-logo.png');
  try {
    if (fs.existsSync(icoPath)) return icoPath;
  } catch (e) {
    // ignore
  }
  return pngPath;
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const initWidth = Math.min(1600, Math.floor(width * 0.8));
  const initHeight = Math.min(900, Math.floor(height * 0.8));

  mainWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    minWidth: 1440,
    minHeight: 900,
    frame: false, // 移除原生菜单和标题栏
    titleBarStyle: 'hidden',
    icon: resolveWindowIconPath(),
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

function migrateLegacyWritableLayout(userDataPath, dataRoot) {
  // 旧版把配置/库/日志直接堆在 userData 根下；现统一迁入 userData/data，与 resources/data（只读随包）区分
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
  } catch (e) {
    log.warn('[Backend] mkdir dataRoot failed:', e);
  }
  const moveIfAbsent = (from, to) => {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.renameSync(from, to);
        log.info('[Backend] Migrated %s -> %s', from, to);
      }
    } catch (e) {
      log.warn('[Backend] Migrate skipped %s -> %s : %s', from, to, e?.message || e);
    }
  };
  moveIfAbsent(
    path.join(userDataPath, 'cs2-insight.config.json'),
    path.join(dataRoot, 'cs2-insight.config.json'),
  );
  for (const suf of ['', '-wal', '-shm']) {
    const name = `cs2-insight.db${suf}`;
    moveIfAbsent(path.join(userDataPath, name), path.join(dataRoot, name));
  }
  const legacyLogs = path.join(userDataPath, 'logs');
  const newLogs = path.join(dataRoot, 'logs');
  try {
    if (fs.existsSync(legacyLogs) && !fs.existsSync(newLogs)) {
      fs.renameSync(legacyLogs, newLogs);
      log.info('[Backend] Migrated logs directory -> %s', newLogs);
    }
  } catch (e) {
    log.warn('[Backend] Migrate logs dir failed:', e);
  }
  moveIfAbsent(
    path.join(userDataPath, '.cs2_config_backup'),
    path.join(dataRoot, '.cs2_config_backup'),
  );
  moveIfAbsent(
    path.join(userDataPath, '.obs_config_backups'),
    path.join(dataRoot, '.obs_config_backups'),
  );
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
  const dataRoot = path.join(userDataPath, 'data');
  migrateLegacyWritableLayout(userDataPath, dataRoot);

  const configPath = path.join(dataRoot, 'cs2-insight.config.json');
  const logsPath = path.join(dataRoot, 'logs');
  const bundleDataDir = finalBaseDir ? path.join(finalBaseDir, 'data') : '';

  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(logsPath, { recursive: true });
  } catch (e) {
    log.warn('[Backend] mkdir data/logs:', e);
  }

  log.info('[Backend] Electron userData:', userDataPath);
  log.info('[Backend] Writable data root (config/db/logs/backups):', dataRoot);
  log.info('[Backend] Config file:', configPath);
  log.info('[Backend] Backend logs dir:', logsPath);
  if (bundleDataDir) {
    log.info('[Backend] Bundled read-only data (examples/basic.ini):', bundleDataDir);
  }

  if (pythonExe && runServerPy) {
    if (bundleDataDir && !fs.existsSync(bundleDataDir)) {
      log.warn(`[Backend] Missing bundled data dir: ${bundleDataDir} (example config / basic.ini)`);
    }
    log.info(`[Backend] Starting from: ${pythonExe}`);
    const spawnEnv = {
      ...process.env,
      CS2_INSIGHT_PORT: '19871',
      PYTHONUNBUFFERED: '1',
      PYTHONFAULTHANDLER: '1',
      CS2_INSIGHT_CONFIG: configPath,
      CS2_INSIGHT_LOG_DIR: logsPath,
      CS2_INSIGHT_DATA_DIR: dataRoot,
    };
    if (bundleDataDir) {
      spawnEnv.CS2_INSIGHT_BUNDLE_DATA_DIR = bundleDataDir;
    }
    backendProcess = spawn(pythonExe, [runServerPy], {
      cwd: path.join(finalBaseDir, 'backend'),
      env: spawnEnv,
    });

    backendProcess.stdout.on('data', (data) => {
      log.info(`[Backend] ${data.toString().trimEnd()}`);
    });

    backendProcess.stderr.on('data', (data) => {
      log.error(`[Backend] ${data.toString().trimEnd()}`);
    });

    backendProcess.on('close', (code) => {
      console.log(`后端进程已退出，退出码 ${code}`);
    });

    backendProcess.on('error', (err) => {
      log.error('[Backend] spawn failed:', err);
    });
  } else {
    const searched = possibleBaseDirs.filter(Boolean).join('\n• ');
    const msg = [
      '未在安装目录中找到内嵌 Python 与后端（需要 resources/python/python.exe 与 resources/backend/...）。',
      '打包前请在仓库根目录放置官方 Windows embeddable Python 解压到 python/，并确保 electron-builder 的 extraResources 已打进安装包。',
      '',
      '已搜索位置：',
      `• ${searched}`,
    ].join('\n');
    log.error(`[Backend] ${msg}`);
    dialog.showErrorBox('CS2 Insight Agent — 无法启动后端', msg);
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

  try {
    startBackend();
  } catch (e) {
    log.error('[Backend] startBackend threw:', e);
    dialog.showErrorBox('CS2 Insight Agent', `启动后端时出错：${e?.message || e}`);
  }
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
