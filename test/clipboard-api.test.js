const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const defaults = { profile: {}, categories: [], sites: [] };
const legacyKey = 'aurora:clipboard';
const stateKey = 'aurora:clipboard-state';

function workerFixture() {
  const values = new Map();
  const fixture = { values, env: {}, failRead: false, failWrite: false };
  fixture.env.AURORA_KV = {
    async get(key) {
      if (fixture.failRead) throw new Error('KV unavailable');
      return values.has(key) ? values.get(key) : null;
    },
    async put(key, value) {
      if (fixture.failWrite) throw new Error('KV unavailable');
      values.set(key, value);
    },
  };
  const source = fs.readFileSync(path.join(root, 'worker.js'), 'utf8')
    .replace('__SITE_METADATA_CODE__', '')
    .replace('export default {', 'globalThis.worker = {')
    .replace('__DEFAULT_DATA__', JSON.stringify(defaults));
  const context = { URL, Response, Date: { now: () => 1700000000123 } };
  vm.runInNewContext(source, context);
  fixture.request = (pathname, options) => context.worker.fetch(
    new Request('https://portal.example' + pathname, options), fixture.env, {});
  return fixture;
}

function nodeFixture(t) {
  const prefix = path.join(os.tmpdir(), 'aurora-clipboard-api-');
  const dir = fs.mkdtempSync(prefix);
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(prefix)));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'default-sites.json'), JSON.stringify(defaults));
  const fixture = { clipFile: path.join(dir, 'data', 'clipboard.txt'), failRead: false, failWrite: false };
  const storage = new Proxy(fs, { get(target, name) {
    if (name === 'readFileSync' || name === 'statSync' || name === 'writeFileSync') {
      return (...args) => {
        if (name === 'writeFileSync' ? fixture.failWrite : fixture.failRead) {
          const error = new Error('Storage unavailable');
          error.code = 'EACCES';
          throw error;
        }
        return target[name](...args);
      };
    }
    return target[name];
  } });
  let handler;
  const context = {
    __dirname: dir, URL, console: { log() {}, error() {} },
    process: { env: {}, exit() { throw new Error('Unexpected server exit'); } },
    require(name) {
      if (name === 'fs') return storage;
      if (name === 'path') return path;
      if (name === './site-metadata-node') return () => {};
      if (name === 'http') return { createServer(callback) {
        handler = callback;
        return { listen(port, host, ready) { assert.equal(host, '0.0.0.0'); ready(); }, on() {} };
      } };
      throw new Error('Unexpected module: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), context);
  fixture.request = async (pathname, options = {}) => {
    const req = new EventEmitter();
    req.url = pathname;
    req.method = options.method || 'GET';
    const headers = new Headers();
    let status = 200;
    let response;
    const res = {
      setHeader(name, value) { headers.set(name, value); },
      writeHead(code, values) { status = code; Object.entries(values).forEach(([name, value]) => headers.set(name, value)); },
      end(body) { response = new Response(body, { status, headers }); },
    };
    const handling = handler(req, res);
    if (options.body !== undefined) req.emit('data', Buffer.from(options.body));
    req.emit('end');
    await handling;
    assert.ok(response, 'API completes its response');
    return response;
  };
  return fixture;
}

function post(fixture, pathname, body) {
  return fixture.request(pathname, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}

for (const [name, create] of [['Node', nodeFixture], ['Worker', workerFixture]]) {
  test(name + ' persists clipboard text and clears it with the same GET/POST version contract', async t => {
    const api = create(t);
    const initial = await api.request('/api/clipboard');
    assert.deepEqual(await initial.json(), { content: '', updatedAt: 0 });
    for (const content of ['多设备\n{"content":"arbitrary text"}', '']) {
      const saved = await post(api, '/api/clipboard', { content });
      assert.equal(saved.status, 200);
      assert.equal(saved.headers.get('cache-control'), 'no-store');
      const state = await saved.json();
      assert.equal(state.content, content);
      assert.ok(Number.isFinite(state.updatedAt) && state.updatedAt > 0);
      if (api.clipFile) assert.equal(state.updatedAt, fs.statSync(api.clipFile).mtimeMs);
      else assert.equal(state.updatedAt, 1700000000123);
      const loaded = await api.request('/api/clipboard');
      assert.equal(loaded.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await loaded.json(), state);
    }
  });

  test(name + ' rejects invalid clipboard content without overwriting saved text', async t => {
    const api = create(t);
    await post(api, '/api/clipboard', { content: 'keep me' });
    for (const body of [{}, null, { content: null }, { content: 123 }, { content: {} }, { content: [] }, 'raw text']) {
      const response = await post(api, '/api/clipboard', body);
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, 'string');
    }
    assert.equal((await api.request('/api/clipboard', { method: 'POST', body: '{broken' })).status, 400);
    assert.equal((await (await api.request('/api/clipboard')).json()).content, 'keep me');
  });

  test(name + ' returns explicit uncached 503 responses when clipboard or site storage fails', async t => {
    const api = create(t);
    api.failRead = true;
    for (const pathname of ['/api/clipboard', '/api/sites']) {
      const response = await api.request(pathname);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(typeof (await response.json()).error, 'string');
    }
    api.failRead = false;
    api.failWrite = true;
    for (const pathname of ['/api/clipboard', '/api/sites']) {
      const response = await post(api, pathname, pathname === '/api/clipboard' ? { content: 'unsaved' } : defaults);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(typeof (await response.json()).error, 'string');
    }
    assert.deepEqual(await (await api.request('/api/clipboard')).json(), { content: '', updatedAt: 0 });
  });

  test(name + ' disables caching for site data and no longer exposes SSE', async t => {
    const api = create(t);
    for (const response of [await api.request('/api/sites'), await post(api, '/api/sites', defaults)]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const removed = await api.request('/api/clipboard/sse');
    assert.equal(removed.status, 404);
    assert.match(removed.headers.get('content-type'), /application\/json/);
  });
}

test('Worker keeps legacy text literal and writes versioned state to a separate key', async () => {
  const api = workerFixture();
  const legacy = '{"content":"this is clipboard text","updatedAt":9999999999999}';
  api.values.set(legacyKey, legacy);
  assert.deepEqual(await (await api.request('/api/clipboard')).json(), { content: legacy, updatedAt: 0 });
  const saved = await (await post(api, '/api/clipboard', { content: '' })).json();
  assert.deepEqual(await (await api.request('/api/clipboard')).json(), saved);
  assert.equal(api.values.get(legacyKey), legacy);
  assert.deepEqual(JSON.parse(api.values.get(stateKey)), saved);
});

test('Worker reports absent KV binding and corrupt versioned state as unavailable', async () => {
  const api = workerFixture();
  for (const state of ['{broken', 'null', '{"content":123,"updatedAt":1}', '{"content":"x","updatedAt":"1"}']) {
    api.values.set(stateKey, state);
    assert.equal((await api.request('/api/clipboard')).status, 503);
  }
  api.env = {};
  for (const pathname of ['/api/sites', '/api/clipboard']) {
    assert.equal((await api.request(pathname)).status, 503);
    assert.equal((await post(api, pathname, { content: 'unsaved' })).status, 503);
  }
});

test('Node reads existing clipboard.txt without interpreting JSON-looking text', async t => {
  const api = nodeFixture(t);
  const content = '{"content":"literal legacy text","updatedAt":4}';
  fs.writeFileSync(api.clipFile, content);
  assert.deepEqual(await (await api.request('/api/clipboard')).json(), { content, updatedAt: fs.statSync(api.clipFile).mtimeMs });
});
