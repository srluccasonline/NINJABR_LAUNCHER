import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import type { Browser, Page, Download } from 'patchright';
import { chromium } from 'patchright';
import path from 'path';
import os from 'os';
import pkg from '../package.json';

// ==========================================================
// 1. AUTO UPDATE (SOMENTE WINDOWS)
// ==========================================================
if (process.platform === 'win32') {
  updateElectronApp({
    repo: 'srluccasonline/NINJABR_LAUNCHER',
    updateInterval: '1 hour',
    notifyUser: true
  });
}

// ==========================================================
// 2. CONFIGURAÇÃO DE CAMINHOS DO BROWSER
// ==========================================================
const BROWSERS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'browsers')
  : path.join(__dirname, '../../browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(BROWSERS_PATH);

console.log(`🔧 [SETUP] Playwright Browsers Path: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
console.log(`✅ [CHECK] Chromium Executable: ${chromium.executablePath()}`);
console.log(`💻 [SYSTEM] OS: ${process.platform} | Arch: ${os.arch()} | Runtime Arch: ${process.arch}`);

// Mantendo o limite de memória em 4GB para evitar OOM
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const activeBrowsers = new Set<Browser>();

const createWindow = () => {
  const platformName = process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MAC' : 'LINUX';
  const archName = os.arch().toUpperCase();
  const windowTitle = `NINJABR - Versão ${pkg.version} - ${platformName} / ${archName}`;

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    title: windowTitle,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

app.on('ready', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('launch-app', async (event, args) => {
  console.log("📥 [IPC] launch-app:", args.name);

  let browser: Browser | null = null;

  try {
    const {
      start_url: TARGET_URL,
      login: USER_EMAIL,
      password: USER_PASSWORD,
      proxy_data,
      session_data: SESSION_FILE_CONTENT,
      is_autofill_enabled,
      ublock_rules,
      url_blocks,
      save_strategy = 'never',
      login_selector,
      password_selector
    } = args;

    const normalizeInput = (input: any): string[] => {
      if (!input) return [];
      if (Array.isArray(input)) return input;
      if (typeof input === 'string') return input.split('\n').map(s => s.trim()).filter(s => s);
      return [];
    };

    const normalizedUrlBlocks = normalizeInput(url_blocks);
    const normalizedUblockRules = normalizeInput(ublock_rules);

    let proxyConfig = undefined;
    if (proxy_data) {
      proxyConfig = {
        server: `${proxy_data.protocol}://${proxy_data.host}:${proxy_data.port}`,
        username: proxy_data.username,
        password: proxy_data.password
      };
    }

    // LANÇAR NAVEGADOR
    // Removido 'channel' para usar o binário exato do PLAYWRIGHT_BROWSERS_PATH
    browser = await chromium.launch({
      headless: false
    });
    activeBrowsers.add(browser);

    browser.on('disconnected', () => {
      if (browser) activeBrowsers.delete(browser);
    });

    const contextOptions: any = {
      proxy: proxyConfig,
      viewport: { width: 1280, height: 720 },
      locale: 'pt-BR',
      acceptDownloads: true
    };

    if (SESSION_FILE_CONTENT) {
      try {
        let storageState = typeof SESSION_FILE_CONTENT === 'string' ? JSON.parse(SESSION_FILE_CONTENT) : SESSION_FILE_CONTENT;
        if (storageState.session_data) storageState = storageState.session_data;
        contextOptions.storageState = storageState;
        console.log("📂 Sessão carregada.");
      } catch (e) { console.error("❌ Erro sessão:", e); }
    }

    const context = await browser.newContext(contextOptions);

    // SEGURANÇA CDP
    const isUrlForbidden = (url: string) => {
      const u = url.toLowerCase();
      if (u.startsWith('chrome://')) {
        if (u.startsWith('chrome://downloads') || u.startsWith('chrome://print')) return false;
        return true;
      }
      if (u.startsWith('devtools://')) return true;
      if (u.includes('chromewebstore.google.com')) return true;
      if (normalizedUrlBlocks.length > 0) {
        for (const block of normalizedUrlBlocks) {
          const cleanBlock = block.replace(/\*/g, '').toLowerCase();
          if (cleanBlock && u.includes(cleanBlock)) return true;
        }
      }
      return false;
    };

    try {
      const client = await browser.newBrowserCDPSession();
      await client.send('Target.setDiscoverTargets', { discover: true });
      client.on('Target.targetCreated', async ({ targetInfo }) => {
        if (isUrlForbidden(targetInfo.url)) {
          try { await client.send('Target.closeTarget', { targetId: targetInfo.targetId }); } catch (e) { }
        }
      });
      client.on('Target.targetInfoChanged', async ({ targetInfo }) => {
        if (isUrlForbidden(targetInfo.url)) {
          try { await client.send('Target.closeTarget', { targetId: targetInfo.targetId }); } catch (e) { }
        }
      });
      console.log("🛡️ Segurança CDP Ativada");
    } catch (e) { console.error("❌ Falha CDP:", e); }

    // BROWSER-SIDE INJECTION
    const parseUblockRules = (rules: string[]) => {
      return rules.map(r => {
        r = r.trim();
        if (!r || r.startsWith('!')) return null;
        if (r.includes('##')) {
          const [domain, selector] = r.split('##');
          return { domain: domain.trim(), selector: selector.trim() };
        }
        return { domain: '', selector: r };
      }).filter(r => r !== null) as { domain: string, selector: string }[];
    };

    const parsedRules = parseUblockRules(normalizedUblockRules);

    const injectBrowserScript = async (p: Page) => {
      try {
        await p.evaluate((params) => {
          const { rules, user, pass, selUser, selPass, selBtn, isAutofill } = params;
          if (!document.getElementById('ninja-injected-styles')) {
            const currentHost = window.location.hostname;
            const activeSelectors = rules.filter(r => !r.domain || currentHost.includes(r.domain)).map(r => r.selector);
            const cssRules = activeSelectors.join(', ');
            let css = `input[type="password"], input[data-protected-password="true"] { -webkit-text-security: disc !important; text-security: disc !important; user-select: none !important; filter: blur(5px) !important; }`;
            if (cssRules) css += ` ${cssRules} { display: none !important; opacity: 0 !important; }`;
            const style = document.createElement('style');
            style.id = 'ninja-injected-styles';
            style.innerHTML = css;
            (document.head || document.documentElement).appendChild(style);
          }
          if (!window.ninjaInitialized) {
            window.ninjaInitialized = true;
            document.addEventListener('copy', (e) => { if (e.target?.type === 'password') e.preventDefault(); }, true);
            const protect = (el) => {
              if (el.tagName === 'INPUT') {
                if (el.type === 'password') el.setAttribute('data-protected-password', 'true');
                if (el.getAttribute('data-protected-password') === 'true' && el.type !== 'password') el.type = 'password';
              }
            };
            const observer = new MutationObserver((mutations) => {
              for (const m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'type') protect(m.target);
                if (m.type === 'childList') {
                  m.addedNodes.forEach((node) => {
                    if (node.tagName === 'INPUT') protect(node);
                    if (node.querySelectorAll) node.querySelectorAll('input').forEach(protect);
                  });
                }
              }
            });
            observer.observe(document.documentElement, { attributes: true, attributeFilter: ['type'], childList: true, subtree: true });
            document.querySelectorAll('input').forEach(protect);
            if (isAutofill && user && pass) {
              let hasLoggedIn = false;
              const interval = setInterval(() => {
                if (hasLoggedIn) { clearInterval(interval); return; }
                const elUser = document.querySelector(selUser);
                const elPass = document.querySelector(selPass);
                if (elUser || elPass) {
                  if (elUser && elUser.value !== user) {
                    elUser.value = user;
                    elUser.dispatchEvent(new Event('input', { bubbles: true }));
                    elUser.dispatchEvent(new Event('change', { bubbles: true }));
                    if (!elPass) { const btn = document.querySelector(selBtn); if (btn) btn.click(); }
                  }
                  const elPassActual = document.querySelector(selPass);
                  if (elPassActual && elPassActual.value === '') {
                    elPassActual.value = pass;
                    elPassActual.dispatchEvent(new Event('input', { bubbles: true }));
                    elPassActual.dispatchEvent(new Event('change', { bubbles: true }));
                    setTimeout(() => { elPassActual.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); }, 500);
                    hasLoggedIn = true;
                  }
                }
              }, 2000);
            }
          }
        }, {
          rules: parsedRules,
          user: USER_EMAIL,
          pass: USER_PASSWORD,
          selUser: login_selector || 'input[type="email"], input[name*="user"], input[name*="login"], input[name*="identifier"]',
          selPass: password_selector || 'input[type="password"]',
          selBtn: `button:has-text("Entrar"), button:has-text("Login"), button:has-text("Avançar"), button:has-text("Next"), input[type="submit"], #identifierNext, #passwordNext`,
          isAutofill: is_autofill_enabled
        });
      } catch (e) { }
    };

    // DOWNLOAD HANDLER
    const setupDownloadHandler = (p: Page) => {
      p.on('download', async (download: Download) => {
        console.log("📥 Download detectado:", download.suggestedFilename());
        if (mainWindow && !mainWindow.isDestroyed()) {
          const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
            title: 'Salvar Arquivo',
            defaultPath: path.join(app.getPath('downloads'), download.suggestedFilename()),
            buttonLabel: 'Salvar',
          });
          if (!canceled && filePath) {
            console.log("💾 Salvando em:", filePath);
            await download.saveAs(filePath).catch(() => { });
            console.log("✅ Download concluído.");
          } else {
            console.log("❌ Download cancelado.");
            await download.cancel().catch(() => { });
          }
        } else {
          const defaultPath = path.join(app.getPath('downloads'), download.suggestedFilename());
          await download.saveAs(defaultPath).catch(() => { });
        }
      });
    };

    context.on('page', (p) => {
      p.on('domcontentloaded', () => injectBrowserScript(p));
      p.on('framenavigated', () => injectBrowserScript(p));
      setupDownloadHandler(p);
    });

    const page = await context.newPage();
    console.log(`Navegando para ${TARGET_URL}...`);
    await page.goto(TARGET_URL);

    await new Promise<void>((resolve) => {
      page.on('close', () => { console.log("🚪 Página fechada."); resolve(); });
      browser?.on('disconnected', () => { console.log("🚪 Browser desconectado."); resolve(); });
    });

    let finalSessionData: any = null;
    if (save_strategy !== 'never') { try { finalSessionData = await context.storageState(); } catch { } }

    if (browser && browser.isConnected()) await browser.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app-closed", args.id);

    return { success: true, session_data: finalSessionData };

  } catch (error: any) {
    console.error("Erro:", error);
    if (browser && browser.isConnected()) await browser.close().catch(() => { });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('apps:kill-all', async () => {
  for (const browser of activeBrowsers) { if (browser.isConnected()) await browser.close().catch(() => { }); }
  activeBrowsers.clear();
  return true;
});

ipcMain.handle('downloads:open-folder', async (event, filePath) => { if (filePath) shell.showItemInFolder(filePath); });