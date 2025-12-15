import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Lança um novo App (Navegador)
  launchApp: (args: any, token: string) => ipcRenderer.invoke('launch-app', args, token),

  // ☠️ KILL SWITCH: Fecha todos os navegadores abertos pelo Electron
  killAllApps: () => ipcRenderer.invoke('apps:kill-all'),

  // Ouve quando um app fecha sozinho (para atualizar a UI)
  onAppClosed: (callback: (event: any, id: string) => void) =>
    ipcRenderer.on('app-closed', callback),

  // Abre a pasta do download
  openDownloadFolder: (path: string) => ipcRenderer.invoke('downloads:open-folder', path)
});