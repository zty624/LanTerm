import { test as base, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const test = base.extend({
  service: async ({}, use) => {
    const folder = await mkdtemp(join(tmpdir(), 'lt-e2e-'));
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const password = randomBytes(24).toString('base64url');
    let proc;
    let logs = '';
    const start = async () => {
      proc = spawn('.venv/bin/python', ['launch.py', '--host', '127.0.0.1', '--port', String(port), '--state-dir', folder, '--cwd', folder, '--shell', 'bash'], {
        env: { ...process.env, LAN_TERMINAL_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.stdout.on('data', (chunk) => { logs += chunk; });
      proc.stderr.on('data', (chunk) => { logs += chunk; });
      for (let attempt = 0; attempt < 100; attempt++) {
        if (proc.exitCode !== null) throw new Error(`Server failed: ${logs}`);
        const response = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
        if (response?.ok) return;
        await pause(100);
      }
      throw new Error(`Server startup timed out: ${logs}`);
    };
    const stop = async () => {
      if (proc.exitCode !== null) return;
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill('SIGTERM');
      await exited;
    };
    try {
      await start();
      await use({ url: `http://127.0.0.1:${port}`, password, folder, restart: async () => { await stop(); await start(); } });
      expect(logs).not.toContain('Traceback');
    } finally {
      await stop();
      await exec('tmux', ['-S', join(folder, 'tmux.sock'), 'kill-server']).catch((error) => {
        if (!/no server running|No such file/.test(error.stderr)) throw error;
      });
      await rm(folder, { recursive: true, force: true });
    }
  },
});

async function login(page, service) {
  await page.goto(service.url);
  await page.getByLabel('访问密码', { exact: true }).fill(service.password);
  await page.getByRole('button', { name: '连接终端' }).click();
  await expect(page.locator('#workspace')).toBeVisible();
}

async function run(page, command) {
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test('real terminal UI, Vim, sessions, reconnect, service restart and mobile layout', async ({ page, service }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, service);
  await page.getByRole('button', { name: '创建第一个会话' }).click();
  await page.getByLabel('会话名称').fill('Workspace');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await run(page, "stty -echo; export LT_UI_VALUE=retained; printf 'browser:%s\\n' ready");
  await expect(page.locator('.xterm-rows')).toContainText('browser:ready');
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('会话名称').fill('开发 · Vim');
  await page.getByRole('button', { name: '保存名称' }).click();
  await expect(page.locator('#active-name')).toHaveText('开发 · Vim');
  await run(page, 'vim -Nu NONE -n browser.txt');
  await page.keyboard.press('i');
  await page.keyboard.type('Browser terminal works');
  await page.keyboard.press('Escape');
  await expect(page.locator('.xterm-rows')).toContainText('Browser terminal works');
  await expect(page.locator('.xterm-rows')).not.toContainText('-- INSERT --');
  // Refresh while inside a full-screen application; tmux redraws its real screen.
  await page.reload();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await expect(page.locator('.xterm-rows')).toContainText('Browser terminal works');
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await run(page, "printf 'saved:%s\\n' \"$(cat browser.txt)\"");
  await expect(page.locator('.xterm-rows')).toContainText('saved:Browser terminal works');
  await page.setViewportSize({ width: 1200, height: 760 });
  await expect.poll(async () => {
    const response = await page.request.get(`${service.url}/api/sessions`);
    return (await response.json())[0].clients;
  }).toBe(1);
  await run(page, "printf 'dimensions:%s\\n' \"$(stty size)\"");
  const [cols, rows] = (await page.locator('#terminal-size').textContent()).split(' × ');
  await expect(page.locator('.xterm-rows')).toContainText(`dimensions:${rows} ${cols}`);
  await page.getByRole('button', { name: /新建会话/ }).click();
  await page.getByLabel('会话名称').fill('Second session');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.locator('#active-name')).toHaveText('Second session');
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await run(page, "printf 'independent:%s\\n' \"${LT_UI_VALUE:-empty}\"");
  await expect(page.locator('.xterm-rows')).toContainText('independent:empty');
  await page.locator('.session-item').filter({ hasText: '开发 · Vim' }).click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await run(page, "printf 'restored:%s\\n' \"$LT_UI_VALUE\"");
  await expect(page.locator('.xterm-rows')).toContainText('restored:retained');
  await service.restart();
  await expect(page.locator('#login-screen')).toBeVisible({ timeout: 20000 });
  await login(page, service);
  await expect(page.locator('#active-name')).toHaveText('开发 · Vim');
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await run(page, "printf 'service-restart:%s\\n' \"$LT_UI_VALUE\"");
  await expect(page.locator('.xterm-rows')).toContainText('service-restart:retained');
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await expect(page.locator('#history-content')).toContainText('service-restart:retained');
  await page.getByRole('button', { name: '关闭历史', exact: true }).click();
  await run(page, 'clear');
  await run(page, "printf '\\033[1;32m%s\\033[0m\\n' 'LAN Terminal — ready'; printf '%s\\n' 'Real Bash / Zsh sessions' 'Vim · Codex · SSH · your everyday tools' 'Sessions survive browser and server reconnects.'; printf '\\n' ");
  await expect(page.locator('.xterm-rows')).toContainText('LAN Terminal — ready');
  await mkdir('.runtime', { recursive: true });
  await page.screenshot({ path: '.runtime/webui-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#terminal')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.runtime/webui-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#close-session').click();
  await page.getByRole('button', { name: '结束会话', exact: true }).click();
  await expect(page.locator('#active-name')).toHaveText('Second session');
  expect(errors).toEqual([]);
});
