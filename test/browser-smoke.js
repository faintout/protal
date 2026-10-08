// Run: npm run test:browser (requires Playwright and its Chromium/WebKit browsers).
// All API requests use fixtures; these checks never start the application server or write real site data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium, webkit } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = path.join(os.tmpdir(), 'aurora-portal-qa', 'screenshots');
const storageKey = 'aurora-portal-data-v2';
const backupKey = 'aurora-before-import-v1';
const legacyClipboardKey = 'aurora-clip-content-v2';
const original = {
  profile: { title: 'QA <b>Portal</b>', subtitle: 'Browser fixture', avatar: 'https://images.example/avatar.png' },
  categories: ['工具', '<b data-qa="category">分类</b>'],
  sites: [
    { id: 'qa-one', name: 'Example', url: 'https://example.com/', category: '工具', desc: 'Original description', icon: 'https://images.example/one.png' },
    { id: 'qa-two', name: '<img data-qa="name" src=x onerror="window.injected=1">', url: 'https://example.org/', category: '<b data-qa="category">分类</b>', desc: '<svg data-qa="desc" onload="window.injected=1">', icon: 'https://images.example/two.png' }
  ]
};
const imported = {
  profile: { title: 'Imported portal', subtitle: 'Restored settings', avatar: 'https://images.example/import.png' },
  categories: ['Imported'],
  sites: [{ id: 'imported-one', name: 'Imported title', url: 'https://import.example/path?q=one', category: 'Imported', desc: 'Imported description', icon: 'https://import.example/icons/site.png' }]
};
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const jsonFile = value => ({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });

async function fixture(browser, origin, options = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 375, height: 667 } : { width: 1280, height: 900 }, acceptDownloads: true });
  await context.addInitScript(({ key, legacy }) => {
    if (legacy) localStorage.setItem(key, legacy);
    window.clipboardStorageWrites = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (String(key).indexOf('aurora-clip') === 0) window.clipboardStorageWrites.push({ key, value });
      return setItem.call(this, key, value);
    };
  }, { key: legacyClipboardKey, legacy: options.legacyClipboard });
  if (options.legacy) await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined });
    Object.defineProperty(navigator, 'clipboard', { value: undefined });
    Object.defineProperty(window, 'EventSource', { value: undefined });
    document.execCommand = command => { window.legacyCopy = command === 'copy' ? document.activeElement.value : ''; return true; };
  });
  const state = {
    data: clone(original), posts: [], metadata: new Map(), failPost: false,
    clipboard: options.clipboard || { content: 'Initial cloud fixture', updatedAt: 1, posts: [] },
    failSiteGet: !!options.failSiteGet, failClipboardGet: !!options.failClipboardGet,
    failClipboardPost: false, clipboardGets: 0, sseRequests: 0,
    activeClipboardRequests: 0, maxClipboardRequests: 0
  };
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && ['/api/sites', '/api/clipboard', '/api/clipboard/sse', '/api/site-metadata'].includes(url.pathname)) {
      if (url.pathname === '/api/sites') {
        if (request.method() === 'POST') {
          const data = request.postDataJSON();
          state.posts.push(data);
          if (state.postGate) await state.postGate.promise;
          if (state.failPost) return route.fulfill({ status: 503, json: { error: 'Fixture save failure' } });
          state.data = clone(data);
        }
        if (request.method() === 'GET' && state.failSiteGet) return route.fulfill({ status: 503, json: { error: 'Fixture load failure' } });
        return route.fulfill({ json: state.data });
      }
      if (url.pathname === '/api/site-metadata') {
        const target = new URL(url.searchParams.get('url'));
        const response = state.metadata.get(target.hostname) || { title: 'Title from ' + target.hostname, icon: 'https://' + target.hostname + '/assets/site-icon.png' };
        if (response.gate) await response.gate.promise;
        return route.fulfill({ status: response.status || 200, json: { title: response.title, icon: response.icon } }).catch(() => {});
      }
      if (url.pathname.endsWith('/sse')) {
        state.sseRequests++;
        return route.fulfill({ status: 204, body: '' });
      }
      state.activeClipboardRequests++;
      state.maxClipboardRequests = Math.max(state.maxClipboardRequests, state.activeClipboardRequests);
      try {
        const cloud = state.clipboard;
        if (request.method() === 'POST') {
          const body = request.postDataJSON();
          cloud.posts.push(body);
          const fail = state.failClipboardPost;
          const gate = state.clipPostGate;
          state.clipPostGate = null;
          if (gate) await gate.promise;
          if (fail) return await route.fulfill({ status: 503, json: { error: 'Fixture clipboard save failure' } });
          cloud.content = body.content;
          cloud.updatedAt++;
          return await route.fulfill({ json: { content: cloud.content, updatedAt: cloud.updatedAt } });
        }
        state.clipboardGets++;
        const snapshot = state.clipGetResponse || { content: cloud.content, updatedAt: cloud.updatedAt };
        const fail = state.failClipboardGet;
        const gate = state.clipGetGate;
        state.clipGetGate = state.clipGetResponse = null;
        if (gate) await gate.promise;
        return await route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: 'Fixture clipboard load failure' } : snapshot });
      } finally { state.activeClipboardRequests--; }
    }
    if (url.origin === origin) return route.continue();
    if (request.resourceType() === 'script') return route.fulfill({ contentType: 'text/javascript', body: '' });
    return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=', 'base64') });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = [];
  context.on('page', other => other.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  if (!options.failSiteGet) await page.locator('#sitesMatrix .site-card').first().waitFor();
  // Event binding follows the initial render in main().
  await page.waitForFunction(() => document.querySelector('#searchInput').placeholder.indexOf('实时过滤') >= 0);
  return { browser, origin, context, page, state, errors };
}

