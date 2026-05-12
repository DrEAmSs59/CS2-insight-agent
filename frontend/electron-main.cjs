const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

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
      contextIsolation: true
    }
  });

  mainWindow.setMenu(null); // 显式移除原生菜单

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools(); // 在开发模式下打开开发者工具
  } else {
    // 在生产环境中，我们假设 Python 后端正在提供前端服务
    // URL 应该是 http://127.0.0.1:19871
    // 我们可以轮询或等待服务器准备就绪
    const loadBackend = () => {
      mainWindow.loadURL('http://127.0.0.1:19871').catch((err) => {
        console.error('加载后端 URL 失败，正在重试...', err);
        setTimeout(loadBackend, 1000);
      });
    };
    loadBackend();
  }

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximize-change', true);
  });
  
  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximize-change', false);
  });
}

function startBackend() {
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  
  if (isDev) {
    // 在开发模式下，您通常手动启动后端，或者我们可以在这里启动它
    console.log('在开发模式下运行。假设后端单独启动或使用代理。');
    return;
  }

  // 在生产环境中，找到 python 可执行文件并启动后端
  // 目录结构预计与便携版本类似
  // 如果 electron 应用程序已打包，extraResources 会在 process.resourcesPath 中
  
  const baseDir = isDev ? path.join(__dirname, '..') : process.resourcesPath;

  const pythonExe = path.join(baseDir, 'python', 'python.exe');
  const runServerPy = path.join(baseDir, 'backend', 'app', 'run_server.py');

  const userDataPath = app.getPath('userData');
  const configPath = path.join(userDataPath, 'cs2-insight.config.json');
  const logsPath = path.join(userDataPath, 'logs');

  if (fs.existsSync(pythonExe) && fs.existsSync(runServerPy)) {
    console.log('从以下位置启动 Python 后端:', pythonExe);
    console.log('用户数据目录:', userDataPath);
    backendProcess = spawn(pythonExe, [runServerPy], {
      cwd: path.join(baseDir, 'backend'),
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
  startBackend();
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProcess) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', backendProcess.pid, '/f', '/t']);
    } else {
      backendProcess.kill();
    }
  }
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
