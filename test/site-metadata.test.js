const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const metadata = require('../site-metadata');
const { isPublicAddress, metadataUrl, parseSiteMetadata, fetchSiteMetadata } = metadata;

test('parses title entities, base href and icon links without reading scripts or comments', () => {
  const html = '<!-- <title>Wrong</title> --><script>"<link rel=icon href=/wrong>"</script>' +
    '<title>  示例 &amp; &#x1F680; &#169;\n Portal </title>' +
    '<link rel="apple-touch-icon" href="touch.png">' +
    '<link href="icons/site.svg?v=1&amp;size=2" rel="shortcut ICON">' +
    '<base href="../assets/">';
  assert.deepEqual(parseSiteMetadata(html, 'https://example.com/docs/start'), {
    title: '示例 & 🚀 © Portal', icon: 'https://example.com/assets/icons/site.svg?v=1&size=2',
    url: 'https://example.com/docs/start',
  });
});

test('missing or unsafe icons fall back to favicon on the final origin', () => {
  assert.deepEqual(parseSiteMetadata('<link rel=icon href="javascript:alert(1)">', 'https://example.com:8443/a#top'), {
    title: '', icon: 'https://example.com:8443/favicon.ico', url: 'https://example.com:8443/a',
  });
  assert.equal(parseSiteMetadata('<link rel=apple-touch-icon href=//cdn.example.com/touch.png>', 'https://example.com').icon,
    'https://cdn.example.com/touch.png');
});

test('rejects private, loopback, link-local and non-HTTP addresses, including alternate spellings', () => {
  const invalid = ['file:///etc/passwd', 'data:text/html,hi', 'http://user:pass@example.com',
    'http://localhost', 'http://localhost.', 'http://machine.local', 'http://router',
    'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
    'http://10.0.0.1', 'http://172.16.2.1', 'http://192.168.1.1', 'http://169.254.169.254',
    'http://100.64.0.1', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fe80::1]',
    'http://[fc00::1]', 'http://[2001:db8::1]', 'http://[2001::1]', 'http://[2002:7f00:1::]'];
  invalid.forEach(address => assert.throws(() => metadataUrl(address), { status: 400 }, address));
  ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'].forEach(address => assert.equal(isPublicAddress(address), true));
  assert.equal(isPublicAddress('2001:0db8:0:0:0:0:0:1'), false);
});

test('redirects use final page URL and reject private redirect targets before another request', async () => {
  const requested = [];
  const result = await fetchSiteMetadata('https://example.com/start', async url => {
    requested.push(url.href);
    return requested.length === 1 ? { status: 302, location: '/docs/page' } :
      { status: 200, contentType: 'text/html; charset=utf-8', html: '<title>Final</title><link rel=icon href=icon.png>' };
  });
  assert.deepEqual(requested, ['https://example.com/start', 'https://example.com/docs/page']);
  assert.equal(result.icon, 'https://example.com/docs/icon.png');
  let calls = 0;
  await assert.rejects(fetchSiteMetadata('https://example.com', async () => {
    calls++;
    return { status: 302, location: 'http://169.254.169.254/latest/meta-data' };
  }), { status: 400 });
  assert.equal(calls, 1);
});

test('reports failed responses, non-HTML content, redirect loops and transport timeout', async () => {
  await assert.rejects(fetchSiteMetadata('https://example.com', async () => ({ status: 503 })), { status: 502 });
  await assert.rejects(fetchSiteMetadata('https://example.com', async () => ({ status: 200, contentType: 'image/png' })), { status: 502 });
  let calls = 0;
  await assert.rejects(fetchSiteMetadata('https://example.com', async () => {
    calls++;
    return { status: 301, location: '/loop' };
  }), { status: 502 });
  assert.equal(calls, 5);
  await assert.rejects(fetchSiteMetadata('https://example.com', async () => {
    throw metadata.metadataError('timeout', 504);
  }), { status: 504 });
});

