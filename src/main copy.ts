// ARQUIVO: src/main.ts
import { app, BrowserWindow, ipcMain, Menu, session } from "electron";
import path from "node:path";
import started from "electron-squirrel-startup";

// --- CONFIGURAÇÃO ---
// Substitua pela URL real do seu projeto Supabase, se mudar
const API_URL =
  "https://nvukznijjllgyuyrswhy.supabase.co/functions/v1/app-manager";

if (started) {
  app.quit();
}

// Mantemos referência global para poder enviar mensagens de volta (IPC)
let mainWindow: BrowserWindow | null = null;

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

  // mainWindow.webContents.openDevTools(); // Descomente para debug do painel
};

app.on("ready", () => {
  createWindow();

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
      // "persist:" salva no disco local do usuário para performance
      const partitionName = `persist:app_${appId}`;
      const appSession = session.fromPartition(partitionName);

      // User Agent
      if (network.user_agent) {
        appSession.setUserAgent(network.user_agent);
      }

      // Proxy
      // 4. Configurar Proxy
      if (network.proxy) {
        
        let proxyRules = '';
        const hostPort = `${network.proxy.host}:${network.proxy.port}`;
        let protocol = network.proxy.protocol;

        // Utilizamos 'socks' para SOCKS5/SOCKS4, que é a sintaxe preferida do Chromium.
        // Isso resolve o erro -336, pois é a regra que o Electron entende.
        if (protocol === 'socks5' || protocol === 'socks4') {
            // Nota: Usar apenas 'socks' aqui instrui o Chromium a tentar SOCKS5, o que é ideal.
            proxyRules = `socks=${hostPort}`; 
        } else if (protocol === 'http' || protocol === 'https') {
            proxyRules = `${protocol}=${hostPort}`;
        } else {
            console.warn('[Electron] Protocolo desconhecido. Usando conexão direta.');
            proxyRules = 'direct://';
        }
        
        // Define as regras (se a regra é inválida/desconhecida, o erro -336 ocorre)
        await appSession.setProxy({ 
            proxyRules: proxyRules,
            proxyBypassRules: 'localhost, <local>' // Ignora proxy para domínios internos
        });
        
        console.log(`[Electron] Proxy configurado via regra: ${proxyRules}`);

        // Autenticação (Mantida a lógica anterior, pois funciona via app.on('login'))
        if (network.proxy.auth) {
          app.on('login', (event, webContents, request, authInfo, callback) => {
            if (authInfo.isProxy) {
              event.preventDefault();
              callback(network.proxy.auth.user, network.proxy.auth.pass);
            }
          });
        }
      } else {
        // Limpa proxy se não tiver
        await appSession.setProxy({ proxyRules: 'direct://' });
      }

      // 3. INJETAR COOKIES (RESTAURAR SESSÃO)
      // Se a API retornou um link de download do bucket, baixamos e aplicamos
      if (sessionInfo && sessionInfo.download_url) {
        try {
          console.log("[Electron] Baixando sessão da nuvem...");
          const sessRes = await fetch(sessionInfo.download_url);
          if (sessRes.ok) {
            const cookies = await sessRes.json();

            // Inserir cookies um por um
            for (const cookie of cookies) {
              // Electron exige esquema de URL válido para setar cookie
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
          // Não paramos o fluxo, apenas logamos erro
        }
      }

      // 4. CRIAR JANELA DO NAVEGADOR
      const appWindow = new BrowserWindow({
        width: 1024,
        height: 768,
        title: app_config.name, // Nome do App na barra
        webPreferences: {
          session: appSession, // VÍNCULO CRUCIAL
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      // Carregar URL inicial
      await appWindow.loadURL(app_config.start_url);

      // Injetar regras uBlock (Exemplo simples)
      if (app_config.ublock_rules) {
        // Aqui você converteria as regras em CSS ou JS.
        // Exemplo: appWindow.webContents.insertCSS('...regras...');
      }

      // ============================================================
      // EVENTO: FECHAMENTO DA JANELA (SALVAR TUDO)
      // ============================================================
      appWindow.on("close", async () => {
        console.log(
          `[Electron] Janela do App ${appId} fechando. Salvando sessão...`,
        );

        try {
          // A. Pegar Cookies da Memória
          const cookies = await appSession.cookies.get({});

          // B. Enviar para Supabase (PUT)
          const saveRes = await fetch(
            `${API_URL}?target=apps&action=save_session&id=${appId}`,
            {
              method: "PUT",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                session_data: cookies, // Array de cookies
                hash: `v-${Date.now()}`, // Versionamento simples
              }),
            },
          );

          if (saveRes.ok) {
            console.log("[Electron] Sessão salva com sucesso.");
          } else {
            console.error(
              "[Electron] Erro API ao salvar:",
              await saveRes.text(),
            );
          }
        } catch (err) {
          console.error("[Electron] Falha crítica ao salvar sessão:", err);
        } finally {
          // C. Avisar o Front-end (React) que acabou
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
