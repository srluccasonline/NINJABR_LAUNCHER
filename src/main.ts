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
  mainWindow.loadURL("https://ninja-hardfork-ultimo.vercel.app");
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
      save_strategy = 'always',
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'sec-ch-ua': '"Not A;Brand";v="99", "Chromium";v="143", "Google Chrome";v="143"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      acceptDownloads: true
    };



    if (SESSION_FILE_CONTENT) {
      try {
        let storageState = typeof SESSION_FILE_CONTENT === 'string' ? JSON.parse(SESSION_FILE_CONTENT) : SESSION_FILE_CONTENT;
        if (storageState.session_data) storageState = storageState.session_data;
        contextOptions.storageState = storageState;


        if (IS_DEV) {
          const cookieCount = storageState.cookies?.length || 0;
          const originCount = storageState.origins?.length || 0;
          console.log(`📂 Sessão carregada. Cookies: ${cookieCount} | Origins: ${originCount}`);
        }
      } catch (e) { if (IS_DEV) console.error("❌ Erro ao carregar sessão:", e); }
    }

    const context = await browser.newContext(contextOptions);
    context.setDefaultTimeout(60000);



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

      // FIX 1: Bypass de CSP para o Google (Restaurado para garantir injeção de estilos)
      await context.route('**/*google.com/*', async route => {
        try {
          const response = await route.fetch();
          const headers = response.headers();
          delete headers['content-security-policy'];
          delete headers['x-frame-options'];
          await route.fulfill({ response, headers });
        } catch (e) {
          await route.continue().catch(() => { });
        }
      });

      // FIX 2: Bloqueios personalizados do frontend (url_blocks)
      if (normalizedUrlBlocks && normalizedUrlBlocks.length > 0) {
        if (IS_DEV) console.log(`🚫 [ROUTING] Bloqueando ${normalizedUrlBlocks.length} regras personalizadas.`);

        for (const raw of normalizedUrlBlocks) {
          try {
            let pattern = raw.trim();
            if (!pattern) continue;

            // Limpa o prefixo para a lógica de regex (protocolos e www opcionais)
            let clean = pattern;
            if (clean.includes('://')) clean = clean.split('://')[1];
            if (clean.startsWith('www.')) clean = clean.substring(4);

            // Escapa caracteres especiais de regex, mas deixa o * como wildcard
            // Esta regex vai cercar o domínio e garantir que www seja opcional
            const escaped = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&');

            let regexString: string;
            if (clean.includes('*')) {
              // Modo Wildcard: Converte * para .*
              regexString = `^https?://(www\\.)?${escaped.replace(/\*/g, '.*')}$`;
            } else {
              // Modo Rígido (Exato): Só bloqueia o que foi escrito (com slash opcional no final se for só o domínio)
              // Ex: facebook.com bloqueia facebook.com e www.facebook.com, mas NÃO facebook.com/mensagens
              regexString = `^https?://(www\\.)?${escaped}/?$`;
            }

            const routeRegex = new RegExp(regexString, 'i');

            // Registramos cada regra como uma rota individual para performance e precisão nativa do Playwright
            await context.route(routeRegex, route => {
              if (IS_DEV) console.log(`🚫 [BLOCKED] URL interceptada (Regex Match: ${pattern}): ${route.request().url()}`);
              route.abort();
            });
          } catch (e) {
            if (IS_DEV) console.error(`⚠️ Erro ao aplicar regra de bloqueio "${raw}":`, e);
          }
        }
      }
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

    // FUNCAO DO SCRIPT DE INJEÇÃO (AGORA USADA NO ADDINITSCRIPT)
    const injectionScriptContent = `
              const params = ${JSON.stringify({
      rules: parsedRules,
      user: USER_EMAIL,
      pass: USER_PASSWORD,
      selUser: login_selector || 'input[type="email"], input[name*="user"], input[name*="login"], input[name*="identifier"]',
      selPass: password_selector || 'input[type="password"]',
      selBtn: `button:has-text("Entrar"), button:has-text("Login"), button:has-text("Avançar"), button:has-text("Next"), input[type="submit"], #identifierNext, #passwordNext`,
      isAutofill: is_autofill_enabled,
      isDebug: is_debug
    })
      };

            const { rules, user, pass, selUser, selPass, selBtn, isAutofill, isDebug } = params;

            // =================================================================
            // NAVIGATOR SPOOFING (Win32)
            // =================================================================
            try {
              Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
              Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
            } catch (e) { }

            // =================================================================
            // PASSWORD PROTECTION (BLUR & TYPE LOCK)
            // =================================================================
            if (!isDebug) {
              const INJECT_ID = 'ninja-resilient-blur';

              const applyMarker = (root = document) => {
                const processElement = (el) => {
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
                const allElements = root.querySelectorAll ? root.querySelectorAll('*') : [];
                allElements.forEach((el) => processElement(el));
              };

              if (!document.getElementById(INJECT_ID)) {
                const style = document.createElement('style');
                style.id = INJECT_ID;
                style.innerHTML = \`
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
            \`;
            (document.head || document.documentElement).appendChild(style);

            // 1. Initial Apply
            applyMarker();

            // 2. Observer (Now watching STYLE changes too)
            const observer = new MutationObserver((mutations) => {
              for (const m of mutations) {
                if (m.addedNodes.length) {
                  m.addedNodes.forEach(node => { if (node.nodeType === 1) applyMarker(node); });
                }
                if (m.type === 'attributes' && m.target.nodeName === 'INPUT') {
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
            setInterval(() => applyMarker(), 1000); // Scan geral lento
            setInterval(() => {
              const enforceSecurity = (root = document) => {
                const query = 'input[data-ninja-protected="true"]';
                const elements = root.querySelectorAll ? root.querySelectorAll(query) : [];

                elements.forEach((el) => {
                  if (el.type !== 'password') el.type = 'password';
                  if (el.style.filter !== 'blur(8px)') {
                    el.style.setProperty('filter', 'blur(8px)', 'important');
                    el.style.setProperty('-webkit-text-security', 'disc', 'important');
                    el.style.setProperty('text-security', 'disc', 'important');
                    el.style.setProperty('color', 'transparent', 'important');
                  }
                });

                const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
                all.forEach((el) => { if (el.shadowRoot) enforceSecurity(el.shadowRoot); });
              };
              enforceSecurity();
            }, 100); 
          }
        }

        if (!isDebug) {
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
        }

        // ADICIONADO: Listeners de Foco para garantir proteção instantânea ao clicar
        window.addEventListener('focus', (e) => {
             if (e.target && (e.target.nodeName === 'INPUT')) {
                 const el = e.target;
                 // Google Specific Check
                 const isPass = el.type === 'password' || el.name === 'Passwd' || el.name === 'password' || (el.id && el.id.includes('pass'));
                 if (isPass) {
                     el.setAttribute('data-ninja-protected', 'true');
                     el.style.setProperty('filter', 'blur(8px)', 'important');
                     el.style.setProperty('-webkit-text-security', 'disc', 'important');
                     el.style.setProperty('text-security', 'disc', 'important');
                     el.style.setProperty('color', 'transparent', 'important');
                 }
             }
        }, true);

        // =================================================================
        // UBLOCK & AUTOFILL
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
            style.innerHTML = \`\${cssRules} { display: none !important; opacity: 0 !important; }\`;
            (document.head || document.documentElement).appendChild(style);
          }
        }

        const win = window;
        if (!win.ninjaAutofillInitialized) {
          win.ninjaAutofillInitialized = true;
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
        `;

    // FIX: Removido addInitScript (travava downloads). 
    // Usando page.evaluate com listeners robustos para garantir persistência.
    const injectProtection = async (p: Page) => {
      try {
        await p.evaluate(injectionScriptContent).catch(() => { });
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
      setupDownloadHandler(p);

      // RE-INJECTION ON NAVIGATION
      // Usamos apenas domcontentloaded e framenavigated para ser o mais rápido possível
      p.on('domcontentloaded', () => injectProtection(p));
      p.on('framenavigated', () => injectProtection(p));
    });

    const page = await context.newPage();

    if (IS_DEV) console.log(`Navegando para ${TARGET_URL}...`);

    try {
      await page.goto(TARGET_URL, {
        timeout: 60000,
        waitUntil: 'commit' // 'commit' é muito mais rápido que 'domcontentloaded'
      });
    } catch (gotoError: any) {
      if (IS_DEV) console.error("⚠️ Erro no page.goto:", gotoError.message);
      // Não damos throw aqui para tentar manter a página aberta para o usuário ver o erro do browser
    }

    // =================================================================
    // ROBUST SESSION SAVING (Last-Known-Good)
    // =================================================================
    let lastGoodSessionData: any = contextOptions.storageState || null;
    let saveInterval: NodeJS.Timeout | null = null;

    const tryCaptureSession = async (reason: string) => {
      if (save_strategy === 'never') return;
      if (!context || !browser || !browser.isConnected()) return;

      try {
        if (IS_DEV || is_debug) console.log(`💾 [SESSION] Salvando (${reason})...`);

        // SALVAMENTO COMPLETO: Conforme pedido pelo usuário
        const fullStorageState = await context.storageState();

        // Verifica se capturou algo de útil para não sobrescrever uma sessão boa com uma vazia
        const hasCookies = fullStorageState.cookies && fullStorageState.cookies.length > 0;
        const hasStorage = fullStorageState.origins && fullStorageState.origins.length > 0;

        if (hasCookies || hasStorage) {
          lastGoodSessionData = JSON.parse(JSON.stringify(fullStorageState)); // Deep Clone para garantir
          if (IS_DEV || is_debug) {
            console.log(`✅ [SESSION] Session Completa Capturada (${reason}). Cookies: ${fullStorageState.cookies?.length || 0} | Origins: ${fullStorageState.origins?.length || 0}`);
          }
        } else {
          if (IS_DEV || is_debug) console.log(`⚠️ [SESSION] Captura ignorada (${reason}): Sessão vazia.`);
        }
      } catch (e: any) {
        if (IS_DEV || is_debug) console.error(`⚠️ [SESSION] Falha ao salvar (${reason}):`, e.message);
      }
    };

    // 1. Salvar periodicamente DESATIVADO a pedido do usuário (salvar apenas no final)
    // if (save_strategy !== 'never') {
    //   saveInterval = setInterval(() => tryCaptureSession('periodic'), 30000);
    // }

    await new Promise<void>((resolve) => {
      page.on('close', async () => {
        if (IS_DEV) console.log("🚪 Página fechada.");
        // Tento salvar uma última vez ANTES de resolver (enquanto o browser ainda existe tecnicamente)
        await tryCaptureSession('page-close');
        resolve();
      });
      browser?.on('disconnected', () => {
        if (IS_DEV) console.log("🚪 Browser desconectado.");
        // Aqui já é tarde demais para salvar, usamos o lastGoodSessionData
        resolve();
      });
    });

    if (saveInterval) clearInterval(saveInterval);

    // Tenta uma captura final se o browser ainda estiver vivo
    // (Caso tenha fechado por page close mas o browser ainda esteja healthy)
    await tryCaptureSession('final-check');

    let finalSessionData = lastGoodSessionData;

    if (IS_DEV || is_debug) {
      const size = JSON.stringify(finalSessionData || {}).length;
      console.log(`🚀 [FINALIZE] Retornando sessão para o Frontend. Tamanho: ${size} caracteres.`);
    }

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