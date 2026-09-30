/**
 * 极光导航 (Aurora Portal) - 前端主逻辑
 * 功能: 网站导航管理 + 多引擎搜索 + 共享粘贴板 (LocalStorage + BroadcastChannel + SSE服务器同步)
 */

/* =====================================================================
   0. 常量与工具函数
   ===================================================================== */
const STORAGE_KEY = 'aurora-portal-data-v2';
const CLIPBOARD_KEY = 'aurora-clip-content-v2';
const RECENT_KEY = 'aurora-recent-sites-v3';

// 搜索引擎配置
const ENGINES = {
  local:   { name: '站内',   icon: '⚡', url: null },
  baidu:   { name: '百度',   icon: '🐾', url: 'https://www.baidu.com/s?wd=' },
  bing:    { name: '必应',   icon: '💠', url: 'https://www.bing.com/search?q=' },
  google:  { name: '谷歌',   icon: '🌐', url: 'https://www.google.com/search?q=' },
  bilibili:{ name: 'B站',    icon: '📺', url: 'https://search.bilibili.com/all?keyword=' },
  github:  { name: 'GitHub', icon: '🐙', url: 'https://github.com/search?q=' },
  zhihu:   { name: '知乎',   icon: '💡', url: 'https://www.zhihu.com/search?q=' },
};

// Favicon 代理服务（避免跨域）
const FAVICON_PROVIDERS = (url) => [
  `https://www.google.com/s2/favicons?domain=${url}&sz=64`,
  `https://favicon.yandex.net/favicon/${url}`,
  `https://api.faviconkit.com/${url}/64`,
];

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

/** 全局 toast 通知 */
function toast(msg, type = 'info', duration = 2500) {
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  const colors = { info: '#6366f1', success: '#10b981', error: '#ef4444', warning: '#f59e0b' };
  el.style.borderColor = colors[type] || colors.info;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.4s'; setTimeout(() => el.remove(), 400); }, duration);
}

/** 深克隆 */
const deepClone = (obj) => JSON.parse(JSON.stringify(obj));

