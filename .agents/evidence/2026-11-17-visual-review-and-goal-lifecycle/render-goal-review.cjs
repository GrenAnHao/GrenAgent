const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1120, height: 650, show: false, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true } });
  await win.loadFile(join(__dirname, 'goal-editor-review-v1.html'));
  await win.webContents.executeJavaScript('document.fonts.ready');
  const image = await win.webContents.capturePage();
  writeFileSync(join(__dirname, 'goal-editor-review-v1.png'), image.toPNG());
  win.destroy(); app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
