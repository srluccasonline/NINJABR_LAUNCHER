import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import fs from 'fs';
import path from 'path';

const config: ForgeConfig = {
  hooks: {
    packageAfterPrune: async (_config, buildPath) => {
      const modulesToCopy = ['patchright', 'patchright-core'];
      for (const moduleName of modulesToCopy) {
        const src = path.resolve(__dirname, 'node_modules', moduleName);
        const dest = path.join(buildPath, 'node_modules', moduleName);

        if (fs.existsSync(src)) {
          console.log(`[HOOK] Copying ${moduleName} to build...`);
          await fs.promises.cp(src, dest, { recursive: true });
        } else {
          console.warn(`[HOOK] Could not find ${moduleName} to copy.`);
        }
      }
    }
  },
  packagerConfig: {
    icon: 'imgs/icon', // Verifique se o ícone existe
    // 1. COPIA O CHROMIUM BAIXADO
    extraResource: [
      './browsers'
    ],
    // 2. TIRA O PATCHRIGHT DE DENTRO DO ARQUIVO COMPRIMIDO (ASAR)
    asar: {
      unpack: '*.{node,dll}',
      unpackDir: '{**/node_modules/patchright/**,**/node_modules/patchright-core/**}',
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts', // Certifique-se que esse arquivo existe
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts', // Certifique-se que esse arquivo existe
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;