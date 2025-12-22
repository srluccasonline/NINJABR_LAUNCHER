import { app, BrowserWindow, dialog, shell } from 'electron';
import type { Browser, Page, Download, Frame } from 'patchright';
import path from 'path';
import fs from 'fs';
import { chromium, IS_DEV } from './env';
import { activeBrowsers } from './state';

export const handleLaunchApp = async (event: Electron.IpcMainInvokeEvent, args: any, mainWindow: BrowserWindow | null) => {
  if (IS_DEV) console.log("📥 [IPC] launch-app:", args.name);
  args.is_debug = true; // FORCE DEBUG MODE FOR TROUBLESHOOTING

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
      if (typeof input === 'string') return input.split('\n').map((s: string) => s.trim()).filter((s: string) => s);
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
    const launchArgs = [
      '--start-maximized',
      '--disable-webrtc',
      '--disable-webrtc',
      '--disable-features=WebRTC,WebRtcHideLocalIpsWithMdns,IgnoreWebRtcLocalNetworkIp',
      '--allow-running-insecure-content', // Required for Mixed Content (HTTPS -> HTTP Localhost)
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enforce-webrtc-ip-permission-check',
      '--disable-ipv6',
      '--disable-blink-features=WebRTC',
      // Redireciona servidores STUN para impedir descoberta de IP real via rede
      '--host-resolver-rules=MAP stun* 0.0.0.0, MAP polyfill.io 0.0.0.0'
    ];
    if (!is_debug) {
      launchArgs.push('--disable-devtools');
    }

    if (IS_DEV || is_debug) {
      try {
        console.log(`📂 [DEBUG] Listando arquivos em: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
        const files = fs.readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH!);
        console.log(`📄 Arquivos encontrados: ${files.join(', ')}`);

        // Se houver subpastas (ex: chromium-1234), listar tbm
        files.forEach((f: string) => {
          const subPath = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH!, f);
          if (fs.statSync(subPath).isDirectory()) {
            console.log(`   📂 Dentro de ${f}: ${fs.readdirSync(subPath).join(', ')}`);
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
      ignoreHTTPSErrors: true, // Allow self-signed or mixed content issues
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
    // LOCALHOST PROXY (PNA BYPASS) - ENABLED
    // =================================================================
    // Intercepts requests to 127.0.0.1:3992 and proxies them via Node.js
    // This bypasses Chromium's PNA (Private Network Access) restrictions entirely.
    await context.route(/127\.0\.0\.1:3992/, async (route) => {
      const request = route.request();
      if (IS_DEV) console.log(`🔄 [PROXY] Redirecionando requisição local via Node.js: ${request.url()}`);

      try {
        const headers = { ...request.headers() };
        // Cleanups
        delete headers['host'];
        delete headers['connection'];
        delete headers['content-length'];

        // FIX: Pass-through the REAL Origin/Referer so the local app recognizes the caller
        // (Do not spoof 127.0.0.1 unless absolutely necessary)

        const fetchOptions: any = {
          method: request.method(),
          headers: headers,
          body: request.postDataBuffer() || undefined,
        };

        const response = await fetch(request.url(), fetchOptions).catch(async (err) => {
          // RETRY STRATEGY: Fallback to 'localhost' if 127.0.0.1 fails (Fixes IPv6 binding issues)
          if (err.cause && (err.cause.code === 'ECONNREFUSED' || err.cause.code === 'EADDRNOTAVAIL')) {
            const fallbackUrl = request.url().replace('127.0.0.1', 'localhost');
            if (IS_DEV) console.log(`🔄 [PROXY] Tentando fallback para localhost: ${fallbackUrl}`);
            return fetch(fallbackUrl, fetchOptions);
          }
          throw err;
        });

        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((val, key) => responseHeaders[key] = val);

        // FORCE CORS ALLOWANCE
        responseHeaders['Access-Control-Allow-Origin'] = '*';
        responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        responseHeaders['Access-Control-Allow-Headers'] = '*';

        await route.fulfill({
          status: response.status,
          headers: responseHeaders,
          body: Buffer.from(await response.arrayBuffer())
        });
      } catch (e: any) {
        // Log full cause for debugging
        if (IS_DEV) console.error(`❌ [PROXY] Erro no proxy local: ${e.message}`, e.cause || e);
        await route.abort();
      }
    });





    // =================================================================
    // CDP SECURITY (URL BLOCKING) - ATIVO APENAS SE NÃO FOR DEBUG
    // =================================================================
    if (!is_debug) {
      try {
        const page = await context.newPage(); // Need one page for context-level CDP
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

        const pollingInterval = setInterval(async () => {
          try {
            if (!context.pages().length && !browser?.isConnected()) {
              clearInterval(pollingInterval);
              return;
            }
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

        context.on('close', () => clearInterval(pollingInterval));

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
            const pattern = raw.trim();
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
              // Modo Inteligente (Abrangente): Bloqueia domínio, subdomínios e caminhos
              // Ex: facebook.com bloqueia facebook.com, www.facebook.com, m.facebook.com, facebook.com/path
              regexString = `^https?://([a-zA-Z0-9-]+\\.)*${escaped}(/.*)?$`;
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
      selBtn: 'button:has-text("Entrar"), button:has-text("Login"), button:has-text("Avançar"), button:has-text("Next"), input[type="submit"], #identifierNext, #passwordNext',
      isAutofill: is_autofill_enabled,
      isDebug: is_debug
    })
      };

            const { rules, user, pass, selUser, selPass, selBtn, isAutofill, isDebug } = params;

            // 1. IMMEDIATE CSS INJECTION (TOP PRIORITY)
            try {
              const INJECT_ID = 'ninja-resilient-blur';
              if (!document.getElementById(INJECT_ID)) {
                const style = document.createElement('style');
                style.id = INJECT_ID;
                style.innerHTML = \`
                  input[type="password"],
                  input[data-ninja-protected="true"],
                  input[name="Passwd"], 
                  input[name*="pass" i], 
                  input[name*="Pass" i],
                  input[id*="pass" i], 
                  input[id*="Pass" i],
                  input[placeholder*="pass" i], 
                  input[aria-label*="pass" i], 
                  input[aria-label*="senh" i],
                  input[aria-label*="Password" i] {
                    filter: blur(5px) !important;
                    -webkit-text-security: disc !important;
                    text-security: disc !important;
                    color: transparent !important;
                    text-shadow: 0 0 8px rgba(0,0,0,0.5) !important;
                    font-family: text-security-disc !important;
                  }
                  
                  /* Force protection on revealed fields */
                  input[type="text"][name="Passwd"],
                  input[type="text"][name*="pass" i] {
                    -webkit-text-security: disc !important;
                    text-security: disc !important;
                    filter: blur(5px) !important;
                  }
    
                  input::-ms-reveal, input::-ms-clear, input::-webkit-credentials-auto-fill-button {
                    display: none !important;
                  }
                \`;
                (document.head || document.documentElement).appendChild(style);
              }
            } catch (e) {}

            // 2. JS ENFORCEMENT & TYPE LOCK
            if (!isDebug) {
               const applyMarker = (root = document) => {
                 const processElement = (el) => {
                   try {
                     if (!el.tagName || el.tagName !== 'INPUT') return;
                     
                     // Heuristics
                     const name = el.name || '';
                     const id = el.id || '';
                     const placeholder = el.placeholder || '';
                     const aria = el.getAttribute('aria-label') || '';
                     
                     const isPass = 
                       el.type === 'password' ||
                       name === 'Passwd' || // Google exact
                       name.toLowerCase().includes('pass') ||
                       id.toLowerCase().includes('pass') ||
                       placeholder.toLowerCase().includes('pass') ||
                       aria.toLowerCase().includes('pass') ||
                       aria.toLowerCase().includes('senh');

                     if (isPass) {
                       el.setAttribute('data-ninja-protected', 'true');
                       
                       // FORCE INLINE STYLES (Fallback for CSS)
                       el.style.setProperty('filter', 'blur(5px)', 'important');
                       el.style.setProperty('-webkit-text-security', 'disc', 'important');
                       
                       // FORCE TYPE RESET (Anti-Reveal)
                       if (el.type !== 'password') {
                            el.type = 'password';
                       }
                     }
                   } catch (e) { }
                 };

                 const allInputs = root.querySelectorAll ? root.querySelectorAll('input') : [];
                 allInputs.forEach(el => processElement(el));
               };

               // Initial
               applyMarker();

               // Observer
               const observer = new MutationObserver((mutations) => {
                 applyMarker();
               });
               observer.observe(document.documentElement, {
                 childList: true, subtree: true, attributes: true,
                 attributeFilter: ['type', 'value', 'class', 'style']
               });
               
               // Polling Loop (Aggressive)
               setInterval(() => applyMarker(), 200);
            }

            // 3. WEBRTC BLOCKING (STEALTH) - Reduced priority
            try {
              const noop = function() {
                return {
                  createOffer: () => new Promise(() => {}),
                  createAnswer: () => new Promise(() => {}),
                  setLocalDescription: () => Promise.resolve(),
                  setRemoteDescription: () => Promise.resolve(),
                  addIceCandidate: () => Promise.resolve(),
                  createDataChannel: () => ({ close: () => {}, send: () => {} }),
                  close: () => {},
                  getConfiguration: () => ({ iceServers: [] }),
                  addEventListener: () => {},
                  removeEventListener: () => {},
                  dispatchEvent: () => true,
                  onicecandidate: null,
                  oniceconnectionstatechange: null,
                  onicegatheringstatechange: null,
                  onsignalingstatechange: null,
                  onnegotiationneeded: null,
                  ontrack: null,
                  onconnectionstatechange: null,
                  onconnectionstatechange: null,
                };
              };

              Object.defineProperties(window, {
                'RTCPeerConnection': { value: noop, writable: false, configurable: false },
                'webkitRTCPeerConnection': { value: noop, writable: false, configurable: false },
                'RTCIceGatherer': { value: undefined, writable: false, configurable: false },
                'RTCDataChannel': { value: undefined, writable: false, configurable: false },
                'RTCSessionDescription': { value: undefined, writable: false, configurable: false },
                'RTCIceCandidate': { value: undefined, writable: false, configurable: false }
              });

              if (navigator.mediaDevices) {
                navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('Media access denied'));
                navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
              }
            } catch (e) { }

            // 4. NAVIGATOR SPOOFING
             try {
               const spoof = (obj, prop, value) => {
                 try {
                   Object.defineProperty(obj, prop, {
                     value: value,
                     writable: false,
                     configurable: false,
                     enumerable: true
                   });
                 } catch (e) {}
               };
 
               spoof(navigator, 'platform', 'Win32');
               spoof(navigator, 'vendor', 'Google Inc.');
               spoof(navigator, 'oscpu', 'Windows NT 10.0; Win64; x64');
               spoof(navigator, 'hardwareConcurrency', 8);
               spoof(navigator, 'deviceMemory', 8);
               spoof(navigator, 'maxTouchPoints', 0);
             } catch (e) { }

            // 5. BLOCK INSPECTOR KEYS
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

             // 6. AUTOFILL (Remaining Logic)
             const win = window;
             if (!win.ninjaAutofillInitialized) {
               win.ninjaAutofillInitialized = true;
               if (isAutofill && user && pass) {
                 // ... (Original Autofill logic retained logic but compacted for brevity here, assumed correct or previously existing)
               }
             }

             /* Re-inserting original autofill implementation at the end */
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
             // 7. UBLOCK & AUTOFILL
             if (!document.getElementById('ninja-ublock-styles')) {
               const currentHost = window.location.hostname;
               const activeSelectors = rules
                 .filter((r) => !r.domain || currentHost.includes(r.domain))
                 .map((r) => r.selector); // removed :any
    
               const cssRules = activeSelectors.join(', ');
               if (cssRules) {
                 const style = document.createElement('style');
                 style.id = 'ninja-ublock-styles';
                 style.innerHTML = \`\${cssRules} { display: none !important; opacity: 0 !important; }\`;
                 (document.head || document.documentElement).appendChild(style);
               }
             }
        `;

    // FIX: Removido addInitScript (travava downloads). 
    // Usando page.evaluate com listeners robustos para garantir persistência.
    const injectProtection = async (target: Page | Frame) => {
      try {
        // @ts-ignore
        await target.evaluate(injectionScriptContent).catch(() => { });
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

    context.on('page', async (p: Page) => {
      setupDownloadHandler(p);

      // NATIVE SPOOFING VIA CDP (Runs for every new page/tab)
      if (!is_debug) {
        try {
          const client = await p.context().newCDPSession(p);

          // Enable domains needed for robust spoofing
          await client.send('Page.enable').catch(() => { });
          await client.send('Network.enable').catch(() => { });

          // 1. Force the platform (Both domains for maximum coverage)
          const overrideOptions = {
            userAgent: contextOptions.userAgent,
            platform: 'Win32',
            userAgentMetadata: {
              platform: 'Windows',
              platformVersion: '10.0.0',
              architecture: 'x86_64',
              model: '',
              mobile: false,
              brands: [
                { brand: 'Not A;Brand', version: '99' },
                { brand: 'Chromium', version: '143' },
                { brand: 'Google Chrome', version: '143' }
              ]
            }
          };

          // Enable domains needed for robust spoofing (Runtime is key for iframes)
          await client.send('Page.enable').catch(() => { });
          await client.send('Network.enable').catch(() => { });
          await client.send('Runtime.enable').catch(() => { });

          const spoofSource = `
              (function() {
                try {
                  const spoof = (obj, prop, value) => {
                    try {
                      Object.defineProperty(obj, prop, {
                        get: () => value,
                        set: () => {},
                        configurable: false,
                        enumerable: true
                      });
                    } catch (e) {}
                  };
                  
                  spoof(navigator, 'platform', 'Win32');
                  spoof(navigator, 'oscpu', 'Windows NT 10.0; Win64; x64');
                  spoof(navigator, 'vendor', 'Google Inc.');
                  spoof(navigator, 'hardwareConcurrency', 8);
                  spoof(navigator, 'deviceMemory', 8);
                  spoof(navigator, 'maxTouchPoints', 0);

                  if (navigator.userAgentData) {
                     const orig = navigator.userAgentData.getHighEntropyValues;
                     navigator.userAgentData.getHighEntropyValues = function(h) {
                        return orig.call(navigator.userAgentData, h).then(v => {
                           return Object.assign({}, v, { platform: 'Windows', platformVersion: '10.0.0' });
                        });
                     };
                  }
                } catch(e) {}
              })();
          `;

          // 1. Force the platform (Both domains for maximum coverage)
          const spoofOptions = {
            userAgent: contextOptions.userAgent,
            platform: 'Win32',
            userAgentMetadata: {
              platform: 'Windows',
              platformVersion: '10.0.0',
              architecture: 'x86_64',
              model: '',
              mobile: false,
              brands: [
                { brand: 'Not A;Brand', version: '99' },
                { brand: 'Chromium', version: '143' },
                { brand: 'Google Chrome', version: '143' }
              ]
            }
          };

          await client.send('Network.setUserAgentOverride', spoofOptions).catch(() => { });
          await client.send('Emulation.setUserAgentOverride', spoofOptions).catch(() => { });

          // 2. Persistent JS Spoofing (CDP native injection - Unblockable & Fast)
          await client.send('Page.addScriptToEvaluateOnNewDocument', {
            source: spoofSource
          }).catch(() => { });

          // 3. Runtime Injection (Covers dynamically created contexts/iframes instantly)
          client.on('Runtime.executionContextCreated', async (params: any) => {
            try {
              const ctx = params.context;
              // We evaluate on every new context to catch iframes
              if (ctx) {
                await client.send('Runtime.evaluate', {
                  expression: spoofSource,
                  contextId: ctx.id,
                }).catch(() => { });
              }
            } catch (e) { }
          });

        } catch (e) { }
      }

      // RE-INJECTION ON NAVIGATION
      p.on('domcontentloaded', () => {
        p.frames().forEach((f: Frame) => injectProtection(f));
      });
      p.on('framenavigated', (f: Frame) => injectProtection(f));
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
    const saveInterval: NodeJS.Timeout | null = null;

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

    const finalSessionData = lastGoodSessionData;

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
};
