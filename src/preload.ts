// ARQUIVO: src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

try {
  console.log('[PRELOAD] Ativando Camuflagem: WebRTC Mock + Windows Spoof + Canvas Noise');

  // ===========================================================================
  // 1. WEBRTC MOCK (O "Falso Profissional")
  // ===========================================================================
  // Em vez de deletar (o que dá False), criamos classes falsas que não fazem nada.
  // O site acha que funcionou (True), mas nenhum IP é vazado.
  
  class FakeRTCDataChannel extends EventTarget {
      label: string;
      ordered: boolean = true;
      protocol: string = '';
      id: number = 0;
      readyState: string = 'open';
      bufferedAmount: number = 0;
      binaryType: string = 'blob';
      maxPacketLifeTime: number | null = null;
      maxRetransmits: number | null = null;
      negotiated: boolean = false;
      reliable: boolean = true;
      
      constructor(label: string) {
          super();
          this.label = label;
      }
      send() {}
      close() {}
  }

  class FakeRTCPeerConnection extends EventTarget {
      localDescription: any = null;
      remoteDescription: any = null;
      signalingState: string = 'stable';
      iceGatheringState: string = 'complete';
      iceConnectionState: string = 'connected';
      connectionState: string = 'connected';
      canTrickleIceCandidates: boolean | null = null;
      currentLocalDescription: any = null;
      currentRemoteDescription: any = null;
      pendingLocalDescription: any = null;
      pendingRemoteDescription: any = null;
      sctp: any = null;

      constructor(config?: any) {
          super();
      }
      
      createDataChannel(label: string) {
          return new FakeRTCDataChannel(label);
      }
      
      createOffer() {
          // Retorna um SDP falso inofensivo
          return Promise.resolve({
              type: 'offer',
              sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
          });
      }
      
      createAnswer() {
          return Promise.resolve({
              type: 'answer',
              sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
          });
      }
      
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      addIceCandidate() { return Promise.resolve(); }
      getConfiguration() { return {}; }
      getReceivers() { return []; }
      getSenders() { return []; }
      getTransceivers() { return []; }
      close() {}
      
      // Getters estáticos necessários
      static generateCertificate() { return Promise.resolve({ expires: Date.now() + 10000 }); }
  }

  // Substitui as globais pelas nossas versões falsas
  Object.defineProperty(window, 'RTCPeerConnection', { value: FakeRTCPeerConnection, writable: false, configurable: false });
  Object.defineProperty(window, 'webkitRTCPeerConnection', { value: FakeRTCPeerConnection, writable: false, configurable: false });
  Object.defineProperty(window, 'RTCDataChannel', { value: FakeRTCDataChannel, writable: false, configurable: false });
  
  // RTCSessionDescription e RTCIceCandidate podem ser nativos ou dummies simples
  const noop = function() {};
  Object.defineProperty(window, 'RTCSessionDescription', { value: noop, writable: false });
  Object.defineProperty(window, 'RTCIceCandidate', { value: noop, writable: false });


  // ===========================================================================
  // 2. FORJA WINDOWS (Navigator)
  // ===========================================================================
  const winUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.177 Safari/537.36';
  
  // Função helper para spoofing no protótipo (indetectável)
  const spoof = (obj: any, prop: string, value: any) => {
      try {
          Object.defineProperty(Object.getPrototypeOf(obj), prop, {
              get: () => value, enumerable: true, configurable: true
          });
      } catch(e) {}
  };

  spoof(navigator, 'platform', 'Win32');
  spoof(navigator, 'userAgent', winUA);
  spoof(navigator, 'appVersion', winUA.replace('Mozilla/', ''));
  spoof(navigator, 'vendor', 'Google Inc.');
  spoof(navigator, 'webdriver', false); // IMPORTANTE: FALSE, não undefined

  // Client Hints
  if ((navigator as any).userAgentData) {
    const brands = [
        { brand: "Not(A:Brand", version: "99" },
        { brand: "Google Chrome", version: "142" },
        { brand: "Chromium", version: "142" }
    ];
    const data = {
        brands: brands,
        mobile: false,
        platform: 'Windows',
        platformVersion: '10.0.0',
        architecture: 'x86',
        bitness: '64',
        uaFullVersion: '142.0.7444.177',
        fullVersionList: brands
    };
    
    // Spoof profundo na Promise
    Object.defineProperty(navigator, 'userAgentData', {
      value: Object.freeze({
        ...data,
        getHighEntropyValues: async () => data,
        toJSON: () => data
      }),
      writable: false
    });
  }

  // ===========================================================================
  // 3. WEBGL SPOOFING
  // ===========================================================================
  try {
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      const spoofGL = (ctx: any) => {
          const orig = ctx.getParameter;
          ctx.getParameter = function(p: number) {
              if (p === 37445) return 'Google Inc. (NVIDIA)';
              if (p === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)';
              return orig.apply(this, [p]);
          };
      };
      
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type: string, ...args: any[]) {
          const ctx = origGetContext.apply(this, [type, ...args]);
          if (ctx && (type.includes('webgl'))) spoofGL(ctx);
          return ctx;
      };
  } catch(e) {}

  // ===========================================================================
  // 4. CANVAS NOISE (Consistente)
  // ===========================================================================
  try {
      const noise = { r: 1, g: -1, b: 0, a: 0 }; // Ruído fixo para consistência de time
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      
      CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
          const img = origGetImageData.apply(this, [x, y, w, h]);
          for (let i = 0; i < img.data.length; i += 16) { 
              img.data[i] += noise.r;
              img.data[i+1] += noise.g;
          }
          return img;
      };
  } catch(e) {}

  console.log('[PRELOAD] Stealth Completo.');

} catch(err) {
  console.error('[PRELOAD] Erro:', err);
}

// =============================================================================
// IPC BRIDGE
// =============================================================================
const electronAPI = {
  launchApp: (appId: string, token: string) => ipcRenderer.invoke('launch-app', { appId, token }),
  onAppClosed: (callback: (appId: string) => void) => 
    ipcRenderer.on('app-closed', (_event, value) => callback(value))
};

try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (error) {
  // @ts-ignore
  window.electronAPI = electronAPI;
}