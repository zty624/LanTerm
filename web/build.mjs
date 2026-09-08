import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const output = process.env.LAN_TERMINAL_STATIC_DIR || 'static';
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['web/app.js'],
  bundle: true,
  minify: true,
  sourcemap: false,
  outfile: `${output}/app.js`,
  target: ['es2022'],
  legalComments: 'linked',
});
await copyFile('web/index.html', `${output}/index.html`);
