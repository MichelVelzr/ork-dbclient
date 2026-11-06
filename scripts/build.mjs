import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [fileURLToPath(new URL('../src/main.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/main.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  external: ['node:*'],
  banner: {
    js: "import { createRequire as __orcaCreateRequire } from 'node:module'; const require = __orcaCreateRequire(import.meta.url);"
  },
  sourcemap: false,
  minify: false
});

await build({
  entryPoints: [fileURLToPath(new URL('../src/panel.js', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/panel.js', import.meta.url)),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome120'],
  sourcemap: false,
  minify: true,
  loader: { '.css': 'css' }
});

await cp(new URL('../src/panel.html', import.meta.url), new URL('../dist/panel.html', import.meta.url));
console.log('Build complete: dist/main.mjs and dist/panel.html');