async function toast(page, text) { await page.locator('.toast').filter({ hasText: text }).last().waitFor(); }
async function field(page, selector, value) { await page.waitForFunction(({ selector, value }) => document.querySelector(selector).value === value, { selector, value }); }
async function status(page, selector, text) { await page.locator(selector).filter({ hasText: text }).waitFor({ state: 'attached' }); }
function clipboardRequest(request, method) { return new URL(request.url()).pathname === '/api/clipboard' && request.method() === method; }
async function clipboardSaved(page, content) {
  const response = page.waitForResponse(response => clipboardRequest(response.request(), 'POST'));
  await page.locator('#clipTextarea').fill(content);
  assert.equal((await response).ok(), true);
  await status(page, '#clipStatusText', /已同步|已连接/);
}
async function noClipboardStorage(page) { assert.deepEqual(await page.evaluate(() => window.clipboardStorageWrites), [], 'clipboard content must never be written to browser storage'); }
async function cached(page, key = storageKey) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), key); }
async function loadMetadata(page, url) {
  await page.locator('#formSiteUrl').fill(url);
  await page.locator('#formSiteName').focus();
  await page.waitForFunction(() => !document.querySelector('#saveSiteBtn').disabled && document.querySelector('#siteMetadataStatus').textContent.indexOf('正在读取') === -1);
}
async function chooseImport(page, value, accept = true) {
  const dialog = page.waitForEvent('dialog');
  await page.locator('#importFileInput').setInputFiles(jsonFile(value));
  await (await dialog)[accept ? 'accept' : 'dismiss']();
  await page.waitForFunction(() => { const input = document.querySelector('#importFileInput'); return !input.disabled && !input.value; });
}
async function emulateNoFlexGap(page) {
  await page.evaluate(() => {
    document.documentElement.classList.add('no-flex-gap');
    document.querySelectorAll('*').forEach(element => {
      if (/^(inline-)?flex$/.test(getComputedStyle(element).display)) element.style.gap = '0px';
    });
  });
}
async function withinViewport(page, selector) {
  const bounds = await page.locator(selector).boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, selector + ' must be visible');
  const viewport = page.viewportSize();
  assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, selector + ' exceeds viewport: ' + JSON.stringify(bounds));
}
async function editCategory(page, button, previous, next) {
  const opened = page.waitForEvent('dialog');
  const clicked = button.click();
  const dialog = await opened;
  assert.equal(dialog.type(), 'prompt');
  assert.equal(dialog.defaultValue(), previous);
  await (next === null ? dialog.dismiss() : dialog.accept(next));
  await clicked;
}

