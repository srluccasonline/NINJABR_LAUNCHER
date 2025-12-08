import { app, BrowserWindow, ipcMain } from 'electron';
import { chromium } from 'patchright';
import path from 'node:path';
import started from 'electron-squirrel-startup';

if (app.isPackaged) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, 'browsers');
} else {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, '../../browsers');
}

if (started) app.quit();

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault();
    }
  });

  mainWindow.loadURL("https://ninja-painel-dez-2025.vercel.app/");
};

app.on('ready', () => {
  createWindow();

  ipcMain.handle('launch-app', async (event, args) => {
    console.log("📥 [IPC] launch-app:", args.name);

    // Controle do Intervalo de Segurança
    let securityInterval: NodeJS.Timeout | null = null;

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

      // Helper para normalizar input (string ou array)
      const normalizeInput = (input: any): string[] => {
        if (!input) return [];
        if (Array.isArray(input)) return input;
        if (typeof input === 'string') return input.split('\n').map(s => s.trim()).filter(s => s);
        return [];
      };

      const normalizedUrlBlocks = normalizeInput(url_blocks);
      const normalizedUblockRules = normalizeInput(ublock_rules);

      // 1. Proxy
      let proxyConfig = undefined;
      if (proxy_data) {
        proxyConfig = {
          server: `${proxy_data.protocol}://${proxy_data.host}:${proxy_data.port}`,
          username: proxy_data.username,
          password: proxy_data.password
        };
      }

      // 2. LANÇAR NAVEGADOR
      const browser = await chromium.launch({ headless: false });

      // 3. CONTEXTO
      const contextOptions: any = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        proxy: proxyConfig,
        ignoreHTTPSErrors: true,
        viewport: null
      };

      // 4. Carregar Sessão
      if (SESSION_FILE_CONTENT) {
        console.log(`📂 Sessão encontrada.`);
        try {
          let storageState = typeof SESSION_FILE_CONTENT === 'string' ? JSON.parse(SESSION_FILE_CONTENT) : SESSION_FILE_CONTENT;
          if (storageState.session_data) storageState = storageState.session_data;
          if (storageState.cookies || storageState.origins) contextOptions.storageState = storageState;
        } catch (e) { console.error("❌ Erro sessão:", e); }
      }

      const context = await browser.newContext(contextOptions);

      // Bloquear atalho do DevTools (Ctrl+Shift+I) nas páginas do navegador lançado
      await context.addInitScript(() => {
        window.addEventListener('keydown', (event) => {
          if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'i') {
            event.preventDefault();
            event.stopPropagation();
          }
        }, true);
      });

      // =================================================================
      // --- SEGURANÇA MÁXIMA (CDP LEVEL) ---
      // =================================================================

      const isUrlForbidden = (url: string) => {
        const u = url.toLowerCase();
        if (u.startsWith('chrome://')) {
          // Permite apenas downloads e print
          if (u.startsWith('chrome://downloads') || u.startsWith('chrome://print')) return false;
          return true; // Bloqueia todo o resto
        }
        if (u.startsWith('devtools://')) return true;

        // Bloqueio extra via CDP (User List)
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

        const closeTarget = async (targetId: string, url: string) => {
          console.log(`🚫 [CDP] Bloqueando Target: ${url}`);
          try {
            await client.send('Target.closeTarget', { targetId });
          } catch (e) {
            // Target pode já ter fechado
          }
        };

        client.on('Target.targetCreated', async ({ targetInfo }) => {
          if (isUrlForbidden(targetInfo.url)) {
            await closeTarget(targetInfo.targetId, targetInfo.url);
          }
        });

        client.on('Target.targetInfoChanged', async ({ targetInfo }) => {
          if (isUrlForbidden(targetInfo.url)) {
            await closeTarget(targetInfo.targetId, targetInfo.url);
          }
        });

        console.log("🛡️ Segurança CDP Ativada");

      } catch (e) {
        console.error("❌ Falha ao iniciar CDP:", e);
      }

      // Mantém o handler de página apenas para interceptação de rede (WebStore)
      // e como fallback secundário
      const handlePage = async (p: any) => {
        try {
          await p.route('**chromewebstore.google.com**', (route: any) => route.abort());

          // Fallback visual (caso o CDP falhe por algum motivo)
          if (isUrlForbidden(p.url())) await p.close().catch(() => { });
          p.on('framenavigated', (f: any) => {
            if (isUrlForbidden(f.url())) p.close().catch(() => { });
          });

        } catch (e) { }
      };

      context.on('page', handlePage);
      context.pages().forEach(handlePage);



      // Bloqueio de URLs do usuário (Robust Route Matching)
      if (normalizedUrlBlocks.length > 0) {
        console.log(`🚫 Bloqueando ${normalizedUrlBlocks.length} padrões de URL.`);

        await context.route((url) => {
          const u = url.toString().toLowerCase();
          for (const block of normalizedUrlBlocks) {
            const cleanBlock = block.replace(/\*/g, '').toLowerCase();
            if (cleanBlock && u.includes(cleanBlock)) {
              console.log(`🚫 Aborted blocked URL: ${u} (Matched: ${cleanBlock})`);
              return true;
            }
          }
          return false;
        }, route => route.abort());
      }

      // =================================================================

      // Helper para parsear regras uBlock
      const parseUblockRules = (rules: string[]) => {
        return rules.map(r => {
          r = r.trim();
          if (!r || r.startsWith('!')) return null; // Ignora comentários e vazios

          if (r.includes('##')) {
            const [domain, selector] = r.split('##');
            return { domain: domain.trim(), selector: selector.trim() };
          }
          return { domain: '', selector: r }; // Regra global
        }).filter(r => r !== null) as { domain: string, selector: string }[];
      };

      const parsedRules = parseUblockRules(normalizedUblockRules);

      // CSS Injection (uBlock + Senha) - Aplicado ao CONTEXTO (todas as abas)
      await context.addInitScript(({ rules }) => {
        const currentHost = window.location.hostname;

        // Filtra regras que se aplicam a este domínio
        const activeSelectors = rules
          .filter(r => !r.domain || currentHost.includes(r.domain))
          .map(r => r.selector);

        const cssRules = activeSelectors.join(', ');

        let css = `input[type="password"] { -webkit-text-security: disc !important; user-select: none !important; filter: blur(2px); }`;
        if (cssRules) css += ` ${cssRules} { display: none !important; opacity: 0 !important; }`;

        const style = document.createElement('style');
        style.innerHTML = css;
        document.head.appendChild(style);

        document.addEventListener('copy', (e: any) => { if (e.target?.type === 'password') e.preventDefault(); }, true);
      }, { rules: parsedRules });

      if (parsedRules.length > 0) console.log(`🎨 ${parsedRules.length} regras de bloqueio visual carregadas.`);

      const page = await context.newPage();


      console.log(`Navegando para ${TARGET_URL}...`);
      try {
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e: any) {
        console.log(`⚠️ Navegação inicial: ${e.message}`);
        // Se foi abortado pelo usuário ou fechado, não é um erro crítico do sistema
        if (e.message.includes('ERR_ABORTED') || e.message.includes('Target closed')) {
          console.log("🛑 Navegação interrompida pelo usuário ou segurança.");
        }
      }

      await page.waitForTimeout(3000);

      let finalSessionData: any = null;
      let hasLoggedIn = false;

      // --- LOOP DE MONITORAMENTO ---
      await new Promise<void>(async (resolve) => {
        const selUser = login_selector || 'input[type="email"], input[name*="user"], input[name*="login"], input[name*="identifier"]';
        const selPass = password_selector || 'input[type="password"]';
        const selBtn = `button:has-text("Entrar"), button:has-text("Login"), button:has-text("Avançar"), button:has-text("Next"), input[type="submit"], #identifierNext, #passwordNext`;

        // Extrair hostname do alvo para restringir o auto-login
        let targetHostname = '';
        try { targetHostname = new URL(TARGET_URL).hostname; } catch { }

        while (true) {
          try {
            if (page.isClosed()) break;

            // Restrição de Domínio: Só tenta logar se estiver no domínio alvo
            const currentUrl = page.url();
            const isTargetDomain = targetHostname && currentUrl.includes(targetHostname);

            if (is_autofill_enabled && USER_EMAIL && USER_PASSWORD && !hasLoggedIn && isTargetDomain) {
              const isUserVis = await page.isVisible(selUser, { timeout: 500 }).catch(() => false);
              const isPassVis = await page.isVisible(selPass, { timeout: 500 }).catch(() => false);

              if (isUserVis || isPassVis) {
                if (isUserVis) {
                  const el = await page.$(selUser);
                  if (el && await el.inputValue() !== USER_EMAIL) {
                    await el.fill(USER_EMAIL);
                    if (!isPassVis) {
                      const btn = await page.$(selBtn);
                      if (btn && await btn.isVisible()) await btn.click();
                    }
                  }
                }
                const elPass = await page.$(selPass);
                if (elPass && await elPass.isVisible()) {
                  if (await elPass.inputValue() === '') {
                    console.log("🔑 Inserindo credenciais...");
                    await elPass.fill(USER_PASSWORD);
                    await page.waitForTimeout(500);
                    await elPass.press('Enter');
                    console.log("🚀 Login submetido.");
                    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => { });
                    hasLoggedIn = true;
                  }
                }
              }
            }
            await page.waitForTimeout(2000);
          } catch (error: any) {
            if (error.message.includes('Target closed')) break;
          }
        }

        // Limpa segurança ao sair
        if (securityInterval) clearInterval(securityInterval);

        if (save_strategy === 'always' && !context.pages()[0]?.isClosed()) {
          try { finalSessionData = await context.storageState(); } catch { }
        }
        else if (save_strategy === 'on_login' && hasLoggedIn && !context.pages()[0]?.isClosed()) {
          try { finalSessionData = await context.storageState(); } catch { }
        }

        resolve();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("app-closed", args.id);
        }
      });

      return { success: true, session_data: finalSessionData };

    } catch (error: any) {
      console.error("Erro:", error);
      if (securityInterval) clearInterval(securityInterval);
      return { success: false, error: error.message };
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });