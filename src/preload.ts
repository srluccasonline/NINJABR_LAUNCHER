import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  launchApp: (args: any) => ipcRenderer.invoke('launch-app', args),
});
