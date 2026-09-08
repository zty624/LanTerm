import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('static', { recursive: true });
await build({
  entryPoints: ['web/app.js'],
  bundle: true,
  minify: true,
  sourcemap: false,
  outfile: 'static/app.js',
  target: ['es2022'],
  legalComments: 'linked',
});
await copyFile('web/index.html', 'static/index.html');
