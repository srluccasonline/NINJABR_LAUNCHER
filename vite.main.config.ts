import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
    build: {
        rollupOptions: {
            // Apenas patchright deve ser externo (binários nativos)
            external: ['patchright', 'patchright-core'],
        },
    },
});