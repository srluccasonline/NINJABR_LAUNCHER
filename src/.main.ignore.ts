// ARQUIVO: src/main.ts
import { app, BrowserWindow, ipcMain, Menu, session } from "electron";
import path from "node:path";
import crypto from "node:crypto";
import { anonymizeProxy } from 'proxy-chain';

// =============================================================================
// FLAGS DE GUERRA (Anti-Detecção)
// =============================================================================
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-quic');
app.commandLine.appendSwitch('disable-http2');
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('ssl-version-min', 'tls1.0');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
app.commandLine.appendSwitch('lang', 'pt-BR');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('enforce-webrtc-ip-permission-check');
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

const API_URL = "https://nvukznijjllgyuyrswhy.supabase.co/functions/v1/app-manager";
const ENCRYPTION_KEY = crypto.scryptSync('SuaSenhaSuperSecretaDoNinja', 'salt', 32);
const IV_LENGTH = 16;

// USER AGENT HARDCODED (O MESMO DO PRELOAD)
const HARDCODED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.177 Safari/537.36';

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
      nodeIntegration: false, contextIsolation: true, // Painel seguro
      partition: 'persist:admin_panel' 
    },
    autoHideMenuBar: true,
  });
  mainWindow.loadURL("https://ninjabrfull.vercel.app");
  Menu.setApplicationMenu(null);
  mainWindow.removeMenu();
};

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault(); callback(true);
});

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

      // --- CONFIGURAR UA E HEADERS ---
      appSession.setUserAgent(HARDCODED_UA);
      appSession.webRequest.onBeforeSendHeaders((details, cb) => {
        const h = details.requestHeaders;
        h['User-Agent'] = HARDCODED_UA;
        h['sec-ch-ua-platform'] = '"Windows"';
        h['sec-ch-ua-platform-version'] = '"10.0.0"';
        h['sec-ch-ua'] = '"Not)A;Brand";v="99", "Google Chrome";v="142", "Chromium";v="142"';
        h['sec-ch-ua-full-version-list'] = '"Not)A;Brand";v="99.0.0.0", "Google Chrome";v="142.0.7444.177", "Chromium";v="142.0.7444.177"';
        h['sec-ch-ua-mobile'] = '?0';
        h['sec-ch-ua-arch'] = '"x86"';
        h['sec-ch-ua-bitness'] = '"64"';
        cb({ requestHeaders: h });
      });

      appSession.setCertificateVerifyProc((request, callback) => { callback(0); });

      const appWindow = new BrowserWindow({
        width: 1024, height: 768, title: app_config.name, 
        backgroundColor: '#ffffff',
        webPreferences: { 
            preload: path.join(__dirname, "preload.js"), 
            session: appSession, 
            nodeIntegration: false, 
            contextIsolation: false, // Stealth precisa disso
            sandbox: false, 
            devTools: false 
        },
      });
      appWindow.removeMenu();
      appWindow.setMenuBarVisibility(false);
      appWindow.webContents.on('context-menu', (e) => e.preventDefault());

      // --- REDE (PROXY) ---
      if (network.proxy && network.proxy.host) {
        const protocol = network.proxy.protocol === 'socks5' ? 'socks5' : 'http';
        let upstreamUrl = `${protocol}://${network.proxy.host}:${network.proxy.port}`;
        if (network.proxy.auth && network.proxy.auth.user) {
            upstreamUrl = `${protocol}://${network.proxy.auth.user}:${network.proxy.auth.pass}@${network.proxy.host}:${network.proxy.port}`;
        }
        console.log(`[Rede] Conectando Proxy...`);
        localProxyUrl = await anonymizeProxy(upstreamUrl);
        await appSession.setProxy({ proxyRules: localProxyUrl, proxyBypassRules: '<local>' });
      } else {
        await appSession.setProxy({ proxyRules: 'direct://' });
      }

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

      // --- INJEÇÃO (AUTOFILL INTELIGENTE + LS) ---
      let hasInjected = false;
      appWindow.webContents.on('did-finish-load', async () => {
         const currentURL = appWindow.webContents.getURL();
         if (currentURL.startsWith('data:')) return; 

         if (!hasInjected) {
             // AUTOFILL SCRIPT (Loop Inteligente)
             if (credentials && credentials.username) {
                 const scriptFill = `(function(){
                    const u='${credentials.username}'; const p='${credentials.password}';
                    
                    function fill() {
                        // Seletor genérico amplo
                        let iU = document.querySelector('input[type="text"], input[type="email"], input[name*="user"], input[name*="login"], input[id*="user"], input[id*="email"]');
                        let iP = document.querySelector('input[type="password"]');
                        
                        const dispatch = (el) => {
                            el.dispatchEvent(new Event('click', {bubbles:true}));
                            el.dispatchEvent(new Event('focus', {bubbles:true}));
                            el.dispatchEvent(new Event('input', {bubbles:true}));
                            el.dispatchEvent(new Event('change', {bubbles:true}));
                            el.dispatchEvent(new Event('blur', {bubbles:true}));
                        };

                        if(iU && !iU.value && iU.offsetParent) { 
                            console.log("Ninja: Preenchendo Usuario");
                            iU.value=u; dispatch(iU); 
                        }
                        if(iP && !iP.value && iP.offsetParent) { 
                            console.log("Ninja: Preenchendo Senha");
                            iP.value=p; dispatch(iP); 
                        }
                    }
                    
                    // Roda a cada 1.5 segundos ETERNAMENTE (assim se o user deslogar, preenche de novo)
                    setInterval(fill, 1500);
                 })();`;
                 appWindow.webContents.executeJavaScript(scriptFill).catch(()=>{});
             }

             // LS RESTORE
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