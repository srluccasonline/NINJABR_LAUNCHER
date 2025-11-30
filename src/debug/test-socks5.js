const { app, session, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const sess = session.fromPartition('relay-test');

  // Agora é HTTP simples, sem auth
  await sess.setProxy({
    proxyRules: 'http=127.0.0.1:8899',
    proxyBypassRules: '<local>',
  });

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: { session: sess },
  });

  await win.loadURL('https://browserleaks.com/ip');
  win.webContents.openDevTools();
});