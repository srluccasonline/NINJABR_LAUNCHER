import { App, Session } from "electron";

// CONSTANTES DO CHROME 142 (Windows)
// Devem ser IDÊNTICAS ao que está no preload.ts
export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.177 Safari/537.36';

const CH_BRANDS = '"Not(A:Brand";v="99", "Google Chrome";v="142", "Chromium";v="142"';
const CH_FULL_VERSIONS = '"Not(A:Brand";v="99.0.0.0", "Google Chrome";v="142.0.7444.177", "Chromium";v="142.0.7444.177"';
const CH_PLATFORM_VER = '"10.0.0"'; // Windows 10/11

/**
 * Aplica as flags de linha de comando
 */
export function applyStealthFlags(app: App) {
    // Anti-Automação
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
    app.commandLine.appendSwitch('disable-infobars');
    
    // Rede e Segurança
    app.commandLine.appendSwitch('disable-quic');
    app.commandLine.appendSwitch('disable-http2');
    app.commandLine.appendSwitch('ignore-certificate-errors');
    app.commandLine.appendSwitch('allow-insecure-localhost');
    app.commandLine.appendSwitch('ssl-version-min', 'tls1.0');
    app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
    
    // Linux / Hardware
    app.commandLine.appendSwitch('disable-dev-shm-usage');
    // app.commandLine.appendSwitch('disable-gpu'); // Mantenha comentado se quiser WebGL ativo (Cloudflare gosta de WebGL)
    
    // NOTA: Removemos no-sandbox pois causava crash no seu Linux
    // app.commandLine.appendSwitch('no-sandbox'); 
    
    app.commandLine.appendSwitch('lang', 'pt-BR');

    // WebRTC Kill (Nível Processo)
    app.commandLine.appendSwitch('enforce-webrtc-ip-permission-check');
    app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

    // Google Bypass Global (Define antes da janela abrir)
    app.userAgentFallback = USER_AGENT;
}

/**
 * Configura os cabeçalhos HTTP da sessão para parecer Windows legítimo
 */
export function configureSessionHeaders(session: Session) {
    // 1. Define UA na Sessão
    session.setUserAgent(USER_AGENT);

    // 2. Intercepta Headers para injetar Client Hints (Sec-CH-UA)
    session.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;
        
        // Remove rastros originais do Electron (que entregam Linux/Electron)
        delete headers['Sec-CH-UA'];
        delete headers['Sec-CH-UA-Mobile'];
        delete headers['Sec-CH-UA-Platform'];
        delete headers['Sec-CH-UA-Full-Version-List'];
        delete headers['X-Client-Data']; // Google Track

        // Injeta identidade Windows + Chrome 142
        headers['User-Agent'] = USER_AGENT;
        
        // Client Hints Críticos
        headers['sec-ch-ua'] = CH_BRANDS;
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Windows"';
        headers['sec-ch-ua-platform-version'] = CH_PLATFORM_VER;
        headers['sec-ch-ua-arch'] = '"x86"';
        headers['sec-ch-ua-bitness'] = '"64"';
        headers['sec-ch-ua-full-version-list'] = CH_FULL_VERSIONS;
        
        callback({ requestHeaders: headers });
    });
}