'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const settings = require('./settings');
const network = require('./network');
const pipeline = require('./pipeline');
const { createServer } = require('./server');

let win = null;
let server = null;

/* ------------------------------------------------------------------ */
/* 接続情報                                                            */
/* ------------------------------------------------------------------ */

function currentAddress() {
  const s = settings.get();
  const candidates = network.listCandidates();
  // 設定で選ばれたアドレスがまだ存在するなら、それを尊重する
  if (s.preferredAddress && candidates.some((c) => c.address === s.preferredAddress)) {
    return s.preferredAddress;
  }
  return candidates.length ? candidates[0].address : '127.0.0.1';
}

function connectUrl() {
  const info = server.info();
  if (!info.running) return null;
  return `http://${currentAddress()}:${info.port}/?t=${info.pin}`;
}

async function buildState() {
  const s = settings.get();
  const info = server.info();
  const url = connectUrl();

  let qr = null;
  if (url) {
    try {
      const QRCode = require('qrcode');
      qr = await QRCode.toDataURL(url, {
        margin: 1,
        width: 420,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000ff', light: '#ffffffff' }
      });
    } catch (err) {
      console.error('[main] QR の生成に失敗:', err.message);
    }
  }

  return {
    running: info.running,
    port: info.port,
    pin: info.pin,
    url,
    qr,
    address: currentAddress(),
    addresses: network.listCandidates(),
    settings: {
      saveDir: s.saveDir,
      port: s.port,
      jpegQuality: s.jpegQuality,
      useDateFolders: s.useDateFolders
    }
  };
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  buildState().then((state) => {
    if (win && !win.isDestroyed()) win.webContents.send('state', state);
  });
}

function emit(event, payload) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('transfer', { event, payload });
}

/* ------------------------------------------------------------------ */
/* ウィンドウ                                                          */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'iPhone 写真取り込み',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('get-state', () => buildState());

  ipcMain.handle('server:start', async () => {
    try {
      await server.start();
      return await buildState();
    } catch (err) {
      return { error: err.message, ...(await buildState()) };
    }
  });

  ipcMain.handle('server:stop', async () => {
    await server.stop();
    return buildState();
  });

  ipcMain.handle('settings:set', async (_e, patch) => {
    const allowed = {};
    if (typeof patch.preferredAddress === 'string') allowed.preferredAddress = patch.preferredAddress;
    if (typeof patch.useDateFolders === 'boolean') allowed.useDateFolders = patch.useDateFolders;
    if (typeof patch.jpegQuality === 'number') {
      allowed.jpegQuality = Math.min(1, Math.max(0.5, patch.jpegQuality));
    }
    if (typeof patch.port === 'number' && patch.port >= 1024 && patch.port <= 65535) {
      allowed.port = Math.floor(patch.port);
    }
    settings.set(allowed);
    return buildState();
  });

  ipcMain.handle('settings:pick-dir', async () => {
    const s = settings.get();
    const r = await dialog.showOpenDialog(win, {
      title: '保存先フォルダを選択',
      defaultPath: s.saveDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return buildState();

    settings.set({ saveDir: r.filePaths[0] });
    // 保存先が変わったら重複台帳も差し替える
    if (server.isRunning()) await pipeline.setSaveDir(r.filePaths[0]);
    return buildState();
  });

  ipcMain.handle('shell:open-dir', async () => {
    const s = settings.get();
    const err = await shell.openPath(s.saveDir);
    return err || null;
  });

  ipcMain.handle('shell:show-item', (_e, filePath) => {
    if (typeof filePath === 'string' && filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('shell:open-item', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return null;
    const err = await shell.openPath(filePath);
    return err || null;
  });

  ipcMain.handle('refresh-addresses', () => buildState());
}

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    settings.init(app);

    server = createServer({
      getSettings: () => settings.get(),
      emit
    });

    registerIpc();
    createWindow();

    // 起動したらすぐ使えるように、自動で待受を開始する
    try {
      await server.start();
    } catch (err) {
      console.error('[main] サーバーの起動に失敗:', err.message);
    }
    pushState();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', async () => {
    if (server) await server.stop().catch(() => {});
  });
}