const scenarios = {
  async startup({ page, state }) {
    await status(page, '#kvSyncLabel', /云端已连接|已同步/);
    assert.equal(await page.locator('#sitesMatrix .site-card').count(), 2);
    assert.equal(await page.locator('#portalTitle').textContent(), original.profile.title);
    assert.equal(await page.locator('#sitesMatrix [data-qa], #categoryFilterBar [data-qa], #portalTitle b').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('#sitesMatrix .site-card').first().hover();
    await page.locator('#sitesMatrix [data-action="edit"]').first().click();
    await field(page, '#formSiteName', 'Example');
    await page.locator('#cancelSiteModalBtn').click();
    assert.equal(state.posts.length, 0);
  },

  async categoryEditing({ page, state }, name) {
    const before = clone(original);
    before.sites.push({ ...before.sites[0], id: 'qa-three', name: 'Another tool', url: 'https://another.example/' });
    state.data = clone(before);
    await page.reload();
    await page.locator('.edit-category-btn').first().waitFor();
    assert.equal(await page.locator('.edit-category-btn').first().getAttribute('data-category'), '工具');
    for (const value of [null, '', '   ', ' 工具 ', ' ' + before.categories[1] + ' ']) {
      await editCategory(page, page.locator('.edit-category-btn').first(), '工具', value);
      assert.equal(state.posts.length, 0, 'cancel, empty, unchanged and duplicate labels must not save');
      assert.deepEqual(await cached(page), before);
    }

    await page.locator('#categoryFilterBar .cat-pill[data-cat="工具"]').click();
    const renamed = '<b data-qa="renamed" onclick="window.injected=1">工作 "标签"</b>';
    const saved = page.waitForResponse(response => response.url().endsWith('/api/sites') && response.request().method() === 'POST');
    await editCategory(page, page.locator('.edit-category-btn'), '工具', ' ' + renamed + ' ');
    assert.equal((await saved).ok(), true);
    const expected = clone(before);
    expected.categories[0] = renamed;
    expected.sites.filter(site => site.category === '工具').forEach(site => { site.category = renamed; });
    assert.equal(state.posts.length, 1);
    assert.deepEqual(state.data, expected, 'renaming must preserve every unrelated site field and update all matching sites');
    assert.deepEqual(await cached(page), expected);
    assert.equal(await page.locator('#categoryFilterBar .cat-pill.active').getAttribute('data-cat'), renamed);
    assert.equal(await page.locator('#sitesMatrix .site-card').count(), 2);
    assert.equal(await page.locator('#sitesMatrix .section-container').getAttribute('data-category'), renamed);
    assert.equal(await page.locator('#sitesMatrix [data-qa], #categoryFilterBar [data-qa]').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.screenshot({ animations: 'disabled', path: path.join(output, name + '-category-edited.png'), fullPage: true });

    await page.locator('#sitesMatrix .site-card').first().hover();
    await page.locator('#sitesMatrix [data-action="edit"]').first().click();
    await field(page, '#formSiteCategory', renamed);
    await page.locator('#formSiteDesc').fill('Unsaved description stays in the form');
    const savedAgain = page.waitForResponse(response => response.url().endsWith('/api/sites') && response.request().method() === 'POST');
    await editCategory(page, page.locator('#btnEditCat'), renamed, 'all');
    assert.equal((await savedAgain).ok(), true);
    expected.categories[0] = 'all';
    expected.sites.filter(site => site.category === renamed).forEach(site => { site.category = 'all'; });
    assert.equal(state.posts.length, 2, 'editing a label must not submit the website form');
    assert.deepEqual(state.data, expected);
    await field(page, '#formSiteCategory', 'all');
    await field(page, '#formSiteName', 'Example');
    await field(page, '#formSiteDesc', 'Unsaved description stays in the form');
    assert.equal(await page.locator('#siteModal').evaluate(element => element.classList.contains('open')), true);
    assert.equal(await page.locator('#categoryFilterBar .cat-pill.active').getAttribute('data-cat'), 'all');
    assert.equal(await page.locator('#sitesMatrix .site-card').count(), 2, 'a label named all must not select every category');
    await page.locator('#cancelSiteModalBtn').click();
    await page.locator('#categoryFilterBar .cat-pill').first().click();
    assert.equal(await page.locator('#sitesMatrix .site-card').count(), 3);
    await page.reload();
    await page.locator('.edit-category-btn').first().waitFor();
    assert.deepEqual(await cached(page), expected, 'renamed categories and site references must survive reload');
    await page.locator('#categoryFilterBar .cat-pill[data-cat="all"]').click();
    assert.equal(await page.locator('#sitesMatrix .site-card').count(), 2);
    assert.equal(state.posts.length, 2);
  },

  async categoryEditingMobile({ page, state }, name) {
    await withinViewport(page, '.edit-category-btn >> nth=0');
    const saved = page.waitForResponse(response => response.url().endsWith('/api/sites') && response.request().method() === 'POST');
    await editCategory(page, page.locator('.edit-category-btn').first(), '工具', '移动标签');
    assert.equal((await saved).ok(), true);
    await page.locator('#openAddSiteBtn').click();
    await page.locator('#formSiteCategory').selectOption('移动标签');
    await page.locator('#formSiteName').fill('Unsaved mobile title');
    await page.locator('#formSiteDesc').fill('Unsaved mobile description');
    await page.locator('#btnEditCat').scrollIntoViewIfNeeded();
    for (const selector of ['#formSiteCategory', '#btnEditCat', '#btnAddNewCat']) await withinViewport(page, selector);
    const savedAgain = page.waitForResponse(response => response.url().endsWith('/api/sites') && response.request().method() === 'POST');
    await editCategory(page, page.locator('#btnEditCat'), '移动标签', '手机编辑标签');
    assert.equal((await savedAgain).ok(), true);
    await field(page, '#formSiteCategory', '手机编辑标签');
    await field(page, '#formSiteName', 'Unsaved mobile title');
    await field(page, '#formSiteDesc', 'Unsaved mobile description');
    assert.equal(state.posts.length, 2);
    const expected = clone(original);
    expected.categories[0] = expected.sites[0].category = '手机编辑标签';
    assert.deepEqual(state.data, expected);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'label editing must not overflow at 375px');
    await page.screenshot({ animations: 'disabled', path: path.join(output, name + '-mobile-category-edit.png') });
    await page.locator('#cancelSiteModalBtn').click();
    await page.reload();
    await page.locator('.edit-category-btn').first().waitFor();
    assert.deepEqual(await cached(page), expected);
  },

  async metadata({ page, state }) {
    await page.locator('#openAddSiteBtn').click();
    await loadMetadata(page, 'https://title.example/docs');
    await field(page, '#formSiteName', 'Title from title.example');
    await field(page, '#formSiteIcon', 'https://title.example/assets/site-icon.png');
    await page.locator('#formSiteUrl').fill('https://changed.example/docs');
    await page.locator('#formSiteUrl').press('Enter');
    assert.equal(state.posts.length, 0, 'Enter during URL debounce must not save stale fields');
    assert.equal(await page.locator('#siteModal').evaluate(element => element.classList.contains('open')), true);
    await field(page, '#formSiteName', 'Title from changed.example');
    await page.waitForFunction(() => !document.querySelector('#saveSiteBtn').disabled);
    await page.locator('#formSiteDesc').fill('Description kept on save');
    await page.locator('#saveSiteBtn').click();
    await toast(page, '网站已添加');
    assert.equal(state.data.sites.length, 3);
    assert.ok(state.data.sites[2].id);
    assert.deepEqual({ ...state.data.sites[2], id: null }, { id: null, name: 'Title from changed.example', url: 'https://changed.example/docs', category: '工具', icon: 'https://changed.example/assets/site-icon.png', desc: 'Description kept on save' });

    await page.locator('#openAddSiteBtn').click();
    const manual = deferred();
    state.metadata.set('manual.example', { gate: manual, title: 'Remote replacement', icon: 'https://manual.example/remote.png' });
    const manualRequest = page.waitForRequest(request => request.url().includes(encodeURIComponent('https://manual.example/')));
    await page.locator('#formSiteUrl').fill('https://manual.example/');
    await page.locator('#formSiteName').focus();
    await manualRequest;
    await page.locator('#formSiteName').fill('My manual name');
    await page.locator('#formSiteIcon').fill('https://manual.example/custom.png');
    manual.resolve();
    await page.waitForFunction(() => !document.querySelector('#saveSiteBtn').disabled);
    await field(page, '#formSiteName', 'My manual name');
    await field(page, '#formSiteIcon', 'https://manual.example/custom.png');
    await page.locator('#cancelSiteModalBtn').click();

    // Ignore abort signals for this fixture so a late response must also be rejected by the request/session guard.
    await page.evaluate(() => {
      const fetchOriginal = window.fetch;
      window.fetch = (url, options) => fetchOriginal(url, String(url).indexOf('/api/site-metadata?') === 0 ? undefined : options);
    });
    for (const closeAndReopen of [false, true]) {
      await page.locator('#openAddSiteBtn').click();
      const late = deferred();
      state.metadata.set('late.example', { gate: late, title: 'STALE TITLE', icon: 'https://late.example/stale.png' });
      const started = page.waitForRequest(request => request.url().includes(encodeURIComponent('https://late.example/')));
      await page.locator('#formSiteUrl').fill('https://late.example/');
      await page.locator('#formSiteName').focus();
      await started;
      if (closeAndReopen) {
        await page.locator('#cancelSiteModalBtn').click();
        await page.locator('#openAddSiteBtn').click();
      }
      await loadMetadata(page, 'https://latest.example/');
      await field(page, '#formSiteName', 'Title from latest.example');
      const finished = page.waitForResponse(response => response.url().includes(encodeURIComponent('https://late.example/')));
      late.resolve();
      await (await finished).finished();
      await field(page, '#formSiteName', 'Title from latest.example');
      await field(page, '#formSiteIcon', 'https://latest.example/assets/site-icon.png');
      await page.locator('#cancelSiteModalBtn').click();
    }

    state.metadata.set('blocked.example', { status: 502 });
    await page.locator('#openAddSiteBtn').click();
    await loadMetadata(page, 'https://blocked.example/path');
    await field(page, '#formSiteName', 'blocked.example');
    await field(page, '#formSiteIcon', 'https://blocked.example/favicon.ico');
    assert.match(await page.locator('#siteMetadataStatus').textContent(), /无法读取/);
    assert.equal(await page.locator('#saveSiteBtn').isEnabled(), true);
  },

  async backup({ page, state }) {
    await page.locator('#dataManageBtn').click();
    const download = page.waitForEvent('download');
    await page.locator('#btnExportData').click();
    const file = await download;
    assert.match(file.suggestedFilename(), /^aurora-portal-backup-.+\.json$/);
    assert.deepEqual(JSON.parse(await fs.readFile(await file.path(), 'utf8')), original);

    await chooseImport(page, imported, false);
    assert.equal(state.posts.length, 0);
    assert.deepEqual(await cached(page), original);
    assert.equal(await cached(page, backupKey), null);
    for (const bad of ['{broken json', { categories: [], sites: [{ name: 'Bad', url: 'javascript:alert(1)', category: 'Unsafe' }] }, { sites: [{ name: 'Bad icon', url: 'https://safe.example/', category: 'Unsafe', icon: 'ftp://unsafe.example/icon.png' }] }]) {
      await page.locator('#importFileInput').setInputFiles(jsonFile(bad));
      await toast(page, '导入失败');
      await page.waitForFunction(() => !document.querySelector('#importFileInput').value);
      assert.equal(state.posts.length, 0);
      assert.deepEqual(await cached(page), original);
    }
    state.failPost = true;
    state.postGate = deferred();
    const pendingImport = chooseImport(page, imported);
    await page.waitForRequest(request => request.url().endsWith('/api/sites') && request.method() === 'POST');
    for (const selector of ['#closeDataModalBtn', '#btnResetDefault', '#btnRestoreBackup', '#importFileInput']) {
      assert.equal(await page.locator(selector).isDisabled(), true, selector + ' remains disabled during import');
    }
    await page.locator('#dataModal').click({ position: { x: 2, y: 2 } });
    assert.equal(await page.locator('#dataModal').evaluate(element => element.classList.contains('open')), true);
    assert.deepEqual(await cached(page), original);
    state.postGate.resolve();
    state.postGate = null;
    await pendingImport;
    await toast(page, '服务器同步失败，原数据未更改');
    assert.deepEqual(state.data, original);
    assert.deepEqual(await cached(page), original);
    assert.equal(await page.locator('#portalTitle').textContent(), original.profile.title);
    state.failPost = false;

    await chooseImport(page, imported);
    await toast(page, '成功导入 1 个网址');
    assert.deepEqual(state.data, imported);
    assert.deepEqual(await cached(page), imported);
    assert.deepEqual(await cached(page, backupKey), original);
    assert.equal(await page.locator('#statSitesCount').textContent(), '1');
    assert.equal(await page.locator('#btnRestoreBackup').isEnabled(), true);
    await Promise.all([
      page.waitForEvent('dialog').then(dialog => dialog.accept()),
      page.locator('#btnRestoreBackup').click()
    ]);
    await toast(page, '已恢复导入前备份');
    assert.deepEqual(await cached(page), original);
    assert.deepEqual(state.data, original);
    // Same file name and contents can be selected again after completion.
    await chooseImport(page, imported);
    assert.deepEqual(await cached(page), imported);
    assert.deepEqual(await cached(page, backupKey), original);
  },

  async clipboard({ page, state, browser, origin }) {
    await page.locator('[data-target="tab-clipboard"]').click();
    await field(page, '#clipTextarea', state.clipboard.content);
    await field(page, '#drawerTextarea', state.clipboard.content);
    assert.equal(state.clipboard.posts.length, 0, 'startup must not upload stale browser content');
    const peer = await fixture(browser, origin, { clipboard: state.clipboard, legacyClipboard: 'Different stale browser content' });
    try {
      await peer.page.locator('[data-target="tab-clipboard"]').click();
      await field(peer.page, '#clipTextarea', state.clipboard.content);
      // An idle focused editor must still receive remote changes.
      await peer.page.locator('#clipTextarea').focus();
      await clipboardSaved(page, 'Shared through the server, across isolated browser contexts');
      await field(peer.page, '#clipTextarea', state.clipboard.content);
      await field(peer.page, '#drawerTextarea', state.clipboard.content);
      assert.ok(peer.state.clipboardGets > 1, 'the other context must poll the server');
      await clipboardSaved(peer.page, 'Reply from the independent browser');
      await field(page, '#clipTextarea', state.clipboard.content);
      const cleared = page.waitForResponse(response => clipboardRequest(response.request(), 'POST'));
      await Promise.all([
        page.waitForEvent('dialog').then(dialog => dialog.accept()),
        page.locator('#btnClearClip').click()
      ]);
      assert.equal((await cleared).ok(), true);
      await field(peer.page, '#clipTextarea', '');
      assert.equal(state.clipboard.content, '');
      assert.deepEqual(state.clipboard.posts.map(body => body.content), [
        'Shared through the server, across isolated browser contexts', 'Reply from the independent browser', ''
      ]);
      await noClipboardStorage(page);
      await noClipboardStorage(peer.page);
      assert.equal(peer.state.sseRequests, 0);
      assert.deepEqual(peer.errors, [], 'uncaught errors in independent browser context');
    } finally { await peer.context.close(); }
  },

  async clipboardRaces({ page, state }) {
    await page.locator('[data-target="tab-clipboard"]').click();
    await field(page, '#clipTextarea', state.clipboard.content);
    // Hold an old GET while typing; its response cannot replace the new draft.
    const readGate = deferred();
    state.clipGetGate = readGate;
    await page.waitForRequest(request => clipboardRequest(request, 'GET'));
    const oldRead = page.waitForResponse(response => clipboardRequest(response.request(), 'GET'));
    const firstSave = page.waitForResponse(response => clipboardRequest(response.request(), 'POST'));
    await page.locator('#clipTextarea').fill('Draft created during a slow GET');
    readGate.resolve();
    await (await oldRead).finished();
    await field(page, '#clipTextarea', 'Draft created during a slow GET');
    assert.equal((await firstSave).ok(), true);
    await status(page, '#clipStatusText', /已同步|已连接/);
    assert.equal(state.clipboard.content, 'Draft created during a slow GET');

    // A slow POST acknowledgement must not erase text entered after it started.
    const writeGate = deferred();
    state.clipPostGate = writeGate;
    const writeStarted = page.waitForRequest(request => clipboardRequest(request, 'POST'));
    await page.locator('#clipTextarea').fill('First in-flight draft');
    await writeStarted;
    await page.locator('#clipTextarea').fill('Newer draft while POST is pending');
    const oldWrite = page.waitForResponse(response => clipboardRequest(response.request(), 'POST'));
    const newerWrite = page.waitForResponse(response => clipboardRequest(response.request(), 'POST') && response.request().postDataJSON().content === 'Newer draft while POST is pending');
    writeGate.resolve();
    await (await oldWrite).finished();
    await field(page, '#clipTextarea', 'Newer draft while POST is pending');
    await newerWrite;
    await status(page, '#clipStatusText', /已同步|已连接/);
    assert.equal(state.clipboard.content, 'Newer draft while POST is pending');

    // Reject an older server version even when there are no unsaved edits.
    state.clipGetResponse = { content: 'Stale server replica', updatedAt: 1 };
    const staleRead = await page.waitForResponse(response => clipboardRequest(response.request(), 'GET'));
    await staleRead.finished();
    await field(page, '#clipTextarea', state.clipboard.content);

    state.failClipboardPost = true;
    const failedSave = page.waitForResponse(response => clipboardRequest(response.request(), 'POST'));
    await page.locator('#clipTextarea').fill('Pending draft survives a failed save');
    assert.equal((await failedSave).status(), 503);
    await status(page, '#clipStatusText', /失败|重试/);
    await status(page, '#kvSyncLabel', /云端连接失败|同步失败/);
    await field(page, '#clipTextarea', 'Pending draft survives a failed save');
    assert.equal(state.clipboard.content, 'Newer draft while POST is pending');
    assert.doesNotMatch(await page.locator('#syncStatusBadge').textContent(), /本地模式|已同步/);
    state.failClipboardPost = false;
    const retry = await page.waitForResponse(response => clipboardRequest(response.request(), 'POST'));
    assert.equal(retry.ok(), true);
    assert.equal(retry.request().postDataJSON().content, 'Pending draft survives a failed save');
    await status(page, '#clipStatusText', /已同步|已连接/);
    await status(page, '#kvSyncLabel', /云端已连接|已同步/);
    assert.equal(state.clipboard.content, 'Pending draft survives a failed save');
    assert.equal(state.maxClipboardRequests, 1, 'clipboard requests must not overlap');
    await noClipboardStorage(page);
  },

  async connectionFailure({ page, state }) {
    await status(page, '#kvSyncLabel', /云端连接失败|同步失败/);
    await status(page, '#clipStatusText', /失败|重试/);
    await page.locator('[data-target="tab-clipboard"]').click();
    assert.equal(await page.locator('#clipTextarea').isDisabled(), true);
    assert.equal(await page.locator('#drawerTextarea').isDisabled(), true);
    await field(page, '#clipTextarea', '');
    assert.equal(state.clipboard.posts.length, 0);
    assert.doesNotMatch(await page.locator('#syncStatusBadge').textContent(), /本地模式/);
    state.failClipboardGet = false;
    await field(page, '#clipTextarea', state.clipboard.content);
    assert.equal(await page.locator('#clipTextarea').isEnabled(), true);
    state.failSiteGet = false;
    await page.reload();
    await status(page, '#kvSyncLabel', /云端已连接|已同步/);
    await field(page, '#clipTextarea', state.clipboard.content);
    state.failClipboardGet = true;
    await status(page, '#clipStatusText', /失败|重试/);
    await status(page, '#kvSyncLabel', /云端连接失败|同步失败/);
    state.failClipboardGet = false;
    await status(page, '#clipStatusText', /已同步|已连接/);
    await status(page, '#kvSyncLabel', /云端已连接|已同步/);
    await noClipboardStorage(page);
  },

  async compatibility({ page, state }, name) {
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: width === 375 ? 667 : 568 });
      await emulateNoFlexGap(page);
      await page.screenshot({ animations: 'disabled', path: path.join(output, name + '-mobile-' + width + '-home.png'), fullPage: true });
      for (const selector of ['#dataManageBtn', '#openAddSiteBtn', '.search-box-card']) await withinViewport(page, selector);
      for (const selector of ['#openAddSiteBtn > span', '.nav-tab[data-target="tab-clipboard"] > span:not(.badge-live)', '#currentEngineText', '#dataManageBtn > span']) {
        const textBounds = await page.locator(selector).boundingBox();
        assert.ok(textBounds && textBounds.height < 30, selector + ' should remain on one readable line at ' + width + 'px');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page has horizontal overflow');
    }
    await page.locator('#openAddSiteBtn').click();
    await emulateNoFlexGap(page);
    await withinViewport(page, '#formSiteUrl');
    await withinViewport(page, '#btnAutoFetchIcon');
    await page.locator('#saveSiteBtn').scrollIntoViewIfNeeded();
    const saveBounds = await page.locator('#saveSiteBtn').boundingBox();
    assert.ok(saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= page.viewportSize().height + 1, 'save button is inaccessible');
    await page.screenshot({ animations: 'disabled', path: path.join(output, name + '-mobile-site-modal.png') });
    await page.locator('#cancelSiteModalBtn').click();
    await page.locator('#dataManageBtn').click();
    await emulateNoFlexGap(page);
    await withinViewport(page, '#btnExportData');
    await page.locator('#btnResetDefault').scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: path.join(output, name + '-mobile-backup.png') });
    await page.locator('#closeDataModalBtn').click();
    await page.locator('[data-target="tab-clipboard"]').click();
    await page.locator('#clipTextarea').fill('Fallback copy fixture');
    await page.locator('#btnCopyAll').click();
    assert.equal(await page.evaluate(() => window.legacyCopy), 'Fallback copy fixture');
    await page.locator('#btnPasteFromSys').click();
    await toast(page, '长按粘贴');
    await status(page, '#clipStatusText', /已同步|已连接/);
    assert.equal(state.clipboard.content, 'Fallback copy fixture');
    await noClipboardStorage(page);
  }
};

