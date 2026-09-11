import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, createConnection } from 'node:net';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(target, prefix) {
  const folder = await mkdtemp(join(tmpdir(), 'lt-ssh-browser-'));
  const port = await freePort();
  const ssh = await freePort();
  const password = randomBytes(24).toString('base64url');
  const url = `http://127.0.0.1:${port}${prefix}`;
  const proc = spawn(
    '.venv/bin/python',
    [
      'launch.py',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--state-dir',
      folder,
      '--cwd',
      folder,
      '--shell',
      'bash',
      '--plugins',
      'none',
      '--experimental-ssh',
      '--ssh-listen-port',
      String(ssh),
      '--ssh-target-port',
      String(target),
      '--public-url',
      `${url}/`,
    ],
    { env: { ...process.env, LAN_TERMINAL_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '';
  proc.stdout.on('data', (data) => {
    logs += data;
  });
  proc.stderr.on('data', (data) => {
    logs += data;
  });
  async function stop() {
    if (proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill('SIGTERM');
      await exited;
    }
    await rm(folder, { recursive: true, force: true });
    expect(logs).not.toContain('Traceback');
  }
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) {
      await stop();
      throw new Error('SSH service exited');
    }
    const response = await fetch(`${url}/api/health`).catch(() => null);
    if (response?.ok) return { url, ssh, password, stop };
    await pause(100);
  }
  await stop();
  throw new Error('SSH service startup timed out');
}

async function login(page, service) {
  await page.goto(`${service.url}/ssh`);
  await page.locator('#password').fill(service.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('#controls')).toBeVisible();
}

function exchange(socket, payload) {
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    function data(chunk) {
      output = Buffer.concat([output, chunk]);
      if (output.length >= payload.length) {
        socket.off('data', data);
        socket.off('error', reject);
        resolve(output);
      }
    }
    socket.on('data', data);
    socket.once('error', reject);
    socket.write(payload);
  });
}

test('browser pairs two instances and preserves TCP over WS interruption', async ({ browser }) => {
  const echo = createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const services = [];
  const errors = [];
  let socket;
  const context = await browser.newContext();
  try {
    const local = await start(echo.address().port, '');
    services.push(local);
    const remote = await start(echo.address().port, '/notebook/proxy/8766');
    services.push(remote);
    const localPage = await context.newPage();
    const remotePage = await context.newPage();
    for (const page of [localPage, remotePage])
      page.on('pageerror', (error) => errors.push(error.message));
    await login(localPage, local);
    await localPage.locator('#remote-url').fill(`${remote.url}/`);
    await localPage.getByRole('button', { name: '生成配对信息' }).click();
    await expect(localPage.locator('#pair-output')).toBeVisible();
    const pair = await localPage.locator('#pair-code').inputValue();
    await login(remotePage, remote);
    await remotePage.locator('#pair-input').fill(pair);
    await remotePage.getByRole('button', { name: '连接隧道', exact: true }).click();
    await expect(remotePage.locator('#status')).toContainText('已连接');
    socket = createConnection({ host: '127.0.0.1', port: local.ssh });
    const first = randomBytes(128 * 1024);
    expect(await exchange(socket, first)).toEqual(first);
    await remotePage.getByRole('button', { name: '模拟 WS 断线并重连' }).click();
    const second = randomBytes(1024 * 1024);
    expect(await exchange(socket, second)).toEqual(second);
    await expect(remotePage.locator('#status')).toContainText('已连接');
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await remotePage.getByRole('button', { name: '停止隧道', exact: true }).click();
    await closed;
    expect(errors).toEqual([]);
  } finally {
    socket?.destroy();
    await context.close();
    for (const service of services) await service.stop();
    await new Promise((resolve) => echo.close(resolve));
  }
});
