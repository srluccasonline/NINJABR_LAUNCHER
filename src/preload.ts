// ARQUIVO: src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

console.log('Preload script loaded successfully');

contextBridge.exposeInMainWorld('electronAPI', {
  // Front -> Electron: Iniciar App
  launchApp: (appId: string, token: string) => ipcRenderer.invoke('launch-app', { appId, token }),
  
  // Electron -> Front: Avisar que fechou (para mudar botão de volta)
  onAppClosed: (callback: (appId: string) => void) => 
    ipcRenderer.on('app-closed', (_event, value) => callback(value))
});