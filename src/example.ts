import { chromium } from 'patchright';
import fs from 'fs';

const Win10UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

// ⚙️ CONFIGURAÇÕES
const TARGET_URL = 'https://groupbuyseotools.org/amember/member';
const USER_EMAIL = 'robertsnelsonvo2010';
const USER_PASSWORD = '12345678';

const PROXY_SERVER = 'http://200.234.139.36:59100';
const PROXY_USERNAME = 'mcthehost';
const PROXY_PASSWORD = 'HZLi6jVzWo';

const SESSION_FILE_PATH = 'session_profile_1.json';

// --- FUNÇÃO AUXILIAR PARA SALVAR SESSÃO ---
async function saveSession(context, path) {
    try {
        await context.storageState({ path: path });
        // console.log(`💾 Sessão salva automaticamente em ${path}`); // Comentei para não poluir o log
    } catch (error) {
        // Se o navegador já fechou, isso vai dar erro, então apenas ignoramos
        if (!error.message.includes('Target closed') && !error.message.includes('closed')) {
            console.error('Erro ao salvar sessão:', error.message);
        }
    }
}

(async () => {
    const browser = await chromium.launch({ headless: false });

    // --- CONFIGURAÇÃO DE CONTEXTO ---
    const contextOptions = {
        userAgent: Win10UserAgent,
        proxy: {
            server: PROXY_SERVER,
            username: PROXY_USERNAME,
            password: PROXY_PASSWORD
        },
        ignoreHTTPSErrors: true
    };

    if (fs.existsSync(SESSION_FILE_PATH)) {
        console.log(`📂 Sessão encontrada! Carregando: ${SESSION_FILE_PATH}`);
        contextOptions.storageState = SESSION_FILE_PATH;
    } else {
        console.log('📂 Iniciando sem sessão prévia.');
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // --- 🚨 SEGURANÇA CONTRA FECHAMENTO ABRUPTO (CTRL+C) ---
    process.on('SIGINT', async () => {
        console.log('\n🛑 Interrupção detectada! Tentando salvar sessão antes de sair...');
        await saveSession(context, SESSION_FILE_PATH);
        console.log('✅ Sessão salva. Encerrando.');
        await browser.close();
        process.exit();
    });

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

    // Variáveis de controle
    const LOGIN_INDICATORS = 'input[type="email"], input[name*="user"], input[name*="login"], input[name*="identifier"]';
    let lastSaveTime = Date.now();

    console.log("🟢 MONITORAMENTO ATIVO: Sessão sendo salva a cada 5 segundos...");

    // --- 🔄 LOOP INFINITO ---
    while (true) {
        try {
            // 1. AUTO-SAVE PERIÓDICO (O "Pulo do Gato")
            // Salva a cada 5 segundos independente do que esteja acontecendo
            if (Date.now() - lastSaveTime > 5000) {
                await saveSession(context, SESSION_FILE_PATH);
                lastSaveTime = Date.now();
            }

            // 2. MONITORAMENTO DE LOGIN
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

                        // Força salvamento imediato após login bem sucedido
                        await saveSession(context, SESSION_FILE_PATH);
                        console.log("✅ Login feito e Sessão Salva.");
                    }
                }
            }

            await page.waitForTimeout(2000);

        } catch (error) {
            // Se o navegador fechar (Target closed), o script encerra
            if (error.message.includes('Target closed') || error.message.includes('closed')) {
                console.log("❌ Navegador fechado pelo usuário.");
                break;
            }
        }
    }
})();