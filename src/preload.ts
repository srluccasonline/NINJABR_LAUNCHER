import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  launchApp: (args: any) => ipcRenderer.invoke('launch-app', args),
  onAppClosed: (callback: (event: any, appId: string) => void) => ipcRenderer.on('app-closed', callback),
});
