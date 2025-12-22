import { app } from 'electron';
import path from 'path';
import os from 'os';

export const IS_DEV = process.env.DEV === 'true' || !app.isPackaged;

// ==========================================================
// CONFIGURAÇÃO DE CAMINHOS DO BROWSER
// ==========================================================
const BROWSERS_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'browsers')
    : path.join(__dirname, '../../browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(BROWSERS_PATH);

// IMPORTANT: Require 'patchright' AFTER setting the env var, otherwise it ignores the custom path!
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const { chromium } = require('patchright');

if (IS_DEV) {
    console.log(`🔧 [SETUP] Playwright Browsers Path: ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
    try {
        console.log(`✅ [CHECK] Chromium Executable: ${chromium.executablePath()}`);
    } catch (e) {
        console.error(`❌ [CHECK] Falha ao verificar executável:`, e);
    }
    console.log(`💻 [SYSTEM] OS: ${process.platform} | Arch: ${os.arch()} | Runtime Arch: ${process.arch}`);
}
