import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
      prefix ? '--experimental-ssh' : '--ssh',
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

async function login(page, service, role = 'local') {
  await page.goto(`${service.url}/ssh?role=${role}`);
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
    await expect(localPage.locator('#connect-form')).toBeHidden();
    await localPage.locator('#remote-url').fill(`${local.url}/`);
    await localPage.getByRole('button', { name: '生成配对信息', exact: true }).click();
    await expect(localPage.getByRole('alert')).toContainText('当前本机页面');
    await localPage.locator('#remote-url').fill(`${remote.url}/`);
    await localPage.getByRole('button', { name: '生成配对信息', exact: true }).click();
    await expect(localPage.locator('#pair-output')).toBeVisible();
    const pair = await localPage.locator('#pair-code').inputValue();
    await expect(localPage.locator('#open-remote')).toHaveAttribute(
      'href',
      `${remote.url}/ssh?role=remote`,
    );
    await login(remotePage, remote, 'remote');
    await expect(remotePage.locator('#pair-form')).toBeHidden();
    // Cookies are sent to the target on the same site even from another port.
    // The remote endpoint must reject that page's Origin before accepting WS.
    expect(
      await localPage.evaluate(
        (url) =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ssh/bridge/remote`);
            const timer = setTimeout(() => {
              ws.close();
              reject(new Error('Cross-origin WebSocket did not finish'));
            }, 5000);
            ws.onopen = () => {
              clearTimeout(timer);
              ws.close();
              resolve(true);
            };
            ws.onclose = () => {
              clearTimeout(timer);
              resolve(false);
            };
          }),
        remote.url,
      ),
    ).toBe(false);
    const wrong = JSON.parse(pair);
    wrong.remote = `${remote.url}/other/ssh`;
    await remotePage.locator('#pair-input').fill(JSON.stringify(wrong));
    await remotePage.getByRole('button', { name: '连接隧道', exact: true }).click();
    await expect(remotePage.getByRole('alert')).toContainText('远端路径与配对目标不一致');
    await remotePage.locator('#pair-input').fill(pair);
    await remotePage.getByRole('button', { name: '连接隧道', exact: true }).click();
    await expect(remotePage.locator('#status')).toContainText('已连接');
    await expect(remotePage.locator('#copy-command')).toBeDisabled();
    await remotePage.getByLabel('远端 SSH 用户名', { exact: true }).fill('developer');
    await expect(remotePage.locator('#command')).toHaveText(
      `ssh -p ${local.ssh} developer@127.0.0.1`,
    );
    await expect(remotePage.locator('#copy-command')).toBeEnabled();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await remotePage.locator('#copy-command').click();
    expect(await remotePage.evaluate(() => navigator.clipboard.readText())).toBe(
      `ssh -p ${local.ssh} developer@127.0.0.1`,
    );
    await mkdir('.runtime', { recursive: true });
    // The remote input has been cleared; screenshots contain no pairing credentials.
    await remotePage.screenshot({ path: '.runtime/ssh-desktop.png', fullPage: true });
    await remotePage.setViewportSize({ width: 390, height: 844 });
    await remotePage.screenshot({ path: '.runtime/ssh-mobile.png', fullPage: true });
    expect(
      await remotePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    socket = createConnection({ host: '127.0.0.1', port: local.ssh });
    const first = randomBytes(128 * 1024);
    expect(await exchange(socket, first)).toEqual(first);
    await remotePage.getByText('连接帮助与诊断', { exact: true }).click();
    await remotePage.getByRole('button', { name: '测试断线重连' }).click();
    const second = randomBytes(1024 * 1024);
    expect(await exchange(socket, second)).toEqual(second);
    await expect(remotePage.locator('#status')).toContainText('已连接');
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await remotePage.getByRole('button', { name: '停止隧道', exact: true }).click();
    await closed;
    await expect(remotePage.locator('#command-panel')).toBeHidden();
    // A user stop on the remote side ends the local pairing as well.
    await expect(localPage.locator('#local-status')).toContainText('尚未配对');
    await expect(localPage.locator('#revoke')).toBeHidden();
    // The local page can also revoke a fresh pairing explicitly.
    await localPage.getByRole('button', { name: '生成配对信息', exact: true }).click();
    await expect(localPage.locator('#local-status')).toContainText('配对已生成');
    await localPage.locator('#revoke').click();
    await expect(localPage.locator('#local-status')).toContainText('尚未配对');
    await expect(localPage.locator('#pair-output')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    socket?.destroy();
    await context.close();
    for (const service of services) await service.stop();
    await new Promise((resolve) => echo.close(resolve));
  }
});
