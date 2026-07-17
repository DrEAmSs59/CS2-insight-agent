const { app, BrowserWindow, ipcMain, screen, protocol, net, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { CancellationToken, CancellationError } = require('builder-util-runtime');
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

// 配置更新日志；关闭自动下载，便于用 CancellationToken 支持「停止更新」
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

// 每次启动时清除旧日志，仅保留当次运行记录
try {
  log.transports.file.getFile().clear();
} catch (e) {
  // 忽略清除失败
}

log.info('App starting...');

let mainWindow;
let backendProcess;
const ELECTRON_SMOKE = process.env.CS2_INSIGHT_ELECTRON_SMOKE === '1';
let electronSmokeStarted = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runElectronSmokeCheck() {
  if (!ELECTRON_SMOKE || electronSmokeStarted) return;
  electronSmokeStarted = true;
  const reportPath = process.env.CS2_INSIGHT_ELECTRON_SMOKE_REPORT
    || path.join(app.getPath('userData'), 'electron-smoke-report.json');
  const report = {
    ok: false,
    packaged: app.isPackaged,
    launchMode: process.env.CS2_INSIGHT_ELECTRON_SMOKE_ASAR === '1' ? 'packaged-asar' : 'packaged-exe',
    version: app.getVersion(),
    resourcesPath: process.resourcesPath,
    checks: {},
    error: '',
    finishedAt: new Date().toISOString(),
  };
  try {
    const resourceBase = [process.resourcesPath, path.join(__dirname, '..'), path.join(__dirname, '../..')]
      .find((base) => fs.existsSync(path.join(base, 'python', 'python.exe')) && fs.existsSync(path.join(base, 'backend', 'app', 'run_server.py')));
    if (!resourceBase) throw new Error('Could not resolve packaged resource directory');
    report.resourceBase = resourceBase;
    const requiredResources = [
      path.join(resourceBase, 'python', 'python.exe'),
      path.join(resourceBase, 'backend', 'app', 'run_server.py'),
      path.join(resourceBase, 'backend', 'assets', 'fonts', 'NotoSansSC-Medium.ttf'),
      path.join(resourceBase, 'data', 'lite_cut_effect_contract.json'),
    ];
    report.checks.resources = requiredResources.map((itemPath) => ({ path: itemPath, exists: fs.existsSync(itemPath) }));
    if ((!app.isPackaged && report.launchMode !== 'packaged-asar') || report.checks.resources.some((item) => !item.exists)) {
      throw new Error('Packaged resources are incomplete');
    }

    let health = null;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const response = await net.fetch('http://127.0.0.1:19871/api/health');
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch (_) {}
      await delay(350);
    }
    report.checks.backendHealth = health;
    if (!health) throw new Error('Packaged backend did not become healthy');

    const renderer = await mainWindow.webContents.executeJavaScript(`(async () => {
      history.pushState({}, '', '/lite-cut');
      window.dispatchEvent(new PopStateEvent('popstate'));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !document.querySelector('[data-litecut-start-page], .litecut-editor-interactive')) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        href: location.href,
        title: document.title,
        rootChildren: document.getElementById('root')?.childElementCount || 0,
        bodyTextLength: document.body?.innerText?.trim()?.length || 0,
        hasElectronBridge: Boolean(window.electron?.getVersion),
        liteCutReady: Boolean(document.querySelector('[data-litecut-start-page], .litecut-editor-interactive')),
      };
    })()`, true);
    report.checks.renderer = renderer;
    if (!String(renderer.href || '').startsWith('app://local/lite-cut') || !renderer.hasElectronBridge || !renderer.liteCutReady || renderer.rootChildren < 1 || renderer.bodyTextLength < 10) {
      throw new Error('Packaged renderer did not initialize correctly');
    }

    const dataRoot = path.join(app.getPath('userData'), 'data');
    report.checks.writableDataRoot = { path: dataRoot, exists: fs.existsSync(dataRoot) };
    if (!report.checks.writableDataRoot.exists) throw new Error('Writable Electron data directory was not created');
    report.ok = true;
  } catch (error) {
    report.error = error?.stack || error?.message || String(error);
  }
  report.finishedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  } catch (error) {
    log.error('[Electron smoke] Could not write report:', error);
  }
  log.info('[Electron smoke] Result:', report);
  killBackend();
  setTimeout(() => app.exit(report.ok ? 0 : 1), 100);
}

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
  const initWidth = Math.min(1700, Math.floor(width * 0.8));
  const initHeight = Math.min(900, Math.floor(height * 0.8));

  mainWindow = new BrowserWindow({
    width: initWidth,
    height: initHeight,
    minWidth: 1540,
    minHeight: 900,
    frame: false, // 移除原生菜单和标题栏
    titleBarStyle: 'hidden',
    icon: resolveWindowIconPath(),
    show: !ELECTRON_SMOKE,
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
    mainWindow.webContents.openDevTools(); // 在开发模式下自动打开开发者工具
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
    void runElectronSmokeCheck();
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
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
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

    // 正式包只保留 resources/web 一份静态文件，避免与 app.asar 重复打包。
    const webRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'web')
      : path.join(app.getAppPath(), 'dist');
    let filePath = path.join(webRoot, cleanPath || 'index.html');
    
    // 如果是目录或不存在，回退到 index.html
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(webRoot, 'index.html');
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

/** 缓存最近一次发现的远端版本，供 download-progress 等不含 version 的事件复用 */
let cachedUpdateVersion = null;
let cachedReleaseNotes = '';
/** @type {import('builder-util-runtime').CancellationToken | null} */
let updateDownloadToken = null;
let updateInstallTimer = null;
let updateDownloadInFlight = false;
/** 用户点停止/关闭后，忽略后续 available → 自动开下 */
let updateUserCancelled = false;

function clearUpdateInstallTimer() {
  if (updateInstallTimer) {
    clearTimeout(updateInstallTimer);
    updateInstallTimer = null;
  }
}

function sendUpdateStatus(payload) {
  mainWindow?.webContents.send('update-status', payload);
}

function cancelUpdateDownload(reason = 'user') {
  clearUpdateInstallTimer();
  updateUserCancelled = true;
  const token = updateDownloadToken;
  updateDownloadToken = null;
  if (token && !token.cancelled) {
    log.info(`Cancelling update download (${reason})`);
    try {
      token.cancel();
    } catch (e) {
      log.warn('cancel update token failed:', e);
    }
  }
  updateDownloadInFlight = false;
  sendUpdateStatus({
    status: 'cancelled',
    latest_version: cachedUpdateVersion,
    release_notes: cachedReleaseNotes,
  });
}

function startUpdateDownload() {
  if (updateUserCancelled) {
    log.info('Skip start download: user cancelled this check session');
    return;
  }
  if (updateDownloadInFlight) {
    log.info('Update download already in progress — skip start');
    return;
  }
  clearUpdateInstallTimer();
  updateDownloadToken = new CancellationToken();
  updateDownloadInFlight = true;
  sendUpdateStatus({
    status: 'downloading',
    progress: { percent: 0 },
    latest_version: cachedUpdateVersion,
    release_notes: cachedReleaseNotes,
  });
  const token = updateDownloadToken;
  autoUpdater
    .downloadUpdate(token)
    .then(() => {
      log.info('downloadUpdate resolved');
    })
    .catch((err) => {
      if (err instanceof CancellationError || token?.cancelled || updateUserCancelled) {
        log.info('Update download cancelled');
        updateDownloadInFlight = false;
        if (updateDownloadToken === token) updateDownloadToken = null;
        sendUpdateStatus({
          status: 'cancelled',
          latest_version: cachedUpdateVersion,
          release_notes: cachedReleaseNotes,
        });
        return;
      }
      log.error('downloadUpdate failed:', err);
      updateDownloadInFlight = false;
      if (updateDownloadToken === token) updateDownloadToken = null;
      sendUpdateStatus({
        status: 'error',
        error: err?.message || String(err),
        latest_version: cachedUpdateVersion,
      });
    });
}

// Cloudflare R2（generic provider）— 由前端「检查更新」/ 启动频率门控触发
ipcMain.on('check-for-updates', () => {
  if (!app.isPackaged) {
    log.info('Update check skipped: app is not packaged');
    sendUpdateStatus({
      status: 'error',
      error: 'dev-mode',
    });
    return;
  }
  if (updateDownloadInFlight) {
    log.info('Update check skipped: download already in progress');
    sendUpdateStatus({
      status: 'downloading',
      latest_version: cachedUpdateVersion,
      release_notes: cachedReleaseNotes,
      error: '',
    });
    return;
  }
  updateUserCancelled = false;
  log.info('Update check requested (Cloudflare R2 / electron-updater)');
  autoUpdater.checkForUpdates().catch((err) => {
    if (updateUserCancelled) return;
    log.error('checkForUpdates failed:', err);
    sendUpdateStatus({
      status: 'error',
      error: err?.message || String(err),
    });
  });
});

ipcMain.on('cancel-update', () => {
  cancelUpdateDownload('user');
});

autoUpdater.on('checking-for-update', () => {
  log.info('Checking for update...');
  cachedUpdateVersion = null;
  cachedReleaseNotes = '';
  if (updateUserCancelled) return;
  sendUpdateStatus({ status: 'checking' });
});
autoUpdater.on('update-available', (info) => {
  log.info('Update available:', info?.version);
  cachedUpdateVersion = info?.version || null;
  cachedReleaseNotes = typeof info?.releaseNotes === 'string' ? info.releaseNotes : '';
  if (updateUserCancelled) {
    log.info('Ignore update-available after user cancel');
    return;
  }
  sendUpdateStatus({
    status: 'available',
    info,
    latest_version: cachedUpdateVersion,
    release_notes: cachedReleaseNotes,
  });
  // autoDownload=false：手动开始下载，才能取消
  startUpdateDownload();
});
autoUpdater.on('update-not-available', (info) => {
  log.info('Update not available.');
  cachedUpdateVersion = info?.version || null;
  if (updateUserCancelled) return;
  sendUpdateStatus({
    status: 'not-available',
    info,
    latest_version: cachedUpdateVersion,
  });
});
autoUpdater.on('error', (err) => {
  if (err instanceof CancellationError || updateUserCancelled) {
    log.info('Updater reported cancellation');
    updateDownloadInFlight = false;
    updateDownloadToken = null;
    sendUpdateStatus({
      status: 'cancelled',
      latest_version: cachedUpdateVersion,
      release_notes: cachedReleaseNotes,
    });
    return;
  }
  log.error('Error in auto-updater. ' + err);
  updateDownloadInFlight = false;
  sendUpdateStatus({
    status: 'error',
    error: err?.message || String(err),
    latest_version: cachedUpdateVersion,
  });
});
autoUpdater.on('download-progress', (progressObj) => {
  if (updateUserCancelled) return;
  log.info(
    `Download ${progressObj.percent?.toFixed?.(1) ?? progressObj.percent}% ` +
      `(${progressObj.transferred}/${progressObj.total}) @ ${progressObj.bytesPerSecond}/s`,
  );
  sendUpdateStatus({
    status: 'downloading',
    progress: progressObj,
    latest_version: cachedUpdateVersion,
    release_notes: cachedReleaseNotes,
  });
});
autoUpdater.on('update-cancelled', (info) => {
  log.info('update-cancelled', info?.version);
  updateDownloadInFlight = false;
  updateDownloadToken = null;
  clearUpdateInstallTimer();
  sendUpdateStatus({
    status: 'cancelled',
    latest_version: cachedUpdateVersion || info?.version || null,
    release_notes: cachedReleaseNotes,
  });
});
autoUpdater.on('update-downloaded', (info) => {
  if (updateUserCancelled) {
    log.info('Ignore update-downloaded after user cancel');
    return;
  }
  log.info('Update downloaded');
  updateDownloadInFlight = false;
  updateDownloadToken = null;
  if (info?.version) cachedUpdateVersion = info.version;
  if (typeof info?.releaseNotes === 'string') cachedReleaseNotes = info.releaseNotes;
  sendUpdateStatus({
    status: 'downloaded',
    info,
    latest_version: cachedUpdateVersion || info?.version || null,
    release_notes: cachedReleaseNotes || (typeof info?.releaseNotes === 'string' ? info.releaseNotes : ''),
  });
  clearUpdateInstallTimer();
  updateInstallTimer = setTimeout(function () {
    updateInstallTimer = null;
    if (updateUserCancelled) return;
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

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('show-item-in-folder', (_event, itemPath) => {
  if (typeof itemPath !== 'string' || !itemPath.trim()) return false;
  try {
    shell.showItemInFolder(path.resolve(itemPath));
    return true;
  } catch (error) {
    log.warn('[Shell] failed to reveal export output:', error);
    return false;
  }
});

ipcMain.handle('choose-directory', async (_event, requestedPath) => {
  const options = {
    title: 'Choose export folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  if (typeof requestedPath === 'string' && requestedPath.trim()) {
    const candidate = path.resolve(requestedPath.trim());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      options.defaultPath = candidate;
    }
  }
  try {
    const result = await dialog.showOpenDialog(mainWindow, options);
    return result.canceled ? '' : String(result.filePaths?.[0] || '');
  } catch (error) {
    log.warn('[Shell] failed to choose export directory:', error);
    return '';
  }
});

// 文件选择对话框 IPC handler
ipcMain.handle('show-open-dialog', async (event, options) => {
  if (!mainWindow) return { canceled: true, filePaths: [] };
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: options.filters || [{ name: 'Executable Files', extensions: ['exe'] }],
      defaultPath: options.defaultPath || '',
      title: options.title || '选择文件',
    });
    return result;
  } catch (e) {
    log.error('showOpenDialog error:', e);
    return { canceled: true, filePaths: [] };
  }
});

// 打开外部链接（使用系统默认浏览器）
ipcMain.handle('open-external', async (event, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch (e) {
    log.error('openExternal error:', e);
    return false;
  }
});
