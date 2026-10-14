const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf-8');
const workerDist = fs.readFileSync(path.join(root, 'worker-dist.js'), 'utf-8');

test('index.html 包含主界面和抽屉中的刷新按钮', () => {
  assert.ok(html.includes('id="btnRefreshClip"'), '应包含主面板刷新按钮 btnRefreshClip');
  assert.ok(html.includes('id="drawerRefreshBtn"'), '应包含抽屉刷新按钮 drawerRefreshBtn');
  assert.ok(html.includes('id="clipTextarea"'), '应包含主剪贴板文本框 clipTextarea');
  assert.ok(html.includes('id="drawerTextarea"'), '应包含抽屉便签文本框 drawerTextarea');
  assert.ok(!html.includes('每 3 秒检查更新'), '不应再包含每3秒检查更新的说明文案');
});

test('app.js 移除了定时轮询逻辑，并在 change 时才进行保存', () => {
  assert.ok(!js.includes('clipSyncTimer'), '不应存在 clipSyncTimer');
  assert.ok(!js.includes('scheduleClipSync'), '不应存在 scheduleClipSync 函数');
  assert.ok(js.includes('btnRefreshClip'), '应绑定 btnRefreshClip 刷新按钮');
  assert.ok(js.includes('drawerRefreshBtn'), '应绑定 drawerRefreshBtn 刷新按钮');
  assert.ok(js.includes("addEventListener('change'"), '应监听 change 事件用于保存');
  assert.ok(js.includes('fetchClipboard(true)'), '刷新按钮点击时应调用 fetchClipboard');
  assert.ok(js.includes('saveClipboard'), '应包含 saveClipboard 方法');
});

test('worker-dist.js 正确构建并包含最新剪贴板改动', () => {
  assert.ok(workerDist.includes('btnRefreshClip'), 'worker-dist.js 应包含刷新按钮');
  assert.ok(!workerDist.includes('scheduleClipSync'), 'worker-dist.js 中不应再包含定时轮询');
});