async function main() {
  const selected = process.env.BROWSER_SCENARIO ? process.env.BROWSER_SCENARIO.split(',') : Object.keys(scenarios);
  for (const scenario of selected) assert.ok(scenarios[scenario], 'Unknown browser scenario: ' + scenario);
  await fs.mkdir(output, { recursive: true });
  const server = http.createServer(async (request, response) => {
    const assets = { '/': ['public/index.html', 'text/html'], '/css/style.css': ['public/css/style.css', 'text/css'], '/js/app.js': ['public/js/app.js', 'text/javascript'] };
    const asset = assets[request.url];
    if (!asset) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': asset[1] });
    response.end(await fs.readFile(path.join(root, asset[0])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const failures = [];
  try {
    for (const [name, engine] of Object.entries({ chromium, webkit })) {
      const browser = await engine.launch({ headless: true });
      try {
        for (const scenario of selected) {
          const check = scenarios[scenario];
          let current;
          try {
            current = await fixture(browser, origin, {
              mobile: scenario === 'compatibility' || scenario === 'categoryEditingMobile', legacy: scenario === 'compatibility',
              legacyClipboard: 'Stale browser-only clipboard',
              failSiteGet: scenario === 'connectionFailure', failClipboardGet: scenario === 'connectionFailure'
            });
            await check(current, name);
            assert.deepEqual(current.errors, [], 'uncaught browser errors');
            assert.equal(current.state.sseRequests, 0, 'clipboard must use the shared HTTP API');
            process.stdout.write('PASS ' + name + ' ' + scenario + '\n');
          } catch (error) {
            failures.push(name + ' ' + scenario + ': ' + error.stack);
            process.stderr.write('FAIL ' + failures[failures.length - 1] + '\n');
            if (current) await current.page.screenshot({ animations: 'disabled', path: path.join(output, name + '-' + scenario + '-failed.png'), fullPage: true }).catch(() => {});
          } finally {
            if (current) await current.context.close();
          }
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
  process.stdout.write('Screenshots: ' + output + '\n');
  if (failures.length) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
