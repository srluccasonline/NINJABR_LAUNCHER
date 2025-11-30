// ARQUIVO: src/main.ts
import { app, BrowserWindow, ipcMain, Menu, session } from "electron";
import path from "node:path";

// Nota: 'electron-squirrel-startup' não precisa ser importado se for usado apenas no topo
// import started from "electron-squirrel-startup"; 

// --- CONFIGURAÇÃO ---
const API_URL = "https://nvukznijjllgyuyrswhy.supabase.co/functions/v1/app-manager";

// if (started) { app.quit(); } // Mantido como referência

// Variáveis Globais
let mainWindow: BrowserWindow | null = null;
let proxyAuthListenerAdded = false;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Ninja Browser Manager",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
    autoHideMenuBar: true,
  });

  const remoteUrl = "https://ninjabrfull.vercel.app";
  mainWindow.loadURL(remoteUrl);

  Menu.setApplicationMenu(null);
  mainWindow.removeMenu();

  // mainWindow.webContents.openDevTools(); 
};

// =========================================================================
// FUNÇÃO ÚNICA: ADICIONAR HANDLER DE AUTENTICAÇÃO DE PROXY GLOBAL
// =========================================================================
function setupProxyAuthHandler(username?: string, password?: string) {
    if (proxyAuthListenerAdded) return;

    app.on('login', (event, webContents, request, authInfo, callback) => {
        // Esta função é chamada para qualquer autenticação de proxy
        if (authInfo.isProxy && username && password) {
            console.log(`[Electron AUTH] Credenciais sendo enviadas para ${authInfo.host}`);
            event.preventDefault();
            callback(username, password);
        } else {
            // Permite que o popup de login nativo do Electron apareça se não tiver credenciais
            callback(); 
        }
    });

    proxyAuthListenerAdded = true;
}

app.on("ready", () => {
  createWindow();

  // Configura o handler global de proxy logo no início
  // (As credenciais reais são setadas na sessão pelo ipcMain.handle)
  setupProxyAuthHandler(); 

  // ============================================================
  // HANDLER: LAUNCH APP
  // ============================================================
  ipcMain.handle("launch-app", async (event, { appId, token }) => {
    try {
      console.log(`[Electron] Solicitado lançamento do App ID: ${appId}`);

      // 1. BUSCAR CONFIGURAÇÃO NA EDGE FUNCTION
      const response = await fetch(
        `${API_URL}?target=apps&action=launch&id=${appId}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.ok) throw new Error(`Erro API: ${response.statusText}`);
      const data = await response.json();
      const { app_config, network, session: sessionInfo } = data;

      // 2. CONFIGURAR SESSÃO ISOLADA (PARTITION)
      const partitionName = `persist:app_${appId}`;
      const appSession = session.fromPartition(partitionName);

      // User Agent
      if (network.user_agent) {
        appSession.setUserAgent(network.user_agent);
      }
      
      // Proxy: SINTAXE CORRIGIDA E AUTENTICAÇÃO
      if (network.proxy) {
        const hostPort = `${network.proxy.host}:${network.proxy.port}`;
        let proxyRules: string;
        let protocol = network.proxy.protocol;

        if (protocol === 'socks5' || protocol === 'socks4') {
            proxyRules = `socks=${hostPort}`; 
        } else if (protocol === 'http' || protocol === 'https') {
            proxyRules = `${protocol}=${hostPort}`;
        } else {
            proxyRules = 'direct://';
        }
        
        // Aplica as regras de Proxy
        await appSession.setProxy({ 
            proxyRules: proxyRules,
            proxyBypassRules: '<local>' 
        });
        console.log(`[Electron] Proxy configurado via regra: ${proxyRules}`);

        // Atualiza o handler global de login com as credenciais específicas da sessão
        if (network.proxy.auth) {
            setupProxyAuthHandler(network.proxy.auth.user, network.proxy.auth.pass);
        }
      } else {
        await appSession.setProxy({ proxyRules: 'direct://' });
      }

      // 3. INJETAR COOKIES (RESTAURAR SESSÃO)
      if (sessionInfo && sessionInfo.download_url) {
        try {
          console.log("[Electron] Baixando sessão da nuvem...");
          const sessRes = await fetch(sessionInfo.download_url);
          if (sessRes.ok) {
            const cookies = await sessRes.json();
            for (const cookie of cookies) {
              const scheme = cookie.secure ? "https://" : "http://";
              const domainUrl = scheme + cookie.domain.replace(/^\./, "");

              await appSession.cookies.set({
                url: domainUrl,
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                expirationDate: cookie.expirationDate,
              });
            }
            console.log(`[Electron] ${cookies.length} cookies restaurados.`);
          }
        } catch (err) {
          console.error("[Electron] Erro ao restaurar cookies:", err);
        }
      }

      // 4. CRIAR JANELA DO NAVEGADOR
      const appWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        title: app_config.name, 
        webPreferences: {
          session: appSession, 
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      await appWindow.loadURL(app_config.start_url);

      // Injetar regras uBlock (Aqui ficaria a lógica)
      if (app_config.ublock_rules) {
        // appWindow.webContents.insertCSS(processRules(app_config.ublock_rules));
      }

      // ============================================================
      // EVENTO: FECHAMENTO DA JANELA (SALVAR TUDO)
      // ============================================================
      appWindow.on("close", async () => {
        console.log(`[Electron] Janela do App ${appId} fechando. Salvando sessão...`);

        try {
          const cookies = await appSession.cookies.get({});
          const saveRes = await fetch(
            `${API_URL}?target=apps&action=save_session&id=${appId}`,
            {
              method: "PUT",
              headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                session_data: cookies,
                hash: `v-${Date.now()}`, 
              }),
            },
          );

          if (saveRes.ok) {
            console.log("[Electron] Sessão salva com sucesso.");
          } else {
            console.error("[Electron] Erro API ao salvar:", await saveRes.text());
          }
        } catch (err) {
          console.error("[Electron] Falha crítica ao salvar sessão:", err);
        } finally {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("app-closed", appId);
          }
        }
      });

      return { success: true, message: "App iniciado" };
    } catch (error: any) {
      console.error("[Electron Error]", error);
      return { success: false, error: error.message || "Erro desconhecido" };
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});