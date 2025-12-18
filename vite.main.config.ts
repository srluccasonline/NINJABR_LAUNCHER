import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
    build: {
        rollupOptions: {
            // Adicionei módulos que precisam ser externos e copiados manualmente
            external: ['patchright', 'patchright-core', 'electron-squirrel-startup', 'update-electron-app', 'ms'],
        },
    },
});