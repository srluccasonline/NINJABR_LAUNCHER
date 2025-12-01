// ARQUIVO: src/main.ts
import { app, BrowserWindow, ipcMain, Menu, session } from "electron";
import path from "node:path";
import crypto from "node:crypto";
import { anonymizeProxy } from 'proxy-chain';

// =============================================================================
// 1. FLAGS (Cópia exata do seu exemplo funcional + correções Linux)
// =============================================================================
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('lang', 'pt-BR');
app.commandLine.appendSwitch('disable-ipv6');
// Mantivemos apenas estas duas extras por estabilidade no Linux, não afetam detecção:
app.commandLine.appendSwitch('disable-gpu'); 
//app.commandLine.appendSwitch('no-sandbox'); 

const API_URL = "https://nvukznijjllgyuyrswhy.supabase.co/functions/v1/app-manager";
const ENCRYPTION_KEY = crypto.scryptSync('SuaSenhaSuperSecretaDoNinja', 'salt', 32);
const IV_LENGTH = 16;

function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text: string): string {
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift()!, 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (err) { return "{}"; }
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, title: "Ninja Browser Manager",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false, 
      contextIsolation: true, // Painel Admin continua seguro
      partition: 'persist:admin_panel' 
    },
    autoHideMenuBar: true,
  });
  mainWindow.loadURL("https://ninjabrfull.vercel.app");
  Menu.setApplicationMenu(null);
  mainWindow.removeMenu();
};

