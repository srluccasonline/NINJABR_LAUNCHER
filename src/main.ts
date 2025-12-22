import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import path from 'path';
import os from 'os';
import pkg from '../package.json';
import squirrelStartup from 'electron-squirrel-startup';
import { activeBrowsers } from './main/state';
import { handleLaunchApp } from './main/launch-handler';

// ==========================================================
// 1. AUTO UPDATE (SOMENTE WINDOWS)
// ==========================================================
if (process.platform === 'win32') {
  updateElectronApp({
    repo: 'srluccasonline/NINJABR_LAUNCHER',
    updateInterval: '10 minutes',
    notifyUser: true
  });
}

// Mantendo o limite de memória em 4GB para evitar OOM
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
app.commandLine.appendSwitch('disable-webrtc');
app.commandLine.appendSwitch('disable-features', 'WebRTC');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

if (squirrelStartup) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  const platformName = process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MAC' : 'LINUX';
  const archName = os.arch().toUpperCase();
  const windowTitle = `NINJABR - Versão ${pkg.version} - ${platformName} / ${archName}`;

  mainWindow = new BrowserWindow({
    width: 1720,
    height: 880,
    title: windowTitle,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // URL PRINCIPAL
  mainWindow.loadURL("https://ninja-hardfork-ultimo.vercel.app/?version=2017").catch(() => {
    const errorHtml = `
      <html>
      <head><meta charset="UTF-8"></head>
      <body style="font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #121212; color: #e0e0e0;">
        <div style="text-align: center; padding: 20px;">
          <h2 style="color: #ff5252; margin-bottom: 10px;">Problema de Conexão</h2>
          <p>Não foi possível conectar ao servidor.</p>
          <p style="font-size: 0.9em; opacity: 0.8;">Verifique sua internet.</p>
        </div>
      </body>
      </html>
    `;
    mainWindow?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
  });
};

app.on('ready', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('launch-app', async (event, args) => {
  return handleLaunchApp(event, args, mainWindow);
});

ipcMain.handle('apps:kill-all', async () => {
  for (const browser of activeBrowsers) { if (browser.isConnected()) await browser.close().catch(() => { }); }
  activeBrowsers.clear();
  return true;
});

ipcMain.handle('downloads:open-folder', async (event, filePath) => { if (filePath) shell.showItemInFolder(filePath); });