/** 生成简单 UUID */
const genId = () => `site-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** 从 URL 提取主域名 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch { return url; }
}

/* =====================================================================
   1. 数据层 (LocalStorage 持久化)
   ===================================================================== */
let appData = { profile: {}, categories: [], sites: [] };

const DEFAULT_PROFILE = {
  title: '极光导航',
  subtitle: '上网，从这开始！',
  avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=portal&backgroundColor=6366f1',
};

async function loadDefaultSites() {
  try {
    const res = await fetch('/api/sites');
    if (res.ok) {
      const json = await res.json();
      return json;
    }
  } catch {}
  // 如果 API 不可用，使用内嵌默认数据
  return {
    profile: DEFAULT_PROFILE,
    categories: ['常用推荐','AI 人工智能','影视影音','音乐听歌','开发编程','实用工具','学习资讯'],
    sites: [
      { id: 'site-1', name: 'ChatGPT', url: 'https://chatgpt.com', category: 'AI 人工智能', desc: 'OpenAI 超强智能对话', icon: 'https://www.google.com/s2/favicons?domain=chatgpt.com&sz=64' },
      { id: 'site-2', name: 'Claude', url: 'https://claude.ai', category: 'AI 人工智能', desc: 'Anthropic 超强编码思考模型', icon: 'https://www.google.com/s2/favicons?domain=claude.ai&sz=64' },
      { id: 'site-3', name: 'DeepSeek', url: 'https://chat.deepseek.com', category: 'AI 人工智能', desc: '国产开源领军推理大模型', icon: 'https://www.google.com/s2/favicons?domain=chat.deepseek.com&sz=64' },
      { id: 'site-4', name: 'Gemini', url: 'https://gemini.google.com', category: 'AI 人工智能', desc: 'Google 多模态智能助手', icon: 'https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64' },
      { id: 'site-5', name: 'GitHub', url: 'https://github.com', category: '常用推荐', desc: '全球最大开源代码托管平台', icon: 'https://www.google.com/s2/favicons?domain=github.com&sz=64' },
      { id: 'site-6', name: '哔哩哔哩', url: 'https://www.bilibili.com', category: '常用推荐', desc: '年轻人喜爱的弹幕视频社区', icon: 'https://www.google.com/s2/favicons?domain=bilibili.com&sz=64' },
      { id: 'site-7', name: '知乎', url: 'https://www.zhihu.com', category: '常用推荐', desc: '有问题，就会有答案', icon: 'https://www.google.com/s2/favicons?domain=zhihu.com&sz=64' },
      { id: 'site-8', name: 'YouTube', url: 'https://www.youtube.com', category: '常用推荐', desc: '全球最大视频分享平台', icon: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=64' },
      { id: 'site-9', name: '剧踪影院', url: 'https://www.juzong.me', category: '影视影音', desc: '海量高清热门影视追剧', icon: 'https://www.google.com/s2/favicons?domain=juzong.me&sz=64' },
      { id: 'site-10', name: 'CCTV 直播', url: 'https://tv.cctv.com/live/m/', category: '影视影音', desc: '央视各频道网络电视直播', icon: 'https://www.google.com/s2/favicons?domain=cctv.com&sz=64' },
      { id: 'site-11', name: '555 电影网', url: 'https://www.55kp8.com/', category: '影视影音', desc: '免费超清电影在线点播', icon: 'https://www.google.com/s2/favicons?domain=55kp8.com&sz=64' },
      { id: 'site-12', name: '米兔音乐', url: 'https://www.qqmp3.vip/', category: '音乐听歌', desc: '在线高品质免费听歌与下载', icon: 'https://www.google.com/s2/favicons?domain=qqmp3.vip&sz=64' },
      { id: 'site-13', name: '铜钟音乐', url: 'https://tonzhon.whamon.com/', category: '音乐听歌', desc: '简洁无广告聚合音乐播放器', icon: 'https://www.google.com/s2/favicons?domain=whamon.com&sz=64' },
      { id: 'site-14', name: '网络收音机 FM', url: 'https://radio5.cn/', category: '音乐听歌', desc: '全国广播电台在线流媒体', icon: 'https://www.google.com/s2/favicons?domain=radio5.cn&sz=64' },
      { id: 'site-15', name: 'V2EX', url: 'https://www.v2ex.com', category: '开发编程', desc: '创意工作者与程序员讨论社区', icon: 'https://www.google.com/s2/favicons?domain=v2ex.com&sz=64' },
      { id: 'site-16', name: '掘金', url: 'https://juejin.cn', category: '开发编程', desc: '面向开发者的技术分享社区', icon: 'https://www.google.com/s2/favicons?domain=juejin.cn&sz=64' },
      { id: 'site-17', name: 'MDN Web Docs', url: 'https://developer.mozilla.org', category: '开发编程', desc: '权威现代 Web 技术标准指南', icon: 'https://www.google.com/s2/favicons?domain=developer.mozilla.org&sz=64' },
      { id: 'site-18', name: 'TinyPNG', url: 'https://tinypng.com', category: '实用工具', desc: '智能高质量在线图片压缩', icon: 'https://www.google.com/s2/favicons?domain=tinypng.com&sz=64' },
      { id: 'site-19', name: 'ProcessOn', url: 'https://www.processon.com', category: '实用工具', desc: '在线流程图思维导图协同制作', icon: 'https://www.google.com/s2/favicons?domain=processon.com&sz=64' },
      { id: 'site-20', name: 'Cloudflare', url: 'https://dash.cloudflare.com', category: '实用工具', desc: 'CDN 加速与安全防护服务', icon: 'https://www.google.com/s2/favicons?domain=cloudflare.com&sz=64' },
      { id: 'site-21', name: '阮一峰网络日志', url: 'https://www.ruanyifeng.com/blog/', category: '学习资讯', desc: '科技文化爱好者每周精选', icon: 'https://www.google.com/s2/favicons?domain=ruanyifeng.com&sz=64' },
      { id: 'site-22', name: '少数派', url: 'https://sspai.com', category: '学习资讯', desc: '高效工作生活方式的数字指南', icon: 'https://www.google.com/s2/favicons?domain=sspai.com&sz=64' },
    ]
  };
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
  // 通知同标签页下的其他页面更新
  try { bc.postMessage({ type: 'data-updated' }); } catch {}
  // 同步至服务器（若可用）
  syncToServer();
}

async function syncToServer() {
  try {
    await fetch('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(appData),
    });
  } catch {}
}

async function initData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    appData = JSON.parse(saved);
    // 确保 profile 存在
    if (!appData.profile) appData.profile = DEFAULT_PROFILE;
  } else {
    appData = await loadDefaultSites();
    saveData();
  }
}

/* =====================================================================
   2. 最近访问记录
   ===================================================================== */
function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
}

function addRecent(siteId) {
  let recent = getRecent();
  recent = [siteId, ...recent.filter(id => id !== siteId)].slice(0, 8);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

/* =====================================================================
   3. 渲染层
   ===================================================================== */
let currentFilter = 'all';
let searchKeyword = '';

/** 渲染 profile 区域 */
function renderProfile() {
  const { title, subtitle, avatar } = appData.profile || DEFAULT_PROFILE;
  $('#portalTitle').textContent = title || '极光导航';
  $('#portalDesc').textContent = subtitle || '上网，从这开始！';
  const img = $('#userAvatar');
  img.src = avatar || DEFAULT_PROFILE.avatar;
  img.onerror = () => { img.src = DEFAULT_PROFILE.avatar; };
}

/** 渲染分类过滤栏 */
function renderCategoryBar() {
  const bar = $('#categoryFilterBar');
  const cats = appData.categories || [];
  bar.innerHTML = `<button class="cat-pill ${currentFilter === 'all' ? 'active' : ''}" data-cat="all">全部</button>`;
  cats.forEach(cat => {
    const count = appData.sites.filter(s => s.category === cat).length;
    if (count === 0) return;
    bar.innerHTML += `<button class="cat-pill ${currentFilter === cat ? 'active' : ''}" data-cat="${cat}">${cat} <span style="opacity:0.6;font-size:11px;">${count}</span></button>`;
  });
  $$('.cat-pill', bar).forEach(btn => {
    btn.onclick = () => {
      currentFilter = btn.dataset.cat;
      renderSites();
      renderCategoryBar();
    };
  });
}

/** 创建网站卡片 HTML */
function createSiteCard(site, showTools = true) {
  const domain = extractDomain(site.url);
  const iconSrc = site.icon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  const card = document.createElement('a');
  card.className = 'site-card';
  card.href = 'javascript:void(0)';
  card.title = site.desc || site.name;
  card.dataset.id = site.id;
  card.innerHTML = `
    <div class="site-icon-box">
      <img src="${iconSrc}" alt="${site.name}" onerror="this.parentElement.innerHTML='<span class=\\'default-icon\\'>🌐</span>'">
    </div>
    <div class="site-info">
      <div class="site-name">${site.name}</div>
      ${site.desc ? `<div class="site-desc">${site.desc}</div>` : ''}
    </div>
    ${showTools ? `
    <div class="card-tools">
      <button class="tool-icon-btn" data-action="edit" data-id="${site.id}" title="编辑">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
      </button>
      <button class="tool-icon-btn delete" data-action="delete" data-id="${site.id}" title="删除">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
      </button>
    </div>` : ''}
  `;
  // 点击打开
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-tools')) return;
    addRecent(site.id);
    window.open(site.url, '_blank', 'noopener,noreferrer');
  });
  // 编辑/删除按钮
  if (showTools) {
    card.querySelector('[data-action="edit"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openSiteModal(site.id);
    });
    card.querySelector('[data-action="delete"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSite(site.id);
    });
  }
  return card;
}

/** 渲染主网站矩阵 */
function renderSites() {
  const matrix = $('#sitesMatrix');
  matrix.innerHTML = '';
  const cats = appData.categories || [];

  // 确定哪些分类需要渲染
  const targetCats = currentFilter === 'all' ? cats : [currentFilter];

  // 搜索过滤
  const keyword = searchKeyword.toLowerCase().trim();
  const filtered = keyword
    ? appData.sites.filter(s => s.name.toLowerCase().includes(keyword) || s.url.toLowerCase().includes(keyword) || (s.desc || '').toLowerCase().includes(keyword))
    : appData.sites;

  if (keyword) {
    // 搜索模式：直接展示所有结果
    const section = document.createElement('div');
    section.className = 'section-container';
    section.innerHTML = `<div class="section-header"><h2 class="section-title"><span class="icon">🔍</span> 搜索结果 (${filtered.length} 个)</h2></div>`;
    const grid = document.createElement('div');
    grid.className = 'sites-grid';
    filtered.forEach(site => grid.appendChild(createSiteCard(site)));
    section.appendChild(grid);
    matrix.appendChild(section);
    return;
  }

  // 分类模式
  targetCats.forEach(cat => {
    const catSites = filtered.filter(s => s.category === cat);
    if (catSites.length === 0 && currentFilter !== 'all') return;

    const section = document.createElement('div');
    section.className = 'section-container';
    section.dataset.category = cat;

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `<h2 class="section-title">${getCatEmoji(cat)} ${cat}</h2>`;
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'sites-grid';
    catSites.forEach(site => grid.appendChild(createSiteCard(site)));

    // 添加网站占位卡
    const addCard = document.createElement('div');
    addCard.className = 'add-site-card';
    addCard.dataset.cat = cat;
    addCard.innerHTML = '<span style="font-size:18px;">＋</span><span>添加网站</span>';
    addCard.onclick = () => openSiteModal(null, cat);
    grid.appendChild(addCard);

    section.appendChild(grid);
    matrix.appendChild(section);
  });
}

/** 渲染最近访问区域 */
function renderRecent() {
  const recent = getRecent();
  const section = $('#recentSection');
  const grid = $('#recentGrid');
  if (!recent.length) { section.style.display = 'none'; return; }

  const recentSites = recent.map(id => appData.sites.find(s => s.id === id)).filter(Boolean);
  if (!recentSites.length) { section.style.display = 'none'; return; }

  section.style.display = '';
  grid.innerHTML = '';
  recentSites.forEach(site => grid.appendChild(createSiteCard(site, false)));
}

function getCatEmoji(cat) {
  const map = { '常用推荐': '⭐', 'AI 人工智能': '🤖', '影视影音': '🎬', '音乐听歌': '🎵', '开发编程': '💻', '实用工具': '🔧', '学习资讯': '📚' };
  return map[cat] || '📁';
}

/** 全量重新渲染 */
function renderAll() {
  renderProfile();
  renderCategoryBar();
  renderRecent();
  renderSites();
  renderCategoryOptions();
  updateDataStats();
}

/* =====================================================================
   4. 搜索逻辑
   ===================================================================== */
let currentEngine = 'local';

function setEngine(key) {
  currentEngine = key;
  const eng = ENGINES[key];
  $('#currentEngineIcon').textContent = eng.icon;
  $('#currentEngineText').textContent = eng.name;
  $$('.engine-option').forEach(opt => opt.classList.toggle('active', opt.dataset.engine === key));
  $$('.pill-item').forEach(p => p.classList.toggle('active', p.dataset.engine === key));
  $('#searchInput').placeholder = key === 'local' ? '输入关键字站内搜索，实时过滤导航网站...' : `在 ${eng.name} 中搜索...`;
}

function doSearch() {
  const val = $('#searchInput').value.trim();
  if (!val) return;
  if (currentEngine === 'local') {
    // 站内搜索已通过 input 事件实时过滤，此时切换到导航 tab 并全局检索
    switchTab('tab-sites');
    searchKeyword = val;
    renderSites();
  } else {
    window.open(ENGINES[currentEngine].url + encodeURIComponent(val), '_blank');
  }
}

/* =====================================================================
   5. Tab 切换
   ===================================================================== */
function switchTab(targetId) {
  $$('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.target === targetId));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === targetId));
}

/* =====================================================================
   6. 网站弹窗 (新增 / 编辑)
   ===================================================================== */
function openSiteModal(siteId = null, prefillCat = null) {
  const modal = $('#siteModal');
  const form = $('#siteForm');
  form.reset();
  renderCategoryOptions();
  $('#editSiteId').value = '';
  $('#formIconPreview').src = '';
  $('#formIconPreview').style.display = 'none';
  $('#formIconPlaceholder').style.display = '';

  if (siteId) {
    const site = appData.sites.find(s => s.id === siteId);
    if (!site) return;
    $('#siteModalTitle').textContent = '编辑网站';
    $('#editSiteId').value = site.id;
    $('#formSiteUrl').value = site.url;
    $('#formSiteName').value = site.name;
    $('#formSiteCategory').value = site.category;
    $('#formSiteDesc').value = site.desc || '';
    $('#formSiteIcon').value = site.icon || '';
    if (site.icon) updateIconPreview(site.icon);
  } else {
    $('#siteModalTitle').textContent = '添加新网站';
    if (prefillCat) $('#formSiteCategory').value = prefillCat;
  }
  modal.classList.add('open');
}

function closeSiteModal() {
  $('#siteModal').classList.remove('open');
}

function renderCategoryOptions() {
  const sel = $('#formSiteCategory');
  const current = sel.value;
  sel.innerHTML = (appData.categories || []).map(cat => `<option value="${cat}" ${cat === current ? 'selected' : ''}>${cat}</option>`).join('');
}

function updateIconPreview(url) {
  const img = $('#formIconPreview');
  const placeholder = $('#formIconPlaceholder');
  img.src = url;
  img.style.display = '';
  placeholder.style.display = 'none';
  img.onerror = () => { img.style.display = 'none'; placeholder.style.display = ''; };
}

async function autoFetchIcon() {
  const url = $('#formSiteUrl').value.trim();
  if (!url) { toast('请先填写网站 URL', 'warning'); return; }
  const domain = extractDomain(url);
  const providers = FAVICON_PROVIDERS(domain);
  const btn = $('#btnAutoFetchIcon');
  btn.textContent = '探测中...';
  btn.disabled = true;

  let found = false;
  for (const provUrl of providers) {
    try {
      const resp = await fetch(provUrl, { mode: 'no-cors' });
      if (resp.status !== 404) {
        $('#formSiteIcon').value = provUrl;
        updateIconPreview(provUrl);
        toast('图标探测成功！', 'success');
        found = true;
        break;
      }
    } catch {}
  }
  if (!found) {
    const fallback = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
    $('#formSiteIcon').value = fallback;
    updateIconPreview(fallback);
    toast('已使用 Google 备用图标服务', 'info');
  }
  btn.textContent = '自动探测图标';
  btn.disabled = false;
}

function saveSite(e) {
  e.preventDefault();
  const editId = $('#editSiteId').value;
  const site = {
    id: editId || genId(),
    name: $('#formSiteName').value.trim(),
    url: $('#formSiteUrl').value.trim(),
    category: $('#formSiteCategory').value,
    desc: $('#formSiteDesc').value.trim(),
    icon: $('#formSiteIcon').value.trim(),
  };
  if (!site.name || !site.url || !site.category) return;

  if (editId) {
    const idx = appData.sites.findIndex(s => s.id === editId);
    if (idx >= 0) appData.sites[idx] = site;
  } else {
    appData.sites.push(site);
  }
  saveData();
  renderAll();
  closeSiteModal();
  toast(editId ? '网站已更新 ✅' : '网站已添加 ✅', 'success');
}

function deleteSite(siteId) {
  if (!confirm('确定删除这个网站吗？')) return;
  appData.sites = appData.sites.filter(s => s.id !== siteId);
  saveData();
  renderAll();
  toast('网站已删除', 'info');
}

/* =====================================================================
   7. 数据管理 (导出 / 导入 / 重置)
   ===================================================================== */
function updateDataStats() {
  $('#statSitesCount').textContent = appData.sites.length;
  $('#statCatsCount').textContent = appData.categories.length;
  $('#statStorageType').textContent = '本地+云端';
}

function exportData() {
  const blob = new Blob([JSON.stringify(appData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aurora-portal-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  toast('配置已导出为 JSON 文件 💾', 'success');
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (!json.sites || !Array.isArray(json.sites)) throw new Error('格式错误');
      if (!confirm(`确认导入？将覆盖现有 ${appData.sites.length} 个站点，导入 ${json.sites.length} 个站点。`)) return;
      appData = { ...appData, ...json };
      saveData();
      renderAll();
      toast(`成功导入 ${json.sites.length} 个网站 ✅`, 'success');
    } catch { toast('JSON 文件格式错误，请检查！', 'error'); }
  };
  reader.readAsText(file);
}

async function resetDefault() {
  if (!confirm('此操作将重置所有自定义数据，恢复初始预置，确定吗？')) return;
  localStorage.removeItem(STORAGE_KEY);
  appData = await loadDefaultSites();
  saveData();
  renderAll();
  toast('已恢复初始预置站点数据 🔄', 'info');
}

/* =====================================================================
   8. 共享粘贴板逻辑
   ===================================================================== */
let clipContent = '';
let clipSyncTimer = null;
let sseSource = null;
let isPreviewMode = false;

/** 从 LocalStorage 初始化粘贴板内容 */
function initClipboard() {
  const saved = localStorage.getItem(CLIPBOARD_KEY) || '';
  clipContent = saved;
  $('#clipTextarea').value = saved;
  $('#drawerTextarea').value = saved;
  updateClipMeta();
}

/** 更新字数/行数统计 */
function updateClipMeta() {
  const txt = clipContent || '';
  const words = txt.trim() ? txt.trim().split(/\s+/).length : 0;
  const lines = txt.split('\n').length;
  $('#clipWordsMeta').textContent = `字符: ${txt.length}`;
  $('#clipLinesMeta').textContent = `行数: ${lines}`;
  const mins = Math.floor((Date.now() - lastSyncTime) / 60000);
  $('#clipTimeMeta').textContent = mins === 0 ? '刚刚更新' : `${mins} 分钟前`;
}

let lastSyncTime = Date.now();

/** 本地保存粘贴板内容，并广播给同域其他标签页 */
function saveClipLocal(content) {
  clipContent = content;
  localStorage.setItem(CLIPBOARD_KEY, content);
  lastSyncTime = Date.now();
  // BroadcastChannel 同步到同域其他标签页
  try { bc.postMessage({ type: 'clip-update', content }); } catch {}
  updateClipMeta();
}

/** 防抖保存并上报至服务器 */
let clipPushTimer = null;
function onClipInput(content) {
  saveClipLocal(content);
  if (isPreviewMode) renderMarkdownPreview();
  clearTimeout(clipPushTimer);
  clipPushTimer = setTimeout(() => pushClipToServer(content), 600);
}

async function pushClipToServer(content) {
  try {
    await fetch('/api/clipboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch {}
}

/** 建立 SSE 长连接监听服务端推送 (局域网多设备同步) */
function connectSSE() {
  if (typeof EventSource === 'undefined') {
    updateSyncStatus(false, '浏览器不支持 SSE');
    return;
  }
  const connect = () => {
    sseSource = new EventSource('/api/clipboard/sse');
    sseSource.onopen = () => updateSyncStatus(true, '已连接至云同步');
    sseSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'clip-update' && data.content !== clipContent) {
          clipContent = data.content;
          localStorage.setItem(CLIPBOARD_KEY, data.content);
          lastSyncTime = Date.now();
          // 更新两处 textarea (仅光标不在时才更新以避免打断输入)
          if (document.activeElement !== $('#clipTextarea')) {
            $('#clipTextarea').value = data.content;
          }
          if (document.activeElement !== $('#drawerTextarea')) {
            $('#drawerTextarea').value = data.content;
          }
          if (isPreviewMode) renderMarkdownPreview();
          updateClipMeta();
          // 轻微提示
          const dot = $('#clipLiveIndicator');
          dot.style.background = '#f59e0b';
          setTimeout(() => { dot.style.background = ''; }, 800);
        }
      } catch {}
    };
    sseSource.onerror = () => {
      updateSyncStatus(false, '重连中...');
      sseSource.close();
      setTimeout(connect, 3000);
    };
  };
  connect();
}

function updateSyncStatus(online, text) {
  const indicator = $('#clipLiveIndicator');
  const statusText = $('#clipStatusText');
  const badge = $('#syncStatusBadge');
  indicator.className = `live-indicator ${online ? 'online' : ''}`;
  statusText.textContent = text;
  badge.textContent = online ? '● 实时同步' : '○ 本地模式';
  badge.style.color = online ? 'var(--success)' : 'var(--warning)';
}

function renderMarkdownPreview() {
  const preview = $('#clipPreviewPanel');
  if (typeof marked !== 'undefined') {
    preview.innerHTML = marked.parse(clipContent || '*（暂无内容）*');
  } else {
    preview.textContent = clipContent;
  }
}

/* =====================================================================
   9. BroadcastChannel (多标签实时联动)
   ===================================================================== */
const bc = new BroadcastChannel('aurora-portal-v2');
bc.onmessage = (e) => {
  const { type, content } = e.data;
  if (type === 'clip-update' && content !== clipContent) {
    clipContent = content;
    if (document.activeElement !== $('#clipTextarea')) $('#clipTextarea').value = content;
    if (document.activeElement !== $('#drawerTextarea')) $('#drawerTextarea').value = content;
    if (isPreviewMode) renderMarkdownPreview();
    updateClipMeta();
  }
  if (type === 'data-updated') {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      appData = JSON.parse(saved);
      renderAll();
    }
  }
};

/* =====================================================================
   10. 二维码与局域网地址
   ===================================================================== */
function getLocalAddress() {
  return window.location.origin;
}

async function openQrModal(forClipboard = false) {
  const modal = $('#qrModal');
  const address = forClipboard ? `${getLocalAddress()}/#clipboard` : getLocalAddress();
  $('#qrAddressInput').value = address;
  // 使用 QR 码生成 API
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(address)}&bgcolor=ffffff&color=000000`;
  $('#qrCodeImage').src = qrUrl;
  modal.classList.add('open');
}

/* =====================================================================
   11. 背景切换
   ===================================================================== */
const BG_THEMES = [
  // 渐变极光动感主题
  `radial-gradient(circle at 20% 20%, rgba(99, 102, 241, 0.35) 0%, transparent 50%),radial-gradient(circle at 80% 80%, rgba(236, 72, 153, 0.25) 0%, transparent 45%),radial-gradient(circle at 60% 30%, rgba(14, 165, 233, 0.2) 0%, transparent 40%),#080c18`,
  // 深海蓝绿
  `radial-gradient(circle at 30% 70%, rgba(6, 182, 212, 0.3) 0%, transparent 50%),radial-gradient(circle at 70% 20%, rgba(34, 197, 94, 0.2) 0%, transparent 45%),#061018`,
  // 紫罗兰霞光
  `radial-gradient(circle at 10% 60%, rgba(168, 85, 247, 0.35) 0%, transparent 50%),radial-gradient(circle at 80% 40%, rgba(251, 146, 60, 0.2) 0%, transparent 45%),#100820`,
  // 红橙暖色
  `radial-gradient(circle at 20% 40%, rgba(239, 68, 68, 0.25) 0%, transparent 45%),radial-gradient(circle at 75% 70%, rgba(249, 115, 22, 0.25) 0%, transparent 45%),#150a08`,
  // 纯暗极简
  `linear-gradient(135deg, #0b0f1a 0%, #111827 100%)`,
];
let bgIndex = 0;

