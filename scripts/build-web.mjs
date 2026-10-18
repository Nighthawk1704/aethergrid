// Bundles the browser client (src/client-web/main.ts) into dist/web with esbuild.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWeb() {
  const out = resolve(root, 'dist/web');
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [resolve(root, 'src/client-web/main.ts')],
    outfile: resolve(out, 'app.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    minify: false,
    logLevel: 'warning',
  });
  copyFileSync(resolve(root, 'src/client-web/index.html'), resolve(out, 'index.html'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWeb();
  console.log('web client built -> dist/web');
}