function nodeTransport(addresses, html, dohResponses) {
  let connected;
  const dohRequests = [];
  const client = { get(url, options, callback) {
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    if (typeof url === 'string') {
      dohRequests.push(url);
      process.nextTick(() => {
        const data = dohResponses[new URL(url).searchParams.get('type')];
        const res = new EventEmitter();
        res.statusCode = 200;
        res.destroy = () => {};
        callback(res);
        res.emit('data', Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)));
        res.emit('end');
      });
      return req;
    }
    process.nextTick(() => options.lookup(url.hostname, { all: true }, (error, selected) => {
      if (error) return req.emit('error', error);
      connected = selected;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { 'content-type': 'text/html' };
      res.destroy = () => {};
      callback(res);
      res.emit('data', Buffer.from(html));
      res.emit('end');
    }));
    return req;
  } };
  const context = { module: { exports: {} }, URL, Buffer, setTimeout, clearTimeout,
    require(name) {
      if (name === 'http' || name === 'https') return client;
      if (name === 'dns') return { lookup(hostname, options, callback) { callback(null, addresses); } };
      return metadata;
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../site-metadata-node.js'), 'utf8'), context);
  return { fetch: context.module.exports, connected: () => connected, dohRequests };
}

test('Node transport rejects private DNS answers and connects using the checked public answer', async () => {
  const blocked = nodeTransport([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], '');
  await assert.rejects(blocked.fetch('https://example.com'), { status: 400 });
  assert.equal(blocked.connected(), undefined);
  const publicAddress = { address: '93.184.216.34', family: 4 };
  const allowed = nodeTransport([publicAddress], '<title>Public site</title>');
  assert.equal((await allowed.fetch('https://example.com')).title, 'Public site');
  assert.equal(allowed.connected()[0], publicAddress);
  assert.equal(allowed.dohRequests.length, 0);
});

test('Node resolves exclusively fake-IP DNS answers through DoH and pins the checked public address', async () => {
  const transport = nodeTransport([{ address: '198.18.1.147', family: 4 }, { address: '2001:2::192', family: 6 }],
    '<title>Real website</title>', {
      A: { Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }, AAAA: { Status: 0, Answer: [] },
    });
  assert.equal((await transport.fetch('https://example.com')).title, 'Real website');
  assert.equal(transport.connected()[0].address, '93.184.216.34');
  assert.equal(transport.connected()[0].family, 4);
  assert.deepEqual(transport.dohRequests, ['https://cloudflare-dns.com/dns-query?name=example.com&type=A',
    'https://cloudflare-dns.com/dns-query?name=example.com&type=AAAA']);
});

test('Node keeps private, mixed and non-fake benchmark DNS answers blocked without using DoH', async () => {
  const blockedAnswers = [['127.0.0.1'], ['198.18.1.1', '10.0.0.1'], ['198.19.1.1', '93.184.216.34'], ['2001:2:1::1']];
  for (const answers of blockedAnswers) {
    const transport = nodeTransport(answers.map(address => ({ address, family: address.includes(':') ? 6 : 4 })), '');
    await assert.rejects(transport.fetch('https://example.com'), { status: 400 });
    assert.equal(transport.dohRequests.length, 0);
    assert.equal(transport.connected(), undefined);
  }
});

test('Node rejects private answers returned by the trusted DoH resolver', async () => {
  const transport = nodeTransport([{ address: '198.19.1.1', family: 4 }], '', {
    A: { Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] },
    AAAA: { Status: 0, Answer: [{ type: 28, data: '::1' }] },
  });
  await assert.rejects(transport.fetch('https://example.com'), { status: 400 });
  assert.equal(transport.connected(), undefined);
});

test('Node bounds and validates DoH response bodies', async () => {
  for (const response of [' '.repeat(64 * 1024 + 1), '<html>not DNS JSON</html>', { Status: 3 }]) {
    const transport = nodeTransport([{ address: '198.18.1.1', family: 4 }], '', {
      A: response, AAAA: { Status: 0, Answer: [] },
    });
    await assert.rejects(transport.fetch('https://example.com'), { status: 502 });
    assert.equal(transport.connected(), undefined);
  }
});

test('Node transport caps the response body before parsing metadata', async () => {
  const html = ' '.repeat(metadata.METADATA_MAX_BYTES) + '<title>Outside limit</title>';
  const transport = nodeTransport([{ address: '93.184.216.34', family: 4 }], html);
  assert.equal((await transport.fetch('https://example.com')).title, '');
});

function workerHandler(fetch) {
  const worker = fs.readFileSync(path.join(__dirname, '../worker.js'), 'utf8')
    .replace('__SITE_METADATA_CODE__', () => fs.readFileSync(path.join(__dirname, '../site-metadata.js'), 'utf8'))
    .replace('export default {', 'globalThis.worker = {')
    .replace('__DEFAULT_DATA__', '{}');
  const context = { fetch, URL, Response, AbortController, TextDecoder, setTimeout, clearTimeout };
  vm.runInNewContext(worker, context);
  return context.worker;
}

test('Worker checks DNS and parses streamed HTML using the redirected page URL', async () => {
  const visited = [];
  const handler = workerHandler(async address => {
    if (address.startsWith('https://cloudflare-dns.com/')) return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
    visited.push(address);
    if (visited.length === 1) return new Response(null, { status: 302, headers: { Location: '/final/' } });
    return new Response('<title>Worker &amp; website</title><link rel=icon href=icon.png>', { headers: { 'Content-Type': 'text/html' } });
  });
  const result = await handler.fetch(new Request('https://portal.example/api/site-metadata?url=https%3A%2F%2Fexample.com'), {}, {});
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { title: 'Worker & website', icon: 'https://example.com/final/icon.png', url: 'https://example.com/final/' });
  assert.deepEqual(visited, ['https://example.com/', 'https://example.com/final/']);
});

test('Worker rejects private DNS and redirected hosts without fetching their pages', async () => {
  let visited = 0;
  const blocked = workerHandler(async () => Response.json({ Answer: [{ type: 1, data: '10.0.0.1' }] }));
  const request = new Request('https://portal.example/api/site-metadata?url=https%3A%2F%2Fexample.com');
  assert.equal((await blocked.fetch(request, {}, {})).status, 400);
  const redirected = workerHandler(async address => {
    if (address.startsWith('https://cloudflare-dns.com/')) return Response.json({ Answer: [{ type: 1, data: '93.184.216.34' }] });
    visited++;
    return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
  });
  assert.equal((await redirected.fetch(request, {}, {})).status, 400);
  assert.equal(visited, 1);
});
