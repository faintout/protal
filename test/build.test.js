const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

test('Worker bundle preserves static resources and JSON containing replacement-string tokens', async () => {
  const root = path.join(__dirname, '..');
  const prefix = path.join(os.tmpdir(), 'aurora-build-test-');
  const dir = fs.mkdtempSync(prefix);
  try {
    for (const file of ['build.js', 'worker.js', 'site-metadata.js', 'public/index.html',
      'public/js/app.js', 'public/css/style.css', 'data/default-sites.json']) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    const literal = "literal $& $` $' ${value} \\ `";
    fs.appendFileSync(path.join(dir, 'public/js/app.js'), '\n// ' + literal);
    const data = { profile: { title: literal }, categories: [], sites: [] };
    fs.writeFileSync(path.join(dir, 'data/default-sites.json'), JSON.stringify(data));
    execFileSync(process.execPath, [path.join(dir, 'build.js')]);
    const source = fs.readFileSync(path.join(dir, 'worker-dist.js'), 'utf8');
    const context = { URL, Response, AbortController, TextDecoder, setTimeout, clearTimeout };
    vm.runInNewContext(source.replace('export default {', 'globalThis.worker = {'), context);
    for (const [url, file] of [['/', 'index.html'], ['/js/app.js', 'js/app.js'], ['/css/style.css', 'css/style.css']]) {
      const response = await context.worker.fetch(new Request('https://portal.example' + url), {}, {});
      const expected = fs.readFileSync(path.join(dir, 'public', file), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
      assert.ok(await response.text() === expected, url + ' preserves the source text');
    }
    const response = await context.worker.fetch(new Request('https://portal.example/api/sites'), {
      AURORA_KV: { get: async () => null }
    }, {});
    assert.deepEqual(await response.json(), data);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(prefix)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