function cycleBg() {
  bgIndex = (bgIndex + 1) % BG_THEMES.length;
  $('#bgLayer').style.background = BG_THEMES[bgIndex];
  toast('背景已切换 🎨', 'info', 1500);
}

/* =====================================================================
   12. 事件绑定
   ===================================================================== */
function bindEvents() {
  // --- 搜索 ---
  const searchInput = $('#searchInput');
  const clearBtn = $('#searchClearBtn');

  searchInput.addEventListener('input', (e) => {
    const val = e.target.value;
    clearBtn.style.display = val ? '' : 'none';
    if (currentEngine === 'local') {
      searchKeyword = val;
      renderSites();
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearBtn.style.display = 'none';
    searchKeyword = '';
    renderSites();
  });

  $('#searchSubmitBtn').addEventListener('click', doSearch);

  // 引擎下拉
  $('#currentEngineBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#engineMenu').classList.toggle('show');
  });

  document.addEventListener('click', () => $('#engineMenu').classList.remove('show'));

  $$('.engine-option').forEach(opt => {
    opt.addEventListener('click', () => {
      setEngine(opt.dataset.engine);
      $('#engineMenu').classList.remove('show');
    });
  });

  $$('.pill-item').forEach(pill => {
    pill.addEventListener('click', () => setEngine(pill.dataset.engine));
  });

  // --- Tab 切换 ---
  $$('.nav-tab[data-target]').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.target));
  });

  // --- 添加网站按钮 ---
  $('#openAddSiteBtn').addEventListener('click', () => openSiteModal());

  // --- 网站编辑弹窗 ---
  $('#closeSiteModalBtn').addEventListener('click', closeSiteModal);
  $('#cancelSiteModalBtn').addEventListener('click', closeSiteModal);
  $('#siteModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSiteModal(); });
  $('#siteForm').addEventListener('submit', saveSite);
  $('#btnAutoFetchIcon').addEventListener('click', autoFetchIcon);
  $('#formSiteUrl').addEventListener('blur', () => {
    const url = $('#formSiteUrl').value.trim();
    if (!url) return;
    if (!$('#formSiteName').value) {
      try { $('#formSiteName').value = new URL(url).hostname.replace('www.', ''); } catch {}
    }
  });
  $('#formSiteIcon').addEventListener('input', (e) => {
    if (e.target.value) updateIconPreview(e.target.value);
  });
  $('#btnAddNewCat').addEventListener('click', () => {
    const name = prompt('请输入新分类名称:');
    if (!name?.trim()) return;
    if (appData.categories.includes(name.trim())) { toast('分类已存在', 'warning'); return; }
    appData.categories.push(name.trim());
    saveData();
    renderCategoryOptions();
    renderCategoryBar();
    $('#formSiteCategory').value = name.trim();
    toast(`分类「${name}」已创建 ✅`, 'success');
  });

  // --- Profile 编辑 (双击) ---
  $('#portalTitle').addEventListener('dblclick', () => {
    const val = prompt('请输入站点名称:', appData.profile.title);
    if (val?.trim()) { appData.profile.title = val.trim(); saveData(); renderProfile(); }
  });
  $('#portalDesc').addEventListener('dblclick', () => {
    const val = prompt('请输入站点简介:', appData.profile.subtitle);
    if (val !== null) { appData.profile.subtitle = val; saveData(); renderProfile(); }
  });
  $('#avatarBox').addEventListener('click', () => {
    const val = prompt('请输入头像图片 URL:', appData.profile.avatar);
    if (val?.trim()) { appData.profile.avatar = val.trim(); saveData(); renderProfile(); }
  });

  // --- 最近访问 ---
  $('#clearRecentBtn').addEventListener('click', () => {
    localStorage.removeItem(RECENT_KEY);
    renderRecent();
    toast('最近访问记录已清空', 'info');
  });

  // --- 顶栏按钮 ---
  $('#changeBgBtn').addEventListener('click', cycleBg);
  $('#dataManageBtn').addEventListener('click', () => {
    updateDataStats();
    $('#dataModal').classList.add('open');
  });
  $('#qrShareBtn').addEventListener('click', () => openQrModal(false));

  // --- 数据管理弹窗 ---
  $('#closeDataModalBtn').addEventListener('click', () => $('#dataModal').classList.remove('open'));
  $('#dataModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#dataModal').classList.remove('open'); });
  $('#btnExportData').addEventListener('click', exportData);
  $('#importFileInput').addEventListener('change', (e) => importData(e.target.files[0]));
  $('#btnResetDefault').addEventListener('click', resetDefault);

  // --- 粘贴板主面板 ---
  $('#clipTextarea').addEventListener('input', (e) => onClipInput(e.target.value));
  
  $('#btnModeEdit').addEventListener('click', () => {
    isPreviewMode = false;
    $('#clipTextarea').style.display = '';
    $('#clipPreviewPanel').style.display = 'none';
    $('#btnModeEdit').classList.add('active');
    $('#btnModePreview').classList.remove('active');
  });

  $('#btnModePreview').addEventListener('click', () => {
    isPreviewMode = true;
    $('#clipTextarea').style.display = 'none';
    $('#clipPreviewPanel').style.display = '';
    $('#btnModeEdit').classList.remove('active');
    $('#btnModePreview').classList.add('active');
    renderMarkdownPreview();
  });

  $('#btnCopyAll').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(clipContent);
      toast('全文已复制到剪贴板 ✅', 'success');
    } catch {
      toast('复制失败，请手动选中复制', 'error');
    }
  });

  $('#btnPasteFromSys').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const newContent = clipContent ? clipContent + '\n' + text : text;
      $('#clipTextarea').value = newContent;
      $('#drawerTextarea').value = newContent;
      onClipInput(newContent);
      toast('已从系统剪贴板粘贴 📋', 'success');
    } catch {
      toast('读取剪贴板失败，请手动粘贴到文本框中', 'warning');
    }
  });

  $('#btnClearClip').addEventListener('click', () => {
    if (!clipContent) return;
    if (!confirm('确定要清空全部粘贴板内容吗？')) return;
    $('#clipTextarea').value = '';
    $('#drawerTextarea').value = '';
    onClipInput('');
    toast('粘贴板已清空', 'info');
  });

  $('#clipQrBtn').addEventListener('click', () => openQrModal(true));

  // --- 右侧抽屉快捷便签板 ---
  $('#openDrawerCapsule').addEventListener('click', () => $('#quickDrawer').classList.add('open'));
  $('#closeDrawerBtn').addEventListener('click', () => $('#quickDrawer').classList.remove('open'));
  $('#drawerTextarea').addEventListener('input', (e) => {
    $('#clipTextarea').value = e.target.value;
    onClipInput(e.target.value);
  });
  $('#drawerCopyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(clipContent);
      toast('便签内容已复制 ✅', 'success');
    } catch { toast('复制失败', 'error'); }
  });

  // --- 扫码 QR 弹窗 ---
  $('#closeQrModalBtn').addEventListener('click', () => $('#qrModal').classList.remove('open'));
  $('#qrModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#qrModal').classList.remove('open'); });
  $('#btnCopyAddress').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#qrAddressInput').value);
      toast('地址已复制 ✅', 'success');
    } catch { toast('复制失败', 'error'); }
  });

  // URL hash 路由切换
  if (window.location.hash === '#clipboard') switchTab('tab-clipboard');
}

/* =====================================================================
   13. 应用启动入口
   ===================================================================== */
async function main() {
  await initData();
  initClipboard();
  renderAll();
  bindEvents();
  setEngine('local');
  connectSSE();
  // 每分钟更新"上次同步"显示
  setInterval(updateClipMeta, 60000);
}

document.addEventListener('DOMContentLoaded', main);
