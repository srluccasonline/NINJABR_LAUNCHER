import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
    build: {
        rollupOptions: {
            // Adicionei playwright-core por segurança
            external: ['patchright', 'patchright-core'],
        },
    },
});