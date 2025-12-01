// ARQUIVO: src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// =============================================================================
// STEALTH MODE (Cópia fiel do seu JS funcional)
// =============================================================================
try {
  console.log('[PRELOAD] Aplicando Stealth Windows...');

  // 1) DESLIGA WEBRTC
  const noop = () => {};
  const dummy = new Proxy(noop, { get: () => noop });

  Object.defineProperty(window, 'RTCPeerConnection', {
    value: dummy, writable: false, configurable: false
  });
  Object.defineProperty(window, 'RTCSessionDescription', {
    value: dummy, writable: false, configurable: false
  });
  Object.defineProperty(window, 'RTCIceCandidate', {
    value: dummy, writable: false, configurable: false
  });
  Object.defineProperty(window, 'RTCDataChannel', {
    value: dummy, writable: false, configurable: false
  });

  // 2) FORJA WINDOWS
  Object.defineProperty(navigator, 'platform', {
    value: 'Win32', writable: false, configurable: false
  });

  const winUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.177 Safari/537.36';
  Object.defineProperty(navigator, 'userAgent', {
    value: winUA, writable: false, configurable: false
  });
  Object.defineProperty(navigator, 'appVersion', {
    value: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.177 Safari/537.36',
    writable: false, configurable: false
  });

  // 3) FORJA userAgentData = Windows (Reutilizando a base)
  // @ts-ignore
  if (navigator.userAgentData) {
    // @ts-ignore
    const base = navigator.userAgentData.toJSON();
    
    const customData = {
      brands: base.brands,
      mobile: base.mobile,
      platform: 'Windows', // A MENTIRA
      platformVersion: '10.0.0',
      architecture: 'x86',
      bitness: '64',
      fullVersionList: base.fullVersionList,
      uaFullVersion: '142.0.7444.177'
    };

    Object.defineProperty(navigator, 'userAgentData', {
      value: Object.freeze({
        ...customData,
        getHighEntropyValues: async () => customData,
        toJSON: () => customData
      }),
      writable: false, configurable: false
    });
  }

} catch(err) {
  // Ignora erros (acontece no painel admin que é isolado)
}

// =============================================================================
// IPC BRIDGE HÍBRIDO (Para o Botão funcionar)
// =============================================================================
const api = {
  launchApp: (appId: string, token: string) => ipcRenderer.invoke('launch-app', { appId, token }),
  onAppClosed: (callback: (appId: string) => void) => 
    ipcRenderer.on('app-closed', (_event, value) => callback(value))
};

try {
  contextBridge.exposeInMainWorld('electronAPI', api);
} catch (error) {
  // Se falhar (no App onde contextIsolation: false), injeta direto
  // @ts-ignore
  window.electronAPI = api;
}