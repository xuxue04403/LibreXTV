import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const coreAlias = resolve(__dirname, '../../packages/core/src/index.ts');

export default defineConfig({
  main: {
    // `undici` 必须被打进 bundle，不能外部化：`electron-builder.yml` 里
    // `'!node_modules/**'` 把整个 node_modules 排除在 asar 之外，运行时
    // `require('undici')` 会直接 "Cannot find module 'undici'" 崩在主进程。
    // 它是纯 JS，rollup 打进去没有额外代价。
    plugins: [externalizeDepsPlugin({ exclude: ['undici'] })],
    resolve: {
      // 顺序要紧：vite 的 alias 是**前缀**替换，`@librextv/core` 排前面的话，
      // `@librextv/core/seed-titles` 会先被它吃成 `.../index.ts/seed-titles` 再去加载，
      // 报 ENOENT。所以更长的那个必须写在前面。
      alias: {
        '@librextv/core/seed-titles': resolve(__dirname, '../../packages/core/src/seed-titles.ts'),
        '@librextv/core': coreAlias,
      },
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@librextv/core': coreAlias,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@defaults': resolve(__dirname, '../../defaults/sources.json'),
      },
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
