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
await copyFile('web/lantern.svg', `${output}/lantern.svg`);

await build({
  entryPoints: ['web/ssh.js', 'web/ssh.css'],
  bundle: true,
  minify: true,
  outdir: output,
  target: ['es2022'],
});
await copyFile('web/ssh.html', `${output}/ssh.html`);
