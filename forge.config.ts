import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { PublisherGithub } from '@electron-forge/publisher-github';

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
    // O Forge detecta automaticamente .ico (Win) e .icns (Mac) se o nome base for esse
    // Como os arquivos estao em pastas separadas, selecionamos baseado na plataforma
    // Se estiver no Mac, usa o .icns. Se estiver no Windows ou Linux (buildando para Win), usa o .ico
    icon: path.resolve(__dirname, `imgs/icons/${process.platform === 'darwin' ? 'mac/icon.icns' : 'win/icon.ico'}`),
    extraResource: [
      './browsers'
    ],
    asar: {
      unpack: '*.{node,dll}',
      unpackDir: '{**/node_modules/patchright/**,**/node_modules/patchright-core/**}',
    },
  },
  rebuildConfig: {},
  makers: [
    // WINDOWS - Cria o Setup.exe e configura auto-update
    new MakerSquirrel({
      // Garante que o instalador (Setup.exe) tenha o icone correto
      setupIcon: path.resolve(__dirname, 'imgs/icons/win/icon.ico'),
    }),

    // MACOS - Cria apenas o ZIP (o mais compatível sem assinatura paga)
    new MakerZIP({}, ['darwin']),

    // LINUX
    new MakerRpm({
      options: {
        icon: path.resolve(__dirname, 'imgs/icons/png/512x512.png'),
      }
    }),
    new MakerDeb({
      options: {
        icon: path.resolve(__dirname, 'imgs/icons/png/512x512.png'),
      }
    }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: 'srluccasonline',
        name: 'NINJABR_LAUNCHER'
      },
      prerelease: false,
      draft: true // Cria como Rascunho. Você revisa no GitHub e clica em "Publicar".
    })
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
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
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