const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Script para garantir o download do Chromium correto
// Especialmente útil para Mac ARM64 (M1/M2/M3)

const browsersPath = path.resolve(__dirname, '../browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;

console.log(`\n🚀 [NINJABR] Iniciando download do Chromium...`);
console.log(`📂 Destino: ${browsersPath}`);
console.log(`💻 Sistema: ${process.platform} | Arquitetura: ${os.arch()}`);

if (process.platform === 'darwin' && process.arch === 'x64' && os.arch() === 'arm64') {
    console.warn(`\n⚠️  [AVISO] Você está rodando Node.js Intel em um Mac ARM64 (M1/M2/M3).`);
    console.warn(`O Playwright pode baixar a versão Intel do Chromium por engano.`);
    console.warn(`Recomendamos usar uma versão ARM64 do Node.js para o build final.\n`);
}

try {
    if (!fs.existsSync(browsersPath)) {
        fs.mkdirSync(browsersPath, { recursive: true });
    }

    console.log(`📦 Executando: npx patchright install chromium`);

    // Executa o install do patchright
    execSync(`npx patchright install chromium`, {
        stdio: 'inherit',
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath }
    });

    console.log(`\n✅ [SUCESSO] Chromium instalado com sucesso em ./browsers`);
} catch (error) {
    console.error(`\n❌ [ERRO] Falha ao baixar o Chromium:`, error.message);
    process.exit(1);
}
