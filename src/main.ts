import { app, BrowserWindow, ipcMain } from 'electron';
import { chromium } from 'patchright';
import path from 'node:path';
import started from 'electron-squirrel-startup';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL("https://ninjabrfull.vercel.app");
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  createWindow();

  ipcMain.handle('launch-app', async (event, args) => {
    console.log("📥 [IPC] launch-app received:", args);

    try {
      const {
        start_url: TARGET_URL,
        login: USER_EMAIL,
        password: USER_PASSWORD,
        proxy_data,
        session_data: SESSION_DATA, // Receber dados da sessão em memória
        is_autofill_enabled
      } = args;

      // Configurar Proxy
      let proxyConfig = undefined;
      if (proxy_data) {
        proxyConfig = {
          server: `${proxy_data.protocol}://${proxy_data.host}:${proxy_data.port}`,
          username: proxy_data.username,
          password: proxy_data.password
        };
      }

      // Configurar User Agent
      const userAgent = proxy_data?.user_agents?.ua_string || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

      const browser = await chromium.launch({ headless: false });

      // --- CONFIGURAÇÃO DE CONTEXTO ---
      const contextOptions: any = {
        channel: 'chrome',
        userAgent: userAgent,
        proxy: proxyConfig,
        ignoreHTTPSErrors: true
      };

      // Carregar sessão da memória se existir
      if (SESSION_DATA) {
        console.log(`📂 Carregando sessão da memória...`);
        try {
          // Se for string, faz parse. Se já for objeto, usa direto.
          const storageState = typeof SESSION_DATA === 'string' ? JSON.parse(SESSION_DATA) : SESSION_DATA;
          contextOptions.storageState = storageState;
        } catch (e) {
          console.error("Erro ao fazer parse da sessão:", e);
        }
      } else {
        console.log('📂 Iniciando sem sessão prévia.');
      }

      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();

      // Variável para armazenar a sessão capturada
      let capturedSession: any = null;

      // --- FUNÇÃO AUXILIAR PARA CAPTURAR SESSÃO (EM MEMÓRIA) ---
      const captureSession = async () => {
        try {
          capturedSession = await context.storageState();
          console.log("💾 Sessão capturada em memória.");
        } catch (error: any) {
          if (!error.message.includes('Target closed') && !error.message.includes('closed')) {
            console.error('Erro ao capturar sessão:', error.message);
          }
        }
      };

      // --- 🛡️ PROTEÇÃO VISUAL ---
      await page.addInitScript(() => {
        const style = document.createElement('style');
        style.innerHTML = `
            input[type="email"], input[type="text"], input[name*="user"], input[name*="login"], input[name*="identifier"] {
                -webkit-text-security: disc !important; filter: blur(3px);
            }
            input[type="password"] { user-select: none !important; }
        `;
        document.head.appendChild(style);
        document.addEventListener('copy', (e) => e.preventDefault(), true);
        document.addEventListener('contextmenu', (e) => e.preventDefault(), true);
      });

      console.log(`Navegando para ${TARGET_URL}...`);
      await page.goto(TARGET_URL);

      // Loop de monitoramento (executando em background sem travar o main process)
      // Nota: O loop agora serve apenas para o auto-login e detectar fechamento
      await new Promise<void>(async (resolve) => {
        const LOGIN_INDICATORS = 'input[type="email"], input[name*="user"], input[name*="login"], input[name*="identifier"]';

        console.log("🟢 MONITORAMENTO ATIVO: Aguardando login ou fechamento...");

        while (true) {
          try {
            if (page.isClosed()) break;

            // REMOVIDO: Auto-save periódico de 5s

            // 2. MONITORAMENTO DE LOGIN (Apenas se autofill estiver habilitado e houver credenciais)
            if (is_autofill_enabled && USER_EMAIL && USER_PASSWORD) {
              const isLoginVisible = await page.isVisible(LOGIN_INDICATORS, { timeout: 1000 }).catch(() => false);
              const isPasswordVisible = await page.isVisible('input[type="password"]', { timeout: 500 }).catch(() => false);

              if (isLoginVisible || isPasswordVisible) {
                console.log("⚠️ Detectado Login Necessário...");

                // --- LÓGICA DE PREENCHIMENTO ---
                const userField = await page.$(LOGIN_INDICATORS);
                if (userField && await userField.isVisible()) {
                  const currentValue = await userField.inputValue();
                  if (currentValue !== USER_EMAIL) await userField.fill(USER_EMAIL);
                }

                let passField = await page.$('input[type="password"]');
                if (!passField || !(await passField.isVisible())) {
                  const nextButton = await page.$(`button:has-text("Avançar"), button:has-text("Next"), input[type="submit"], #identifierNext`);
                  if (nextButton && await nextButton.isVisible()) {
                    await nextButton.click();
                    try {
                      passField = await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 5000 });
                    } catch (e) { }
                  }
                }

                if (passField && await passField.isVisible()) {
                  const passValue = await passField.inputValue();
                  if (passValue === '') {
                    await passField.fill(USER_PASSWORD);
                    await passField.press('Enter');
                    console.log("⏳ Logando...");

                    await page.waitForTimeout(8000);

                    // Salvar sessão APÓS login (Uma vez)
                    await captureSession();
                    console.log("✅ Login feito e Sessão Capturada.");
                  }
                }
              }
            }

            await page.waitForTimeout(2000);

          } catch (error: any) {
            if (error.message.includes('Target closed') || error.message.includes('closed')) {
              console.log("❌ Navegador fechado pelo usuário.");
              break;
            }
          }
        }
        resolve();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("app-closed", args.id);
        }
      });

      // Retornar a sessão capturada para o front/main process
      return { success: true, session_data: capturedSession };

    } catch (error: any) {
      console.error("Erro ao lançar app:", error);
      return { success: false, error: error.message };
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
