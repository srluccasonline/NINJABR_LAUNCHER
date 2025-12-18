import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import type { Browser, Page, Download } from 'patchright';
import { chromium } from 'patchright';
import path from 'path';
import os from 'os';
import pkg from '../package.json';

const IS_DEV = process.env.DEV === 'true' || !app.isPackaged;

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

// ==========================================================
// 2. CONFIGURAÇÃO DE CAMINHOS DO BROWSER
// ==========================================================
const BROWSERS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'browsers')
  : path.join(__dirname, '../../browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(BROWSERS_PATH);

if (IS_DEV) {
  console.log(`🔧 [SETUP] Playwright Browsers Path: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
  console.log(`✅ [CHECK] Chromium Executable: ${chromium.executablePath()}`);
  console.log(`💻 [SYSTEM] OS: ${process.platform} | Arch: ${os.arch()} | Runtime Arch: ${process.arch}`);
}

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
    width: 1024,
    height: 768,
    title: windowTitle,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  mainWindow.setMenu(null);
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  // Restaurando a URL que apontava antigamente
  mainWindow.loadURL("https://ninja-painel-dez-2025.vercel.app/");
};

app.on('ready', createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('launch-app', async (event, args) => {
  if (IS_DEV) console.log("📥 [IPC] launch-app:", args.name);

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
      if (IS_DEV) console.log(`🌐 [PROXY] Usando: ${proxy_data.protocol}://${proxy_data.host}:${proxy_data.port} (User: ${proxy_data.username})`);
    }

    // LANÇAR NAVEGADOR
    // Removido 'channel' para usar o binário exato do PLAYWRIGHT_BROWSERS_PATH
    browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized']
    });
    activeBrowsers.add(browser);

    browser.on('disconnected', () => {
      if (browser) activeBrowsers.delete(browser);
    });

    const contextOptions: any = {
      proxy: proxyConfig,
      viewport: null,
      locale: 'pt-BR',
      acceptDownloads: true
    };

    if (SESSION_FILE_CONTENT) {
      try {
        let storageState = typeof SESSION_FILE_CONTENT === 'string' ? JSON.parse(SESSION_FILE_CONTENT) : SESSION_FILE_CONTENT;
        if (storageState.session_data) storageState = storageState.session_data;
        contextOptions.storageState = storageState;
        if (IS_DEV) console.log("📂 Sessão carregada.");
      } catch (e) { if (IS_DEV) console.error("❌ Erro sessão:", e); }
    }

    const context = await browser.newContext(contextOptions);
    context.setDefaultTimeout(60000); // 60 segundos de timeout global

    // =================================================================
    // DOMAIN LOCKING (WHITELIST)
    // =================================================================
    let allowedHost = '';
    try {
      allowedHost = new URL(TARGET_URL).hostname;
    } catch (e) { }

    if (allowedHost) {
      await context.route('**/*', (route, request) => {
        const url = request.url();
        const isNavigation = request.isNavigationRequest();
        const isMainFrame = request.frame() === null || request.frame()?.parentFrame() === null;

        if (isNavigation && isMainFrame) {
          try {
            const u = new URL(url);
            const currentHost = u.hostname.toLowerCase();

            // Permitir se for o mesmo host ou subdomínio
            const isAllowed = currentHost === allowedHost || currentHost.endsWith('.' + allowedHost);

            // Permitir about:blank e esquemas internos seguros
            const isSafeInternal = url === 'about:blank' || url.startsWith('blob:') || url.startsWith('data:');

            if (!isAllowed && !isSafeInternal) {
              if (IS_DEV) console.log(`🚫 [BLOCK] Navegação bloqueada: ${url} (Fora de ${allowedHost})`);
              return route.abort();
            }
          } catch (e) {
            return route.abort();
          }
        }
        return route.continue();
      });
    }


    // =================================================================
    // BROWSER-SIDE INJECTION
    // =================================================================

    // 2. Regras uBlock e Autofill (Dinâmico via evaluate)
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

          if (!document.getElementById('ninja-ublock-styles')) {
            const currentHost = window.location.hostname;
            const activeSelectors = rules
              .filter(r => !r.domain || currentHost.includes(r.domain))
              .map(r => r.selector);

            const cssRules = activeSelectors.join(', ');
            if (cssRules) {
              const style = document.createElement('style');
              style.id = 'ninja-ublock-styles';
              style.innerHTML = `${cssRules} { display: none !important; opacity: 0 !important; }`;
              (document.head || document.documentElement).appendChild(style);
            }
          }

          const win = window as any;
          if (!win.ninjaAutofillInitialized) {
            win.ninjaAutofillInitialized = true;
            if (isAutofill && user && pass) {
              let hasLoggedIn = false;
              const interval = setInterval(() => {
                if (hasLoggedIn) { clearInterval(interval); return; }
                const elUser = document.querySelector(selUser) as any;
                const elPass = document.querySelector(selPass) as any;
                if (elUser || elPass) {
                  if (elUser && elUser.value !== user) {
                    elUser.value = user;
                    elUser.dispatchEvent(new Event('input', { bubbles: true }));
                    elUser.dispatchEvent(new Event('change', { bubbles: true }));
                    if (!elPass) { const btn = document.querySelector(selBtn) as any; if (btn) btn.click(); }
                  }
                  const elPassActual = document.querySelector(selPass) as any;
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
        if (IS_DEV) console.log("📥 Download detectado:", download.suggestedFilename());
        if (mainWindow && !mainWindow.isDestroyed()) {
          const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
            title: 'Salvar Arquivo',
            defaultPath: path.join(app.getPath('downloads'), download.suggestedFilename()),
            buttonLabel: 'Salvar',
          });
          if (!canceled && filePath) {
            if (IS_DEV) console.log("💾 Salvando em:", filePath);
            await download.saveAs(filePath).catch(() => { });
            if (IS_DEV) console.log("✅ Download concluído.");
          } else {
            if (IS_DEV) console.log("❌ Download cancelado.");
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

    if (IS_DEV) console.log(`Navegando para ${TARGET_URL}...`);

    try {
      await page.goto(TARGET_URL, {
        timeout: 60000,
        waitUntil: 'domcontentloaded'
      });
    } catch (gotoError: any) {
      if (IS_DEV) console.error("⚠️ Erro no page.goto:", gotoError.message);
      // Não damos throw aqui para tentar manter a página aberta para o usuário ver o erro do browser
    }

    await new Promise<void>((resolve) => {
      page.on('close', () => { if (IS_DEV) console.log("🚪 Página fechada."); resolve(); });
      browser?.on('disconnected', () => { if (IS_DEV) console.log("🚪 Browser desconectado."); resolve(); });
    });

    let finalSessionData: any = null;
    if (save_strategy !== 'never') { try { finalSessionData = await context.storageState(); } catch { } }

    if (browser && browser.isConnected()) await browser.close();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app-closed", args.id);

    return { success: true, session_data: finalSessionData };

  } catch (error: any) {
    if (IS_DEV) console.error("Erro:", error);
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