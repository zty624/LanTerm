import { test as base, expect } from '@playwright/test';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const test = base.extend({
  prefix: ['', { option: true }],
  service: async ({ prefix }, use) => {
    const folder = await mkdtemp(join(tmpdir(), 'lt-e2e-'));
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const password = randomBytes(24).toString('base64url');
    let proc;
    let logs = '';
    const start = async () => {
      proc = spawn('.venv/bin/python', ['launch.py', '--host', '127.0.0.1', '--port', String(port), '--state-dir', folder, '--cwd', folder, '--shell', 'bash', ...(prefix ? ['--public-url', `http://127.0.0.1:${port}${prefix}/`] : [])], {
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
      await use({ url: `http://127.0.0.1:${port}${prefix}`, password, folder, restart: async () => { await stop(); await start(); } });
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

test.describe('cluster proxy path', () => {
  test.use({ prefix: '/notebook/proxy/8766' });
  test('assets, login cookie, API and terminal work behind a path prefix', async ({ page, service }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, service);
    await expect(page).toHaveURL(service.url + '/');
    await page.locator('#new-session').click();
    await page.getByLabel('会话名称', { exact: true }).fill('Proxied terminal');
    await page.getByRole('button', { name: '创建会话', exact: true }).click();
    await expect(page.locator('#connection-status')).toHaveText('已连接');
    await run(page, "printf 'proxy:%s\\n' working");
    await expect(page.locator('.xterm-rows')).toContainText('proxy:working');
    await page.locator('#show-monitor').click();
    await expect(page.locator('#metric-cards .metric-card')).toHaveCount(6);
    await page.locator('#logout').click();
    await expect(page.locator('#login-screen')).toBeVisible();
    expect(errors).toEqual([]);
  });
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

test('Codex plugin updates inactive sessions, survives restart and sends Ctrl+/', async ({ page, service }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, service);
  await page.locator('#new-session').click();
  await page.getByLabel('会话名称', { exact: true }).fill('Codex development');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  const session = (await (await page.request.get(service.url + '/api/sessions')).json())[0];
  const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";
  await run(page, [resolve('.venv/bin/python'), resolve('tests/fixtures/codex_process.py')].map(quote).join(' '));
  await expect(page.locator('.xterm-rows')).toContainText('fixture:ready');
  const badge = page.locator(`[data-plugin-session="${session.id}"] .plugin-badge`);
  await expect(badge).toHaveText('Codex · 等待输入');
  await page.locator('#show-keys').click();
  await page.getByRole('button', { name: 'Ctrl+/', exact: true }).click();
  await expect.poll(async () => ((await page.locator('.xterm-rows').innerText()).match(/shortcut:1f/g) || []).length).toBe(1);
  await page.keyboard.press('Control+/');
  await expect.poll(async () => ((await page.locator('.xterm-rows').innerText()).match(/shortcut:1f/g) || []).length).toBe(2);
  await page.locator('#new-session').click();
  await page.getByLabel('会话名称', { exact: true }).fill('Other terminal');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  const send = (key) => exec('tmux', ['-S', join(service.folder, 'tmux.sock'), 'send-keys', '-t', `lt-${session.id}`, key]);
  await send('w');
  await expect(badge).toHaveText('Codex · Working · 工作中');
  await expect(page.locator('#active-name')).toHaveText('Other terminal');
  await page.route('**/api/plugins/status', (route) => route.abort());
  await expect(badge).toHaveText('Codex · 状态暂不可用');
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await page.unroute('**/api/plugins/status');
  await expect(badge).toHaveText('Codex · Working · 工作中');
  await send('a');
  await expect(badge).toHaveText('Codex · 等待确认 / 输入');
  await mkdir('.runtime', { recursive: true });
  await page.screenshot({ path: '.runtime/codex-status-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#toggle-sidebar').click();
  await expect(badge).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.runtime/codex-status-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await send('i');
  await expect(badge).toHaveText('Codex · 等待输入');
  await service.restart();
  await expect(page.locator('#login-screen')).toBeVisible({ timeout: 20000 });
  await login(page, service);
  await expect(badge).toHaveText('Codex · 等待输入');
  await send('q');
  await expect(badge).toHaveText('Codex · 已退出');
  expect(errors).toEqual([]);
});

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
  const oldSize = await page.locator('#terminal-size').textContent();
  await page.setViewportSize({ width: 1200, height: 760 });
  await expect(page.locator('#terminal-size')).not.toHaveText(oldSize);
  await expect.poll(async () => {
    const response = await page.request.get(`${service.url}/api/sessions`);
    return (await response.json())[0].clients;
  }).toBe(1);
  const [cols, rows] = (await page.locator('#terminal-size').textContent()).split(' × ');
  await expect.poll(async () => {
    const output = await exec('tmux', ['-S', join(service.folder, 'tmux.sock'), 'list-panes', '-a', '-F', '#{pane_height} #{pane_width}']);
    return output.stdout.trim();
  }).toBe(`${rows} ${cols}`);
  await run(page, "printf 'dimensions:%s\\n' \"$(stty size)\"");
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
  await run(page, "printf '\\033[1;32m%s\\033[0m\\n' 'LanTerm — ready'; printf '%s\\n' 'Real Bash / Zsh sessions' 'Vim · Codex · SSH · your everyday tools' 'Sessions survive browser and server reconnects.'; printf '\\n' ");
  await expect(page.locator('.xterm-rows')).toContainText('LanTerm — ready');
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

test('session organization, batch actions and resource dashboard preserve terminals', async ({ page, service }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, service);
  await page.locator('#new-session').click();
  await page.getByLabel('会话名称', { exact: true }).fill('Training A');
  await page.getByLabel('分组', { exact: true }).fill('实验');
  await page.getByLabel('标签', { exact: true }).fill('gpu, train');
  await page.getByLabel('备注', { exact: true }).fill('检查模型输出');
  await page.getByRole('button', { name: '创建会话', exact: true }).click();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await run(page, "export LT_MANAGE=keep; printf 'managed:%s\\n' ready");
  await expect(page.locator('.xterm-rows')).toContainText('managed:ready');
  await page.locator('#pin-session').click();
  await expect(page.locator('.session-item[aria-current="true"] .session-icon')).toHaveText('★');
  const original = (await (await page.request.get(service.url + '/api/sessions')).json())[0];
  await page.locator('#duplicate-session').click();
  await expect(page.locator('#active-name')).toHaveText('Training A 副本');
  await page.getByLabel('搜索会话').fill('gpu');
  await expect(page.locator('.session-item')).toHaveCount(2);
  await page.getByLabel('筛选状态').selectOption('pinned');
  await expect(page.locator('.session-item')).toHaveCount(1);
  await expect(page.locator('.session-item')).toContainText('Training A');
  await page.getByLabel('筛选状态').selectOption('all');
  await page.getByLabel('搜索会话').fill('');
  await page.locator('#batch-mode').click();
  await page.getByRole('checkbox', { name: '选择 Training A', exact: true }).check();
  await page.getByRole('checkbox', { name: '选择 Training A 副本', exact: true }).check();
  await page.locator('#batch-group').click();
  await expect(page.locator('#batch-preview li')).toHaveCount(2);
  await page.getByLabel('目标分组').fill('Run 2026');
  await page.locator('#batch-submit').click();
  await page.getByLabel('筛选分组').selectOption('group:Run 2026');
  await expect(page.locator('.session-item')).toHaveCount(2);
  await page.locator('#show-monitor').click();
  await expect(page.locator('#monitor-view')).toBeVisible();
  await expect(page.locator('#metric-cards .metric-card')).toHaveCount(6);
  await expect(page.locator('#session-resources tr')).toHaveCount(2);
  await expect(page.locator('#monitor-scope')).toContainText('cgroup');
  await page.locator(`#session-resources tr[data-sid="${original.id}"]`).getByRole('button', { name: '进程', exact: true }).click();
  await expect(page.locator('#details-title')).toHaveText('Training A');
  await expect(page.locator('#details-note')).toHaveText('检查模型输出');
  await expect(page.locator('#process-table')).toContainText('bash');
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.screenshot({ path: '.runtime/monitor-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.runtime/monitor-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(`[data-session-id="${original.id}"]`).click();
  await expect(page.locator('#terminal')).toBeVisible();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await run(page, "printf 'still:%s\\n' \"$LT_MANAGE\"");
  await expect(page.locator('.xterm-rows')).toContainText('still:keep');
  await page.getByRole('checkbox', { name: '选择 Training A 副本', exact: true }).check();
  await page.locator('#batch-close').click();
  await expect(page.locator('#batch-preview li')).toHaveCount(1);
  await expect(page.locator('#batch-preview')).toContainText('Training A 副本');
  await page.getByRole('button', { name: '结束所选会话', exact: true }).click();
  await expect(page.locator('.session-item')).toHaveCount(1);
  await expect(page.locator('#active-name')).toHaveText('Training A');
  expect(errors).toEqual([]);
});
