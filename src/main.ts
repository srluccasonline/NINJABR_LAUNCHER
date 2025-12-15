import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import fs from 'fs';
import { updateElectronApp } from 'update-electron-app';
import type { Browser } from 'patchright';
import path from 'node:path';
import started from 'electron-squirrel-startup';

// ==========================================================
// 1. AUTO UPDATE (SOMENTE WINDOWS)
// ==========================================================


// Evita crash no Mac por falta de assinatura
if (process.platform === 'win32') {
  updateElectronApp({
    repo: 'srluccasonline/NINJABR_LAUNCHER',
    updateInterval: '1 hour',
    notifyUser: true
  });
}

// ==========================================================
// 2. CONFIGURAÇÃO DE CAMINHOS
// ==========================================================
const BROWSERS_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'browsers')
  : path.join(__dirname, '../../browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(BROWSERS_PATH);

console.log(`🔧 [SETUP] Playwright Browsers Path set to: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);

const { chromium } = require('patchright');

console.log(`✅ [CHECK] Chromium Executable Path: ${chromium.executablePath()}`);

if (started) app.quit();

let mainWindow: BrowserWindow | null = null;
const activeBrowsers = new Set<Browser>();

// ==========================================================
// 3. HANDLER DO LAUNCH-APP (AGORA NO ESCOPO GLOBAL)
// ==========================================================
// Mover para fora do 'ready' corrige o erro "No handle registered"
ipcMain.handle('launch-app', async (event, args) => {
  console.log("📥 [IPC] launch-app:", args.name);

  // Controle do Intervalo de Segurança
  let securityInterval: NodeJS.Timeout | null = null;
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
    browser = await chromium.launch({ headless: false });
    activeBrowsers.add(browser);

    browser.on('disconnected', () => {
      if (browser) activeBrowsers.delete(browser);
    });

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

      // Aumentado blur para 5px e adicionado regras para inputs protegidos
      let css = `
        input[type="password"], input[data-protected-password="true"] { 
          -webkit-text-security: disc !important; 
          text-security: disc !important;
          user-select: none !important; 
          filter: blur(5px) !important; 
        }
      `;
      if (cssRules) css += ` ${cssRules} { display: none !important; opacity: 0 !important; }`;

      const style = document.createElement('style');
      style.innerHTML = css;
      (document.head || document.documentElement).appendChild(style);

      document.addEventListener('copy', (e: any) => { if (e.target?.type === 'password') e.preventDefault(); }, true);

      // --- PROTEÇÃO CONTRA REVEAL (OLHO MÁGICO) ---
      // Impede que o type="password" seja alterado para "text"
      const enforcePasswordType = () => {
        const protect = (el: any) => {
          if (el.tagName === 'INPUT') {
            // Se for password, marca como protegido
            if (el.type === 'password') {
              el.setAttribute('data-protected-password', 'true');
            }
            // Se estiver marcado como protegido mas não for password (ex: mudou para text), força voltar
            if (el.getAttribute('data-protected-password') === 'true' && el.type !== 'password') {
              console.log('🛡️ Tentativa de revelar senha bloqueada!');
              el.type = 'password';
            }
          }
        };

        const observer = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.attributeName === 'type') {
              protect(m.target);
            }
            if (m.type === 'childList') {
              m.addedNodes.forEach((node: any) => {
                if (node.tagName === 'INPUT') protect(node);
                if (node.querySelectorAll) node.querySelectorAll('input').forEach(protect);
              });
            }
          }
        });

        // Inicia observação assim que possível
        const start = () => {
          if (document.body) {
            observer.observe(document.body, { attributes: true, attributeFilter: ['type'], childList: true, subtree: true });
            document.querySelectorAll('input').forEach(protect);
          } else {
            // Se body ainda não existe, tenta novamente em breve ou no DOMContentLoaded
            requestAnimationFrame(start);
          }
        };

        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', start);
        } else {
          start();
        }
      };
      enforcePasswordType();

    }, { rules: parsedRules });

    if (parsedRules.length > 0) console.log(`🎨 ${parsedRules.length} regras de bloqueio visual carregadas.`);

    const page = await context.newPage();


    // 5. Monitoramento de Fechamento da Página
    page.on('close', async () => {
      console.log("❌ Página principal fechada. Encerrando navegador...");
      try {
        if (browser?.isConnected()) {
          await browser.close();
        }
      } catch (e) {
        // Ignora erros se já estiver fechando
      }
    });

    // Map para guardar tamanho dos arquivos (URL -> Content-Length)
    const urlSizes = new Map<string, number>();

    page.on('response', async (response) => {
      try {
        const url = response.url();
        const headers = response.headers();
        const len = headers['content-length'];
        if (len) {
          urlSizes.set(url, parseInt(len, 10));
        }
      } catch (e) { }
    });

    // 6. Gerenciamento de Downloads (Save As + Progresso + UI Injetada)
    page.on('download', async (download) => {
      const suggestedFilename = download.suggestedFilename();
      const url = download.url();
      const totalBytes = urlSizes.get(url) || 0;
      const downloadId = `dl-${Date.now()}`; // ID único para o elemento DOM

      console.log(`⬇️ Download iniciado: ${suggestedFilename} (Total: ${totalBytes} bytes)`);

      // --- INJETAR UI DE DOWNLOAD ---
      try {
        await page.evaluate(({ id, filename }) => {
          const div = document.createElement('div');
          div.id = id;
          div.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; width: 320px;
            background: #1e1e1e; color: #fff; padding: 15px;
            border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            font-family: sans-serif; z-index: 999999; display: flex; flex-direction: column; gap: 8px;
            border: 1px solid #333; transition: all 0.3s ease;
          `;
          div.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <strong style="font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px;">${filename}</strong>
              <button onclick="this.parentElement.parentElement.remove()" style="background:none; border:none; color:#888; cursor:pointer; font-size:16px;">&times;</button>
            </div>
            <div style="background:#333; height:6px; border-radius:3px; overflow:hidden;">
              <div id="${id}-bar" style="width:0%; height:100%; background:#10b981; transition: width 0.2s;"></div>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; color:#aaa;">
              <span id="${id}-status">Baixando...</span>
              <span id="${id}-percent">0%</span>
            </div>
            <button id="${id}-btn" style="display:none; margin-top:5px; background:#3b82f6; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:12px;">
              Abrir Pasta
            </button>
          `;
          document.body.appendChild(div);
        }, { id: downloadId, filename: suggestedFilename });
      } catch (e) { console.error("Erro ao injetar UI:", e); }

      try {
        const { filePath, canceled } = await dialog.showSaveDialog({
          defaultPath: suggestedFilename,
          title: 'Salvar arquivo',
          buttonLabel: 'Salvar'
        });

        if (canceled || !filePath) {
          console.log("🚫 Download cancelado pelo usuário.");
          await download.cancel();
          // Remove UI se cancelado
          await page.evaluate((id) => document.getElementById(id)?.remove(), downloadId).catch(() => { });
          return;
        }

        console.log(`💾 Salvando em: ${filePath}`);

        // Inicia Stream
        const stream = await download.createReadStream();
        const writer = fs.createWriteStream(filePath);

        let downloadedBytes = 0;

        stream.on('data', (chunk) => {
          downloadedBytes += chunk.length;

          if (totalBytes > 0) {
            const progress = downloadedBytes / totalBytes;
            const percent = Math.round(progress * 100);

            // Atualiza barra de tarefas
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(progress);

            // Atualiza UI Injetada (throttled via page.evaluate pode ser pesado, mas ok para local)
            // Fazemos um check simples para não spammar o evaluate a cada chunk
            if (percent % 5 === 0) {
              page.evaluate(({ id, p }) => {
                const bar = document.getElementById(`${id}-bar`);
                const txt = document.getElementById(`${id}-percent`);
                if (bar) bar.style.width = `${p}%`;
                if (txt) txt.innerText = `${p}%`;
              }, { id: downloadId, p: percent }).catch(() => { });
            }
          }
        });

        stream.on('end', async () => {
          console.log("✅ Download concluído.");
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setProgressBar(-1);
            mainWindow.flashFrame(true);
          }

          // Atualiza UI para Sucesso e Botão Abrir
          await page.evaluate(({ id, path }) => {
            const bar = document.getElementById(`${id}-bar`);
            const status = document.getElementById(`${id}-status`);
            const btn = document.getElementById(`${id}-btn`);
            if (bar) { bar.style.background = '#3b82f6'; bar.style.width = '100%'; }
            if (status) { status.innerText = 'Concluído'; status.style.color = '#3b82f6'; }
            if (btn) {
              btn.style.display = 'block';
              btn.onclick = () => window.electronAPI.openDownloadFolder(path);
            }
            // Auto-remove após 10s se não interagir
            setTimeout(() => {
              const el = document.getElementById(id);
              if (el) { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }
            }, 10000);
          }, { id: downloadId, path: filePath }).catch(() => { });
        });

        stream.pipe(writer);

      } catch (err) {
        console.error("❌ Erro no download:", err);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setProgressBar(-1);

        // Atualiza UI para Erro
        await page.evaluate((id) => {
          const status = document.getElementById(`${id}-status`);
          if (status) { status.innerText = 'Erro no Download'; status.style.color = '#ef4444'; }
        }, downloadId).catch(() => { });
      }
    });

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

    // Safer wait
    if (!page.isClosed()) {
      await page.waitForTimeout(3000).catch(() => { });
    }

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
          if (!browser?.isConnected()) break;

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
          if (error.message.includes('Target closed') || error.message.includes('browser has been closed')) break;
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

    // Cleanup explícito ao fim da sessão
    try {
      if (browser && browser.isConnected()) {
        await browser.close();
      }
    } catch (e) {
      console.error("Erro ao fechar navegador no cleanup final:", e);
    }

    return { success: true, session_data: finalSessionData };

  } catch (error: any) {
    console.error("Erro:", error);
    if (securityInterval) clearInterval(securityInterval);
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => { });
    }
    return { success: false, error: error.message };
  }
});

// ==========================================================
// KILL SWITCH (FECHAR TUDO)
// ==========================================================
ipcMain.handle('apps:kill-all', async () => {
  if (activeBrowsers.size === 0) return true;

  console.log(`☠️ KILL SWITCH ATIVADO: Fechando ${activeBrowsers.size} apps...`);
  const promises = [];
  for (const browser of activeBrowsers) {
    if (browser.isConnected()) {
      promises.push(browser.close().catch(e => console.error("Erro ao fechar no kill-switch:", e)));
    }
  }
  await Promise.all(promises);
  activeBrowsers.clear();
  return true;
});

// ==========================================================
// DOWNLOAD HELPER (ABRIR PASTA)
// ==========================================================
ipcMain.handle('downloads:open-folder', async (event, filePath) => {
  if (filePath) {
    shell.showItemInFolder(filePath);
  }
});

// ==========================================================
// 4. CRIAÇÃO DA JANELA
// ==========================================================
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

  //mainWindow.loadURL("http://localhost:3000/");
  mainWindow.loadURL("https://ninja-painel-dez-2025.vercel.app/");
};

// ==========================================================
// 5. LIFECYCLE
// ==========================================================
app.on('ready', () => {
  createWindow();
  // O ipcMain.handle já foi registrado lá em cima, não precisa estar aqui
});

app.on('before-quit', async (e) => {
  // Fecha todos os navegadores abertos antes de sair
  console.log(`🛑 Fechando ${activeBrowsers.size} navegadores ativos...`);
  for (const browser of activeBrowsers) {
    try {
      await browser.close();
    } catch (err) {
      console.error("Erro ao fechar navegador no quit:", err);
    }
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });