import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    noExternal: ['@edusports/shared'],
  },
  {
    entry: { 'edusports-sdk': 'src/index.ts' },
    format: ['iife'],
    globalName: 'EduSports',
    platform: 'browser',
    sourcemap: true,
    noExternal: ['@edusports/shared', 'socket.io-client'],
    outExtension() {
      return { js: '.global.js' };
    },
  },
]);
