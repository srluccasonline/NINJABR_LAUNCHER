import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { updateElectronApp } from 'update-electron-app';
import type { Browser, Page, Download } from 'patchright';
import path from 'path';
import os from 'os';
import pkg from '../package.json';
import squirrelStartup from 'electron-squirrel-startup';

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

// IMPORTANT: Require 'patchright' AFTER setting the env var, otherwise it ignores the custom path!
const { chromium } = require('patchright');

if (IS_DEV) {
  console.log(`🔧 [SETUP] Playwright Browsers Path: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
  console.log(`✅ [CHECK] Chromium Executable: ${chromium.executablePath()}`);
  console.log(`💻 [SYSTEM] OS: ${process.platform} | Arch: ${os.arch()} | Runtime Arch: ${process.arch}`);
}

// Mantendo o limite de memória em 4GB para evitar OOM
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

if (squirrelStartup) {
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
      password_selector,
      is_debug = false // NOVA FLAG: Se true, desativa proteção de senha e bloqueio de URL
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
    const launchArgs = ['--start-maximized'];
    if (!is_debug) {
      launchArgs.push('--disable-devtools');
    }

    if (IS_DEV || is_debug) {
      try {
        console.log(`📂 [DEBUG] Listando arquivos em: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
        const files = require('fs').readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH);
        console.log(`📄 Arquivos encontrados: ${files.join(', ')}`);

        // Se houver subpastas (ex: chromium-1234), listar tbm
        files.forEach((f: string) => {
          const subPath = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH!, f);
          if (require('fs').statSync(subPath).isDirectory()) {
            console.log(`   📂 Dentro de ${f}: ${require('fs').readdirSync(subPath).join(', ')}`);
          }
        });
      } catch (e: any) {
        console.error(`❌ [DEBUG] Erro ao listar arquivos: ${e.message}`);
      }
    }

    browser = await chromium.launch({
      headless: false,
      args: launchArgs
    });
    activeBrowsers.add(browser);

    // =================================================================
    // BROWSER-LEVEL SECURITY BLOCK (DEVTOOLS KILLER) - NON-BLOCKING
    // =================================================================
    if (!is_debug) {
      try {
        const browserClient = await browser.newBrowserCDPSession();

        // Ativa auto-attach para monitorar novos alvos, mas SEM pausar no nascimento (waitForDebuggerOnStart: false)
        await browserClient.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true
        });

        browserClient.on('Target.attachedToTarget', async (params: any) => {
          const { targetInfo } = params;
          const url = targetInfo.url || '';
          const type = targetInfo.type;

          const isForbidden =
            type === 'devtools' ||
            url.startsWith('devtools://') ||
            url.startsWith('chrome://') ||
            url.startsWith('edge://');

          if (isForbidden) {
            if (IS_DEV) console.log(`🚫 [BROWSER-CDP] Matando alvo proibido: ${url} (${type})`);
            await browserClient.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => { });
          }
        });
      } catch (e) {
        if (IS_DEV) console.error("⚠️ Erro ao iniciar Browser-Level CDP:", e);
      }
    }

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
    // ZERO-DELAY UI LOCK - REMOVIDO addInitScript para evitar travamentos
    // =================================================================
    // Bloqueios de teclado movidos para o injectBrowserScript (page.evaluate)
    // Bloqueio de contextmenu removido a pedido do usuário para não travar downloads

    // =================================================================
    // CDP SECURITY (URL BLOCKING) - ATIVO APENAS SE NÃO FOR DEBUG
    // =================================================================
    if (!is_debug) {
      try {
        const page = await context.newPage(); // Create page first to get CDP session
        const client = await context.newCDPSession(page);
        await client.send('Target.setDiscoverTargets', { discover: true });

        const checkTarget = async (targetInfo: any) => {
          const url = targetInfo.url || '';
          const type = targetInfo.type;

          // CRITICAL: Allow downloads (type 'other' or empty URL often indicates download)
          if (type === 'other' || (type === 'page' && url === '')) {
            return;
          }

          const isForbidden =
            url.startsWith('chrome://') ||
            url.startsWith('devtools://') ||
            url.startsWith('edge://') ||
            (url.startsWith('about:') && url !== 'about:blank');

          if (isForbidden) {
            if (IS_DEV) console.log(`🚫 [CDP] Bloqueando alvo proibido: ${url}`);
            try {
              await client.send('Target.closeTarget', { targetId: targetInfo.targetId });
            } catch (e) { /* Ignore if already closed */ }
          }
        };

        client.on('Target.targetCreated', async (params: any) => checkTarget(params.targetInfo));

        // FIX: Substituindo targetInfoChanged por Polling para evitar Buffer Overflow em downloads
        // client.on('Target.targetInfoChanged', async (params: any) => checkTarget(params.targetInfo));

        setInterval(async () => {
          try {
            const pages = context.pages();
            for (const p of pages) {
              const url = p.url();
              const isForbidden =
                url.startsWith('chrome://') ||
                url.startsWith('devtools://') ||
                url.startsWith('edge://') ||
                url.startsWith('chrome-extension://') ||
                url.startsWith('edge-extension://');

              if (isForbidden) {
                if (IS_DEV) console.log(`🚫 [POLLING] Bloqueando URL proibida: ${url}`);
                await p.close().catch(() => { });
              }
            }
          } catch (e) { }
        }, 300); // Polling Ultra-Agressivo (300ms) para fechar inspeção instantaneamente

      } catch (e) {
        if (IS_DEV) console.error("⚠️ Falha ao iniciar CDP:", e);
      }
    } else {
      if (IS_DEV) console.log("⚠️ [DEBUG MODE] Proteções CDP (URL Blocking) DESATIVADAS.");
    }



    // =================================================================
    // DOMAIN LOCKING (WHITELIST) - DISABLED BY USER REQUEST
    // =================================================================
    // =================================================================
    // ROUTING SECURITY (FORBIDDEN URLS) - ATIVO APENAS SE NÃO FOR DEBUG
    // =================================================================
    if (!is_debug) {
      await context.route('devtools://**', route => route.abort());
      await context.route('chrome://**', route => route.abort());
      await context.route('edge://**', route => route.abort());
      await context.route('chrome-extension://**', route => route.abort());
      await context.route('edge-extension://**', route => route.abort());
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
          const { rules, user, pass, selUser, selPass, selBtn, isAutofill, isDebug } = params;

          // =================================================================
          // PASSWORD PROTECTION (BLUR & TYPE LOCK) - MOVIDO DE addInitScript PARA page.evaluate
          // =================================================================
          if (!isDebug) {
            const INJECT_ID = 'ninja-resilient-blur';

            const applyMarker = (root: Node = document) => {
              const processElement = (el: any) => {
                try {
                  const isPassword =
                    el.matches('input[type="password"]') ||
                    (el.matches('input') && (
                      (el.name && el.name.toLowerCase().includes('pass')) ||
                      (el.id && el.id.toLowerCase().includes('pass')) ||
                      (el.placeholder && el.placeholder.toLowerCase().includes('pass')) ||
                      (el.getAttribute('aria-label') && el.getAttribute('aria-label').toLowerCase().includes('pass'))
                    ));

                  if (isPassword) {
                    if (!el.hasAttribute('data-ninja-protected')) {
                      el.setAttribute('data-ninja-protected', 'true');
                    }
                    // RE-ASSERT STYLES ALWAYS (Prevent override by JS/CSS)
                    el.style.setProperty('filter', 'blur(8px)', 'important');
                    el.style.setProperty('-webkit-text-security', 'disc', 'important');
                    el.style.setProperty('text-security', 'disc', 'important');
                    el.style.setProperty('color', 'transparent', 'important');
                    el.style.setProperty('text-shadow', '0 0 8px rgba(0,0,0,0.5)', 'important');
                  }
                  if (el.shadowRoot) applyMarker(el.shadowRoot);
                } catch (e) { }
              };

              processElement(root);
              const allElements: any = (root as HTMLElement).querySelectorAll ? (root as HTMLElement).querySelectorAll('*') : [];
              allElements.forEach((el: any) => processElement(el));
            };

            if (!document.getElementById(INJECT_ID)) {
              const style = document.createElement('style');
              style.id = INJECT_ID;
              style.innerHTML = `
                html body input[type="password"], 
                html body input[data-ninja-protected="true"] {
                  filter: blur(8px) !important;
                  -webkit-text-security: disc !important;
                  text-security: disc !important;
                  color: transparent !important;
                  text-shadow: 0 0 8px rgba(0,0,0,0.5) !important;
                  border: 2px solid red !important;
                }
                input::-ms-reveal, input::-ms-clear, input::-webkit-credentials-auto-fill-button {
                  display: none !important;
                }
              `;
              (document.head || document.documentElement).appendChild(style);

              // 1. Initial Apply
              applyMarker();

              // 2. Observer (Now watching STYLE changes too)
              const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                  if (m.addedNodes.length) {
                    m.addedNodes.forEach(node => { if (node.nodeType === 1) applyMarker(node); });
                  }
                  if (m.type === 'attributes' && (m.target as HTMLElement).nodeName === 'INPUT') {
                    // Se mudar style ou type, reaplica proteção imediatamente
                    applyMarker(m.target);
                  }
                }
              });
              observer.observe(document.documentElement, {
                childList: true, subtree: true, attributes: true,
                attributeFilter: ['type', 'name', 'id', 'class', 'placeholder', 'aria-label', 'style']
              });

              // 3. Super Aggressive Polling (100ms)
              setInterval(() => applyMarker(), 1000); // Scan geral lento para novos elementos
              setInterval(() => {
                const enforceSecurity = (root: Node = document) => {
                  // Apenas elementos JÁ marcados para ser extremamente rápido
                  const query = 'input[data-ninja-protected="true"]';
                  const elements: any = (root as HTMLElement).querySelectorAll ? (root as HTMLElement).querySelectorAll(query) : [];

                  elements.forEach((el: any) => {
                    // 1. Força Tipo Password
                    if (el.type !== 'password') el.type = 'password';

                    // 2. Força Estilos (caso tenha sido removido via inline style)
                    if (el.style.filter !== 'blur(8px)') {
                      el.style.setProperty('filter', 'blur(8px)', 'important');
                      el.style.setProperty('-webkit-text-security', 'disc', 'important');
                      el.style.setProperty('text-security', 'disc', 'important');
                      el.style.setProperty('color', 'transparent', 'important');
                    }
                  });

                  // Recursão para Shadow DOM
                  const all = (root as HTMLElement).querySelectorAll ? (root as HTMLElement).querySelectorAll('*') : [];
                  all.forEach((el: any) => { if (el.shadowRoot) enforceSecurity(el.shadowRoot); });
                };
                enforceSecurity();
              }, 100); // 100ms polling para vencer qualquer script de reveal
            }
          }

          if (!isDebug) {
            // Bloqueio de Atalhos de Inspeção via evaluate
            window.addEventListener('keydown', (e) => {
              const isInspect =
                (e.key === 'F12') ||
                (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
                (e.ctrlKey && (e.key === 'u' || e.key === 'U'));
              if (isInspect) {
                e.preventDefault();
                e.stopPropagation();
              }
            }, true);

            // NOTA: O menu de contexto nativo permanece ativo para permitir downloads e outras ações legítimas.
          }

          // =================================================================
          // UBLOCK & AUTOFILL (EXISTENTES)
          // =================================================================
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
          isAutofill: is_autofill_enabled,
          isDebug: is_debug
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