app.on("ready", () => {
  createWindow();

  ipcMain.handle("launch-app", async (event, { appId, token }) => {
    let localProxyUrl = '';

    try {
      console.log(`[Electron] Lançando App ID: ${appId}`);

      const response = await fetch(`${API_URL}?target=apps&action=launch&id=${appId}`, {
          method: "GET", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(`Erro API: ${response.statusText}`);
      const data = await response.json();
      const { app_config, network, session: sessionInfo, credentials } = data;

      const partitionName = `persist:app_${appId}`;
      const appSession = session.fromPartition(partitionName);

      // =======================================================================
      // 2. CONFIGURAÇÃO DE REDE (PROXY CHAIN)
      // =======================================================================
      if (network.proxy && network.proxy.host) {
        // Seu código funcional usava HTTP upstream, mantemos assim
        const protocol = network.proxy.protocol === 'socks5' ? 'socks5' : 'http';
        let upstreamUrl = `${protocol}://${network.proxy.host}:${network.proxy.port}`;
        
        if (network.proxy.auth && network.proxy.auth.user) {
            upstreamUrl = `${protocol}://${network.proxy.auth.user}:${network.proxy.auth.pass}@${network.proxy.host}:${network.proxy.port}`;
        }

        console.log(`[Rede] Criando túnel...`);
        localProxyUrl = await anonymizeProxy(upstreamUrl);
        await appSession.setProxy({ proxyRules: localProxyUrl, proxyBypassRules: '<local>' });
      } else {
        await appSession.setProxy({ proxyRules: 'direct://' });
      }

      // =======================================================================
      // 3. CABEÇALHOS WINDOWS (IDÊNTICO AO SEU SCRIPT)
      // =======================================================================
      appSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const h = details.requestHeaders;
        // Hardcoded para Windows/Chrome 142 (Igual ao seu script)
        h['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.177 Safari/537.36';
        h['sec-ch-ua-platform'] = '"Windows"';
        h['sec-ch-ua-platform-version'] = '"10.0.0"';
        h['sec-ch-ua'] = '"Not)A;Brand";v="99", "Google Chrome";v="142", "Chromium";v="142"';
        h['sec-ch-ua-full-version-list'] = '"Not)A;Brand";v="99.0.0.0", "Google Chrome";v="142.0.7444.177", "Chromium";v="142.0.7444.177"';
        h['sec-ch-ua-mobile'] = '?0';
        h['sec-ch-ua-arch'] = '"x86"';
        h['sec-ch-ua-bitness'] = '"64"';
        h['sec-ch-ua-wow64'] = '?0';
        callback({ requestHeaders: h });
      });

      // =======================================================================
      // 4. JANELA "UNSAFE" (IGUAL AO SEU SCRIPT)
      // =======================================================================
      const appWindow = new BrowserWindow({
        width: 1366, height: 768, title: app_config.name,
        backgroundColor: '#ffffff',
        webPreferences: {
          session: appSession,
          preload: path.join(__dirname, "preload.js"),
          // Configurações críticas para o Stealth funcionar:
          contextIsolation: false, 
          sandbox: false, 
          nodeIntegration: false, // Mantemos false por segurança básica
          devTools: false 
        },
      });

      appWindow.removeMenu();
      appWindow.setMenuBarVisibility(false);
      appWindow.webContents.on('context-menu', (e) => e.preventDefault());

      // --- RESTORE DATA ---
      let savedLocalStorage = {}; 
      let needToInjectLS = false;
      if (sessionInfo && sessionInfo.download_url) {
        try {
            const sessRes = await fetch(sessionInfo.download_url);
            if (sessRes.ok) {
                const wrapper = await sessRes.json();
                if (wrapper.session_data && typeof wrapper.session_data === 'string') {
                    const decrypted = JSON.parse(decrypt(wrapper.session_data));
                    if (decrypted.cookies) {
                        for (const c of decrypted.cookies) {
                            try { await appSession.cookies.set({...c, url: (c.secure?'https://':'http://') + c.domain.replace(/^\./, "")}); } catch(e){}
                        }
                    }
                    if (decrypted.localStorage) {
                        savedLocalStorage = decrypted.localStorage;
                        needToInjectLS = true;
                    }
                }
            }
        } catch (e) { console.error("Restore error", e); }
      }

      // --- INJEÇÃO (AUTOFILL + LS) ---
      let hasInjected = false;
      appWindow.webContents.on('did-finish-load', async () => {
         const currentURL = appWindow.webContents.getURL();
         if (currentURL.startsWith('data:')) return; 

         if (!hasInjected) {
             if (credentials && credentials.username) {
                 const scriptFill = `(function(){
                    const u='${credentials.username}'; const p='${credentials.password}';
                    const sU='${credentials.usernameSelector||''}'; const sP='${credentials.passwordSelector||''}';
                    function fill() {
                        let iU = sU ? document.querySelector(sU) : document.querySelector('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"]');
                        let iP = sP ? document.querySelector(sP) : document.querySelector('input[type="password"]');
                        const dispatch = (el) => ['click','focus','input','change','blur'].forEach(e => el.dispatchEvent(new Event(e, {bubbles:true})));
                        if(iU && !iU.value && iU.offsetParent) { iU.value=u; dispatch(iU); }
                        if(iP && !iP.value && iP.offsetParent) { iP.value=p; dispatch(iP); }
                    }
                    let c=0; const i = setInterval(() => { fill(); c++; if(c>10) clearInterval(i); }, 1000);
                 })();`;
                 appWindow.webContents.executeJavaScript(scriptFill).catch(()=>{});
             }
             if (needToInjectLS) {
                 const scriptLS = Object.entries(savedLocalStorage).map(([k,v]) => `localStorage.setItem('${k}','${String(v).replace(/'/g,"\\'")}');`).join(' ');
                 await appWindow.webContents.executeJavaScript(scriptLS).catch(()=>{});
                 hasInjected = true;
                 appWindow.reload();
             } else {
                 hasInjected = true;
             }
         }
      });

      // NAVEGAÇÃO
      console.log(`[Navegação] Indo para: ${app_config.start_url}`);
      appWindow.loadURL(app_config.start_url);

      // SAVE ON CLOSE
      let isSaving = false;
      appWindow.on("close", async (e) => {
          if(isSaving) return;
          e.preventDefault(); isSaving=true;
          try {
              const ck = await appSession.cookies.get({});
              let ls = {};
              if (!appWindow.isDestroyed()) {
                  try { ls = JSON.parse(await appWindow.webContents.executeJavaScript(`(function(){try{return JSON.stringify(localStorage);}catch{return "{}"}})()`)); } catch(e){}
              }
              const encrypted = encrypt(JSON.stringify({cookies:ck, localStorage:ls}));
              await fetch(`${API_URL}?target=apps&action=save_session&id=${appId}`, {
                  method: 'PUT', headers: {'Authorization': `Bearer ${token}`},
                  body: JSON.stringify({session_data: encrypted, is_encrypted: true, hash: `v-${Date.now()}`})
              });
              await appSession.clearStorageData();
          } catch(e) { console.error("Save error", e); }
          finally {
              if (localProxyUrl) { /* Log cleanup */ }
              if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app-closed", appId);
              appWindow.destroy();
          }
      });

      return { success: true, message: "App iniciado" };
    } catch (error: any) {
      console.error("[Electron Error]", error);
      return { success: false, error: error.message };
    }
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });