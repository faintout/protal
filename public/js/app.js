/**
 * 极光导航 (Aurora Portal) - 前端主逻辑
 * 功能: 网站导航管理 + 多引擎搜索 + 互联网共享粘贴板
 */
(function () {
'use strict';

/* =====================================================================
   0. 常量与工具函数
   ===================================================================== */
const STORAGE_KEY = 'aurora-portal-data-v2';
const RECENT_KEY = 'aurora-recent-sites-v3';
const BACKUP_KEY = 'aurora-before-import-v1';

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

const _qs = (sel, ctx = document) => ctx.querySelector(sel);
const _qsa = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function normalizeSiteUrl(value) {
  let text = value.trim();
  if (text.indexOf('//') === 0) text = 'https:' + text;
  if (text.indexOf('://') === -1) text = 'https://' + text;
  const url = new URL(text);
  if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('请填写有效的 HTTP 或 HTTPS 网址');
  }
  return url.href;
}

function extractDomain(url) {
  try { return new URL(normalizeSiteUrl(url)).hostname.replace(/^www\./i, ''); }
  catch (e) { return ''; }
}

function genId() {
  return 'site-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

// Safari 14.2 支持 grid gap，但不支持 flex gap，需按实际布局检测。
function detectFlexGap() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;display:flex;flex-direction:column;row-gap:1px';
  for (let i = 0; i < 2; i++) {
    const child = document.createElement('div');
    child.style.height = '1px';
    probe.appendChild(child);
  }
  document.body.appendChild(probe);
  document.documentElement.classList.toggle('no-flex-gap', probe.scrollHeight !== 3);
  probe.remove();
}

/** 全局 toast 通知 */
function toast(msg, type, duration) {
  type = type || 'info';
  duration = duration || 2500;
  var container = _qs('#toastContainer');
  var el = document.createElement('div');
  el.className = 'toast';
  var colors = { info: '#6366f1', success: '#10b981', error: '#ef4444', warning: '#f59e0b' };
  el.style.borderColor = colors[type] || colors.info;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(function() {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.4s';
    setTimeout(function() { el.remove(); }, 400);
  }, duration);
}

/**
 * 兼容性复制文本函数 (iOS 11+)
 * 优先使用 Clipboard API，低版本iOS降级使用 execCommand
 */
function copyTextCompat(text, successMsg, failMsg) {
  successMsg = successMsg || '已复制';
  failMsg = failMsg || '复制失败，请手动复制';
  if (!text) { toast(failMsg, 'warning'); return; }

  // 方案一：现代 Clipboard API (iOS 13.4+ / Android / PC)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      toast(successMsg, 'success');
    }).catch(function() {
      // 降级到方案二
      legacyCopy(text, successMsg, failMsg);
    });
    return;
  }
  // 方案二：execCommand 降级 (iOS 11-13, Android 旧版)
  legacyCopy(text, successMsg, failMsg);
}

function legacyCopy(text, successMsg, failMsg) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  // iOS 需要额外设置 selectionRange
  ta.setSelectionRange(0, text.length);
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  toast(ok ? successMsg : failMsg, ok ? 'success' : 'error');
}


/* ======================================================================
   1. 数据层 (服务器 KV 为主，LocalStorage 为快速缓存)
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
      { id: 'site-15', name: 'V2EX', url: 'https://www.v2ex.com', category: '开发编程', desc: '创意工作者与程序员讨论社区', icon: 'https://www.google.com/s2/favicons?domain=v2ex.com&sz=64' },
      { id: 'site-16', name: '掘金', url: 'https://juejin.cn', category: '开发编程', desc: '面向开发者的技术分享社区', icon: 'https://www.google.com/s2/favicons?domain=juejin.cn&sz=64' },
      { id: 'site-17', name: 'MDN Web Docs', url: 'https://developer.mozilla.org', category: '开发编程', desc: '权威现代 Web 技术标准指南', icon: 'https://www.google.com/s2/favicons?domain=developer.mozilla.org&sz=64' },
      { id: 'site-18', name: 'TinyPNG', url: 'https://tinypng.com', category: '实用工具', desc: '智能高质量在线图片压缩', icon: 'https://www.google.com/s2/favicons?domain=tinypng.com&sz=64' },
      { id: 'site-20', name: 'Cloudflare', url: 'https://dash.cloudflare.com', category: '实用工具', desc: 'CDN 加速与安全防护服务', icon: 'https://www.google.com/s2/favicons?domain=cloudflare.com&sz=64' },
    ]
  };
}

/** 将当前 appData 保存到 localStorage + 异步同步到服务器 KV */
function saveData() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appData)); } catch (e) {}
  // 同步到服务器 KV（带状态反馈）
  return syncToServer();
}

// 头部状态同时反映网址和粘贴板的服务器连接，不能把读取成功留在“加载中”。
const cloudState = { sites: 'loading', clipboard: 'loading' };
function setCloudState(service, state) {
  cloudState[service] = state;
  const states = [cloudState.sites, cloudState.clipboard];
  const failed = states.includes('error');
  const syncing = states.includes('syncing');
  const loading = states.includes('loading');
  _qs('#kvSyncLabel').textContent = failed ? '云端连接失败' : syncing ? '同步中…' : loading ? '连接中…' : '云端已连接';
  _qs('#kvSyncIndicator').style.background = failed ? '#ef4444' : syncing || loading ? '#f59e0b' : '#10b981';
  const labels = { loading: '连接中', syncing: '等待保存', ready: '已连接', error: '连接失败' };
  _qs('#kvSyncBadge').title = '网址：' + labels[cloudState.sites] + '；粘贴板：' + labels[cloudState.clipboard];
}

/** 按顺序同步网址数据到服务器 */
let pendingSiteSync = Promise.resolve();
function syncToServer(data = appData) {
  const body = JSON.stringify(data);
  pendingSiteSync = pendingSiteSync.then(() => sendSiteData(body));
  return pendingSiteSync;
}

async function sendSiteData(body) {
  setCloudState('sites', 'syncing');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    var res = await fetch('/api/sites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
    if (res.ok) {
      setCloudState('sites', 'ready');
      return true;
    }
  } catch (e) {}
  finally { clearTimeout(timeout); }
  // 失败处理
  setCloudState('sites', 'error');
  return false;
}

/**
 * 初始化数据策略：服务器 KV 为权威源
 * 浏览器缓存只用于显示网址；共享数据以服务器响应为准。
 */
async function initData() {
  // 第一步：先用 localStorage 快速呈现（避免白屏）
  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}
  if (saved) {
    try {
      appData = JSON.parse(saved);
      if (!appData.profile) appData.profile = DEFAULT_PROFILE;
    } catch (e) {
      appData = { profile: DEFAULT_PROFILE, categories: [], sites: [] };
    }
  }

  setCloudState('sites', 'loading');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  // 第二步：从服务器读取最新数据，超时或失败时明确提示。
  try {
    var res = await fetch('/api/sites', { cache: 'no-store', signal: controller.signal });
    if (res.ok) {
      var serverData = await res.json();
      if (serverData && Array.isArray(serverData.sites) && Array.isArray(serverData.categories)) {
        appData = serverData;
        if (!appData.profile) appData.profile = DEFAULT_PROFILE;
        // 将服务器最新数据回写到 localStorage
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(appData)); } catch (e) {}
        // 重新渲染以反映最新数据
        setCloudState('sites', 'ready');
        return;
      }
    }
  } catch (e) {}
  finally { clearTimeout(timeout); }
  setCloudState('sites', 'error');
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
let currentFilter = null;
let searchKeyword = '';
let siteDrag = null;
let suppressSiteClickId = null;
let categoryDrag = null;
let suppressCategoryClick = null;

/** 渲染 profile 区域 */
function renderProfile() {
  const { title, subtitle, avatar } = appData.profile || DEFAULT_PROFILE;
  _qs('#portalTitle').textContent = title || '极光导航';
  _qs('#portalDesc').textContent = subtitle || '上网，从这开始！';
  const img = _qs('#userAvatar');
  img.src = avatar || DEFAULT_PROFILE.avatar;
  img.onerror = () => { img.src = DEFAULT_PROFILE.avatar; };
}

/** 渲染分类过滤栏 */
function renderCategoryBar() {
  const bar = _qs('#categoryFilterBar');
  const cats = appData.categories || [];
  bar.innerHTML = `<button class="cat-pill ${currentFilter === null ? 'active' : ''}" data-all="true">全部</button>`;
  cats.forEach(cat => {
    const count = appData.sites.filter(s => s.category === cat).length;
    if (count === 0) return;
    bar.innerHTML += `<button class="cat-pill ${currentFilter === cat ? 'active' : ''}" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)} <span style="opacity:0.6;font-size:11px;">${count}</span><span class="category-drag-handle" title="拖动排序" aria-hidden="true"></span></button>`;
  });
  _qsa('.cat-pill', bar).forEach(btn => {
    btn.onclick = () => {
      currentFilter = btn.hasAttribute('data-all') ? null : btn.dataset.cat;
      renderSites();
      renderCategoryBar();
    };
  });
}

/** 重命名分类标签，同时更新所有关联网站。 */
function renameCategory(category) {
  if (importingData || !appData.categories.includes(category)) return;
  const value = prompt('编辑标签名称（该标签下的网站会一起更新）：', category);
  if (value === null) return;
  const name = value.trim();
  if (!name) { toast('标签名称不能为空', 'warning'); return; }
  if (name === category) return;
  if (appData.categories.some(cat => cat !== category && cat.trim() === name)) {
    toast('标签名称已存在，请使用其他名称', 'warning');
    return;
  }
  const selectedCategory = _qs('#formSiteCategory').value;
  appData.categories = appData.categories.map(cat => cat === category ? name : cat);
  appData.sites.forEach(site => { if (site.category === category) site.category = name; });
  if (currentFilter === category) currentFilter = name;
  renderAll();
  _qs('#formSiteCategory').value = selectedCategory === category ? name : selectedCategory;
  saveData().then(saved => {
    toast(saved ? '标签已更新并保存到云端' : '标签已修改，但云端保存失败，请检查网络后重新保存网站', saved ? 'success' : 'warning', 4000);
  });
}

/** 创建网站卡片 HTML */
function createSiteCard(site, showTools = true) {
  const domain = extractDomain(site.url);
  const iconSrc = site.icon || `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
  const canDrag = showTools && !searchKeyword.trim();
  const card = document.createElement('a');
  card.className = 'site-card';
  card.href = 'javascript:void(0)';
  card.title = site.desc || site.name;
  card.dataset.id = site.id;
  card.dataset.draggable = canDrag ? 'true' : 'false';
  card.innerHTML = `
    ${canDrag ? '<span class="site-drag-handle" title="拖动排序或移动分类" aria-hidden="true"></span>' : ''}
    <div class="site-icon-box">
      <img src="${escapeHtml(iconSrc)}" alt="${escapeHtml(site.name)}">
    </div>
    <div class="site-info">
      <div class="site-name">${escapeHtml(site.name)}</div>
      ${site.desc ? `<div class="site-desc">${escapeHtml(site.desc)}</div>` : ''}
    </div>
    ${showTools ? `
    <div class="card-tools">
      <button class="tool-icon-btn" data-action="edit" data-id="${escapeHtml(site.id)}" title="编辑">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
      </button>
      <button class="tool-icon-btn delete" data-action="delete" data-id="${escapeHtml(site.id)}" title="删除">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
      </button>
    </div>` : ''}
  `;
  card.draggable = false;
  _qs('img', card).draggable = false;
  _qs('img', card).onerror = function() {
    this.parentElement.innerHTML = '<span class="default-icon">🌐</span>';
  };
  // 点击打开
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-tools, .site-drag-handle')) return;
    addRecent(site.id);
    window.open(site.url, '_blank', 'noopener,noreferrer');
  });
  // 编辑/删除按钮（兼容旧iOS，不用可选链）
  if (showTools) {
    var editBtn = card.querySelector('[data-action="edit"]');
    if (editBtn) editBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      openSiteModal(site.id);
    });
    var delBtn = card.querySelector('[data-action="delete"]');
    if (delBtn) delBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      deleteSite(site.id);
    });
  }
  return card;
}

function moveSite(siteId, targetCategory, targetId, after) {
  if (importingData || !appData.categories.includes(targetCategory)) return false;
  const site = appData.sites.find(item => item.id === siteId);
  if (!site) return false;

  const sourceCategory = site.category;
  const targetSites = appData.sites.filter(item => item.category === targetCategory && item.id !== siteId);
  let targetIndex = targetSites.length;
  if (targetId) {
    const index = targetSites.findIndex(item => item.id === targetId);
    if (index < 0) return false;
    targetIndex = index + (after ? 1 : 0);
  }
  targetSites.splice(targetIndex, 0, site);

  if (sourceCategory === targetCategory) {
    const currentSites = appData.sites.filter(item => item.category === sourceCategory);
    if (currentSites.every((item, index) => item.id === targetSites[index].id)) return false;
    let index = 0;
    appData.sites = appData.sites.map(item => item.category === sourceCategory ? targetSites[index++] : item);
    return true;
  }

  const remainingSites = appData.sites.filter(item => item.id !== siteId);
  const sourceSites = remainingSites.filter(item => item.category === sourceCategory);
  const targetSlotCount = remainingSites.filter(item => item.category === targetCategory).length;
  site.category = targetCategory;
  let sourceIndex = 0;
  let targetSlotIndex = 0;
  appData.sites = remainingSites.map(item => {
    if (item.category === sourceCategory) return sourceSites[sourceIndex++];
    if (item.category === targetCategory) return targetSites[targetSlotIndex++];
    return item;
  });
  if (targetSlotIndex < targetSites.length) appData.sites.push(...targetSites.slice(targetSlotCount));
  return true;
}

function clearSiteDragTarget() {
  if (!siteDrag) return;
  if (siteDrag.target) siteDrag.target.element.classList.remove('drop-target');
  if (siteDrag.placeholder && siteDrag.placeholder.parentNode) {
    siteDrag.placeholder.parentNode.removeChild(siteDrag.placeholder);
  }
  siteDrag.target = null;
}

function updateSiteDragTarget(x, y) {
  const matrix = _qs('#sitesMatrix');
  const element = document.elementFromPoint(x, y);
  if (element && element.closest('.site-drop-placeholder') && siteDrag.target) return;

  const targetCard = element ? element.closest('.site-card') : null;
  let section = null;
  let target = null;
  if (targetCard && matrix.contains(targetCard)) {
    if (targetCard !== siteDrag.card) {
      section = targetCard.closest('.section-container[data-category]');
      if (section) {
        const rect = targetCard.getBoundingClientRect();
        const after = y >= rect.top + rect.height / 2;
        target = { category: section.dataset.category, siteId: targetCard.dataset.id, after, element: section, card: targetCard };
      }
    }
  } else if (element) {
    section = element.closest('#sitesMatrix .section-container[data-category]');
    if (section) target = { category: section.dataset.category, siteId: null, after: true, element: section, card: null };
  }

  if (!target) {
    clearSiteDragTarget();
    return;
  }
  const current = siteDrag.target;
  if (current && current.category === target.category && current.siteId === target.siteId && current.after === target.after) return;

  clearSiteDragTarget();
  section.classList.add('drop-target');
  const grid = _qs('.sites-grid', section);
  if (target.card) {
    const reference = target.after ? target.card.nextSibling : target.card;
    grid.insertBefore(siteDrag.placeholder, reference);
  } else {
    const addCard = _qs('.add-site-card', grid);
    if (addCard) grid.insertBefore(siteDrag.placeholder, addCard);
    else grid.appendChild(siteDrag.placeholder);
  }
  siteDrag.target = target;
}

function startSiteDrag(event) {
  if (siteDrag || importingData || searchKeyword.trim() || (event.button !== undefined && event.button !== 0)) return;
  const card = event.target.closest('.site-card');
  const matrix = _qs('#sitesMatrix');
  if (!card || card.dataset.draggable !== 'true' || !matrix.contains(card) || event.target.closest('.card-tools')) return;
  if (event.pointerType === 'touch' && !event.target.closest('.site-drag-handle')) return;
  const rect = card.getBoundingClientRect();
  siteDrag = {
    id: card.dataset.id, card, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
    width: rect.width, height: rect.height,
    started: false, target: null, placeholder: null, preview: null,
  };
}

function moveSiteDrag(event) {
  if (!siteDrag || event.pointerId !== siteDrag.pointerId) return;
  const dx = event.clientX - siteDrag.startX;
  const dy = event.clientY - siteDrag.startY;
  if (!siteDrag.started && Math.sqrt(dx * dx + dy * dy) < 6) return;
  if (!siteDrag.started) {
    siteDrag.started = true;
    siteDrag.card.classList.add('is-dragging');
    document.documentElement.classList.add('site-dragging');
    siteDrag.placeholder = document.createElement('div');
    siteDrag.placeholder.className = 'site-drop-placeholder';
    siteDrag.placeholder.setAttribute('aria-hidden', 'true');
    siteDrag.placeholder.style.height = siteDrag.height + 'px';
    siteDrag.preview = siteDrag.card.cloneNode(true);
    siteDrag.preview.classList.remove('is-dragging');
    siteDrag.preview.classList.add('site-drag-preview');
    siteDrag.preview.setAttribute('aria-hidden', 'true');
    siteDrag.preview.style.width = siteDrag.width + 'px';
    siteDrag.preview.style.height = siteDrag.height + 'px';
    document.body.appendChild(siteDrag.preview);
  }
  event.preventDefault();
  siteDrag.preview.style.left = event.clientX - siteDrag.offsetX + 'px';
  siteDrag.preview.style.top = event.clientY - siteDrag.offsetY + 'px';
  updateSiteDragTarget(event.clientX, event.clientY);
}

function finishSiteDrag(event, cancelled) {
  if (!siteDrag || event.pointerId !== siteDrag.pointerId) return;
  const drag = siteDrag;
  const target = drag.target;
  clearSiteDragTarget();
  drag.card.classList.remove('is-dragging');
  if (drag.preview && drag.preview.parentNode) drag.preview.parentNode.removeChild(drag.preview);
  document.documentElement.classList.remove('site-dragging');
  siteDrag = null;
  if (cancelled || !drag.started) return;

  suppressSiteClickId = drag.id;
  setTimeout(() => { if (suppressSiteClickId === drag.id) suppressSiteClickId = null; }, 500);
  if (!target || !moveSite(drag.id, target.category, target.siteId, target.after)) return;
  renderAll();
  saveData().then(saved => {
    if (!saved) toast('顺序已调整，但云端保存失败，请检查网络后重新保存', 'warning', 4000);
  });
}

function clearCategoryDragTarget() {
  if (!categoryDrag) return;
  if (categoryDrag.target) categoryDrag.target.element.classList.remove('drop-target');
  if (categoryDrag.placeholder && categoryDrag.placeholder.parentNode) {
    categoryDrag.placeholder.parentNode.removeChild(categoryDrag.placeholder);
  }
  categoryDrag.target = null;
}

function updateCategoryDragTarget(x, y) {
  const bar = _qs('#categoryFilterBar');
  const element = document.elementFromPoint(x, y);
  if (element && element.closest('.category-drop-placeholder') && categoryDrag.target) return;

  const pill = element ? element.closest('.cat-pill') : null;
  let target = null;
  if (pill && bar.contains(pill)) {
    if (pill.hasAttribute('data-all')) {
      target = { atStart: true, element: pill };
    } else if (pill.dataset.cat !== categoryDrag.category) {
      const rect = pill.getBoundingClientRect();
      target = { category: pill.dataset.cat, after: x >= rect.left + rect.width / 2, element: pill };
    }
  } else if (element && bar.contains(element)) {
    target = { atEnd: true, element: bar };
  }

  if (!target) {
    clearCategoryDragTarget();
    return;
  }
  const current = categoryDrag.target;
  if (current && current.category === target.category && current.after === target.after && current.atStart === target.atStart && current.atEnd === target.atEnd) return;

  clearCategoryDragTarget();
  target.element.classList.add('drop-target');
  if (target.atStart) {
    const firstPill = _qs('.cat-pill[data-cat]', bar);
    bar.insertBefore(categoryDrag.placeholder, firstPill);
  } else if (target.atEnd) {
    bar.appendChild(categoryDrag.placeholder);
  } else {
    const reference = target.after ? target.element.nextSibling : target.element;
    bar.insertBefore(categoryDrag.placeholder, reference);
  }
  categoryDrag.target = target;
}

function startCategoryDrag(event) {
  if (categoryDrag || importingData || (event.button !== undefined && event.button !== 0)) return;
  const pill = event.target.closest('.cat-pill[data-cat]');
  if (!pill) return;
  if (event.pointerType === 'touch' && !event.target.closest('.category-drag-handle')) return;
  const rect = pill.getBoundingClientRect();
  categoryDrag = {
    category: pill.dataset.cat, pill, pointerId: event.pointerId,
    startX: event.clientX, startY: event.clientY,
    offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
    width: rect.width, height: rect.height,
    started: false, target: null, placeholder: null, preview: null,
  };
}

function moveCategoryDrag(event) {
  if (!categoryDrag || event.pointerId !== categoryDrag.pointerId) return;
  const dx = event.clientX - categoryDrag.startX;
  const dy = event.clientY - categoryDrag.startY;
  if (!categoryDrag.started && Math.sqrt(dx * dx + dy * dy) < 6) return;
  if (!categoryDrag.started) {
    categoryDrag.started = true;
    categoryDrag.pill.classList.add('is-dragging');
    document.documentElement.classList.add('site-dragging');
    categoryDrag.placeholder = document.createElement('div');
    categoryDrag.placeholder.className = 'category-drop-placeholder';
    categoryDrag.placeholder.setAttribute('aria-hidden', 'true');
    categoryDrag.placeholder.style.width = categoryDrag.width + 'px';
    categoryDrag.placeholder.style.height = categoryDrag.height + 'px';
    categoryDrag.preview = categoryDrag.pill.cloneNode(true);
    categoryDrag.preview.classList.remove('active', 'is-dragging');
    categoryDrag.preview.classList.add('category-drag-preview');
    categoryDrag.preview.setAttribute('aria-hidden', 'true');
    categoryDrag.preview.style.width = categoryDrag.width + 'px';
    categoryDrag.preview.style.height = categoryDrag.height + 'px';
    document.body.appendChild(categoryDrag.preview);
  }
  event.preventDefault();
  categoryDrag.preview.style.left = event.clientX - categoryDrag.offsetX + 'px';
  categoryDrag.preview.style.top = event.clientY - categoryDrag.offsetY + 'px';
  updateCategoryDragTarget(event.clientX, event.clientY);
}

function reorderCategory(category, target) {
  if (!target) return false;
  const next = appData.categories.slice();
  const sourceIndex = next.indexOf(category);
  if (sourceIndex < 0) return false;
  const moving = next.splice(sourceIndex, 1)[0];
  let targetIndex;
  if (target.atStart) targetIndex = 0;
  else if (target.atEnd) targetIndex = next.length;
  else {
    if (target.category === category) return false;
    targetIndex = next.indexOf(target.category);
    if (targetIndex < 0) return false;
    if (target.after) targetIndex++;
  }
  next.splice(targetIndex, 0, moving);
  if (next.every((item, index) => item === appData.categories[index])) return false;
  appData.categories = next;
  return true;
}

function finishCategoryDrag(event, cancelled) {
  if (!categoryDrag || event.pointerId !== categoryDrag.pointerId) return;
  const drag = categoryDrag;
  const target = drag.target;
  clearCategoryDragTarget();
  drag.pill.classList.remove('is-dragging');
  if (drag.preview && drag.preview.parentNode) drag.preview.parentNode.removeChild(drag.preview);
  document.documentElement.classList.remove('site-dragging');
  categoryDrag = null;
  if (cancelled || !drag.started) return;

  suppressCategoryClick = true;
  setTimeout(() => { suppressCategoryClick = false; }, 500);
  if (!reorderCategory(drag.category, target)) return;
  renderAll();
  saveData().then(saved => {
    if (!saved) toast('标签顺序已调整，但云端保存失败，请检查网络后重新保存', 'warning', 4000);
  });
}

function suppressDraggedSiteClick(event) {
  if (!suppressSiteClickId) return;
  const card = event.target.closest('#sitesMatrix .site-card');
  if (!card || card.dataset.id !== suppressSiteClickId) return;
  event.preventDefault();
  event.stopPropagation();
  suppressSiteClickId = null;
}

function suppressDraggedCategoryClick(event) {
  if (!suppressCategoryClick) return;
  const pill = event.target.closest('#categoryFilterBar .cat-pill');
  if (!pill) return;
  event.preventDefault();
  event.stopPropagation();
  suppressCategoryClick = false;
}

/** 渲染主网站矩阵 */
function renderSites() {
  const matrix = _qs('#sitesMatrix');
  matrix.innerHTML = '';
  const cats = appData.categories || [];

  // 确定哪些分类需要渲染
  const targetCats = currentFilter === null ? cats : [currentFilter];

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
    if (catSites.length === 0 && currentFilter !== null) return;

    const section = document.createElement('div');
    section.className = 'section-container';
    section.dataset.category = cat;

    const header = document.createElement('div');
    header.className = 'section-header category-header';
    header.innerHTML = `<h2 class="section-title">${getCatEmoji(cat)} ${escapeHtml(cat)}</h2>`;
    const editCategoryBtn = document.createElement('button');
    editCategoryBtn.type = 'button';
    editCategoryBtn.className = 'btn-text-sm edit-category-btn';
    editCategoryBtn.dataset.category = cat;
    editCategoryBtn.textContent = '编辑标签';
    editCategoryBtn.setAttribute('aria-label', '编辑标签：' + cat);
    editCategoryBtn.onclick = () => renameCategory(cat);
    header.appendChild(editCategoryBtn);
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
  const section = _qs('#recentSection');
  const grid = _qs('#recentGrid');
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
  _qs('#currentEngineIcon').textContent = eng.icon;
  _qs('#currentEngineText').textContent = eng.name;
  _qsa('.engine-option').forEach(opt => opt.classList.toggle('active', opt.dataset.engine === key));
  _qsa('.pill-item').forEach(p => p.classList.toggle('active', p.dataset.engine === key));
  _qs('#searchInput').placeholder = key === 'local' ? '输入关键字站内搜索，实时过滤导航网站...' : `在 ${eng.name} 中搜索...`;
}

function doSearch() {
  const val = _qs('#searchInput').value.trim();
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
  _qsa('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.target === targetId));
  _qsa('.tab-panel').forEach(p => p.classList.toggle('active', p.id === targetId));
}

/* =====================================================================
   6. 网站弹窗 (新增 / 编辑)
   ===================================================================== */
let metadataRequest = 0;
let metadataTimer = null;
let metadataController = null;
let metadataUrl = '';
let autoSiteName = '';
let autoSiteIcon = '';

function cancelMetadataFetch() {
  metadataRequest++;
  clearTimeout(metadataTimer);
  if (metadataController) metadataController.abort();
  metadataController = null;
  _qs('#btnAutoFetchIcon').disabled = false;
  _qs('#btnAutoFetchIcon').textContent = '获取名称和图标';
  _qs('#saveSiteBtn').disabled = false;
}

function openSiteModal(siteId = null, prefillCat = null) {
  cancelMetadataFetch();
  metadataUrl = '';
  autoSiteName = '';
  autoSiteIcon = '';
  _qs('#siteMetadataStatus').textContent = '输入网址后自动获取名称和图标，也可手动修改。';
  const modal = _qs('#siteModal');
  const form = _qs('#siteForm');
  form.reset();
  renderCategoryOptions();
  _qs('#editSiteId').value = '';
  _qs('#formIconPreview').src = '';
  _qs('#formIconPreview').style.display = 'none';
  _qs('#formIconPlaceholder').style.display = '';

  if (siteId) {
    const site = appData.sites.find(s => s.id === siteId);
    if (!site) return;
    _qs('#siteModalTitle').textContent = '编辑网站';
    _qs('#editSiteId').value = site.id;
    _qs('#formSiteUrl').value = site.url;
    _qs('#formSiteName').value = site.name;
    _qs('#formSiteCategory').value = site.category;
    _qs('#formSiteDesc').value = site.desc || '';
    _qs('#formSiteIcon').value = site.icon || '';
    if (site.icon) updateIconPreview(site.icon);
  } else {
    _qs('#siteModalTitle').textContent = '添加新网站';
    if (prefillCat) _qs('#formSiteCategory').value = prefillCat;
  }
  modal.classList.add('open');
}

function closeSiteModal() {
  cancelMetadataFetch();
  _qs('#siteModal').classList.remove('open');
}

function renderCategoryOptions() {
  const sel = _qs('#formSiteCategory');
  const current = sel.value;
  sel.innerHTML = (appData.categories || []).map(cat => `<option value="${escapeHtml(cat)}" ${cat === current ? 'selected' : ''}>${escapeHtml(cat)}</option>`).join('');
  _qs('#btnEditCat').disabled = !sel.value;
}

function updateIconPreview(url) {
  const img = _qs('#formIconPreview');
  const placeholder = _qs('#formIconPlaceholder');
  if (!url) {
    img.removeAttribute('src');
    img.style.display = 'none';
    placeholder.style.display = '';
    return;
  }
  img.onerror = () => { img.style.display = 'none'; placeholder.style.display = ''; };
  img.src = url;
  img.style.display = '';
  placeholder.style.display = 'none';
}

async function autoFetchMetadata(force = false) {
  const input = _qs('#formSiteUrl');
  const status = _qs('#siteMetadataStatus');
  if (!input.value.trim()) {
    _qs('#saveSiteBtn').disabled = false;
    return;
  }
  let url;
  try { url = normalizeSiteUrl(input.value); }
  catch (e) {
    status.textContent = '请填写有效的 HTTP 或 HTTPS 网址。';
    _qs('#saveSiteBtn').disabled = false;
    return;
  }
  if (!force && metadataUrl === url) return;
  cancelMetadataFetch();
  const request = metadataRequest;
  metadataUrl = url;
  input.value = url;
  const nameInput = _qs('#formSiteName');
  const iconInput = _qs('#formSiteIcon');
  const fallbackIcon = new URL('/favicon.ico', url).href;
  if (!nameInput.value || nameInput.value === autoSiteName) {
    autoSiteName = extractDomain(url);
    nameInput.value = autoSiteName;
  }
  if (!iconInput.value || iconInput.value === autoSiteIcon) {
    autoSiteIcon = fallbackIcon;
    iconInput.value = autoSiteIcon;
    updateIconPreview(autoSiteIcon);
  }
  const btn = _qs('#btnAutoFetchIcon');
  btn.textContent = '获取中...';
  btn.disabled = true;
  _qs('#saveSiteBtn').disabled = true;
  status.textContent = '正在读取网站名称和图标…';
  const controller = new AbortController();
  metadataController = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('/api/site-metadata?url=' + encodeURIComponent(url), { signal: controller.signal });
    if (!res.ok) throw new Error('获取失败');
    const data = await res.json();
    if (request !== metadataRequest) return;
    if (typeof data.title === 'string' && data.title.trim() && (!nameInput.value || nameInput.value === autoSiteName)) {
      autoSiteName = data.title.trim();
      nameInput.value = autoSiteName;
    }
    if (data.icon && (!iconInput.value || iconInput.value === autoSiteIcon)) {
      autoSiteIcon = normalizeSiteUrl(data.icon);
      iconInput.value = autoSiteIcon;
      updateIconPreview(autoSiteIcon);
    }
    status.textContent = data.title ? '已读取网站信息，名称和图标均可手动修改。' : '网站未提供标题，已使用域名；可手动修改。';
  } catch (e) {
    if (request !== metadataRequest) return;
    metadataUrl = '';
    status.textContent = '无法读取网站信息，已保留填写内容；空项使用域名和默认图标，可手动修改或重试。';
  } finally {
    clearTimeout(timeout);
    if (request === metadataRequest) {
      metadataController = null;
      btn.textContent = '获取名称和图标';
      btn.disabled = false;
      _qs('#saveSiteBtn').disabled = false;
    }
  }
}

function saveSite(e) {
  e.preventDefault();
  if (_qs('#saveSiteBtn').disabled || importingData) return;
  const editId = _qs('#editSiteId').value;
  const site = {
    id: editId || genId(),
    name: _qs('#formSiteName').value.trim(),
    url: _qs('#formSiteUrl').value.trim(),
    category: _qs('#formSiteCategory').value,
    desc: _qs('#formSiteDesc').value.trim(),
    icon: _qs('#formSiteIcon').value.trim(),
  };
  if (!site.name || !site.url || !site.category) return;
  try {
    site.url = normalizeSiteUrl(site.url);
    if (site.icon) site.icon = normalizeSiteUrl(site.icon);
  } catch (err) {
    toast('网址和图标须为有效的 HTTP 或 HTTPS 地址', 'warning');
    return;
  }

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
  _qs('#statSitesCount').textContent = appData.sites.length;
  _qs('#statCatsCount').textContent = appData.categories.length;
  _qs('#statStorageType').textContent = '服务器';
  let hasBackup = false;
  try { hasBackup = !!localStorage.getItem(BACKUP_KEY); } catch (e) {}
  _qs('#btnRestoreBackup').disabled = importingData || !hasBackup;
}

function exportData() {
  const blob = new Blob([JSON.stringify(appData, null, 2)], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  a.href = objectUrl;
  a.download = `aurora-portal-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  // iOS Safari 需要将下载链接挂到页面，且不能立即释放 Blob URL。
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  toast('已发起备份下载，可在浏览器下载列表中保存 JSON 文件', 'success');
}

function validateBackup(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.sites)) {
    throw new Error('备份必须包含 sites 网址列表');
  }
  const categories = json.categories === undefined ? [] : json.categories;
  if (!Array.isArray(categories) || categories.some(cat => typeof cat !== 'string' || !cat.trim())) {
    throw new Error('分类必须是非空名称列表');
  }
  const data = { profile: Object.assign({}, appData.profile), categories: [], sites: [] };
  categories.forEach(cat => { if (!data.categories.includes(cat)) data.categories.push(cat); });
  if (json.profile !== undefined) {
    if (!json.profile || typeof json.profile !== 'object' || Array.isArray(json.profile)) throw new Error('个人配置格式错误');
    ['title', 'subtitle', 'avatar'].forEach(key => {
      if (json.profile[key] !== undefined) {
        if (typeof json.profile[key] !== 'string') throw new Error('个人配置格式错误');
        data.profile[key] = json.profile[key];
      }
    });
    if (data.profile.avatar) data.profile.avatar = normalizeSiteUrl(data.profile.avatar);
  }
  const ids = new Set();
  data.sites = json.sites.map((site, index) => {
    if (!site || typeof site.name !== 'string' || !site.name.trim() ||
        typeof site.url !== 'string' || !site.url.trim() ||
        typeof site.category !== 'string' || !site.category.trim() ||
        (site.desc !== undefined && typeof site.desc !== 'string') ||
        (site.icon !== undefined && typeof site.icon !== 'string')) {
      throw new Error(`第 ${index + 1} 个网址的名称、链接或分类格式错误`);
    }
    let url, icon;
    try {
      url = normalizeSiteUrl(site.url);
      icon = site.icon ? normalizeSiteUrl(site.icon) : '';
    } catch (e) { throw new Error(`第 ${index + 1} 个网址或图标地址无效`); }
    const id = typeof site.id === 'string' && site.id && !ids.has(site.id) ? site.id : genId();
    ids.add(id);
    if (!data.categories.includes(site.category)) data.categories.push(site.category);
    return { id, name: site.name.trim(), url, category: site.category, desc: site.desc || '', icon };
  });
  return data;
}

let importingData = false;

function setImportingData(value) {
  importingData = value;
  _qs('#closeDataModalBtn').disabled = value;
  _qs('#btnResetDefault').disabled = value;
  _qs('#importFileInput').disabled = value;
  updateDataStats();
}

async function applyBackup(data) {
  // 服务器为权威源；同步成功后才替换页面，失败时原数据保持可用。
  if (!await syncToServer(data)) throw new Error('服务器同步失败，原数据未更改，请稍后重试');
  appData = data;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) { toast('已保存至服务器，但浏览器缓存空间不足，请导出备份', 'warning', 5000); }
  currentFilter = null;
  searchKeyword = '';
  _qs('#searchInput').value = '';
  _qs('#searchClearBtn').style.display = 'none';
  renderAll();
}

function importData(file) {
  if (!file || importingData) return;
  const input = _qs('#importFileInput');
  if (file.size > 5 * 1024 * 1024) {
    toast('备份文件不能超过 5 MB', 'error');
    input.value = '';
    return;
  }
  setImportingData(true);
  const finish = () => {
    setImportingData(false);
    input.value = ''; // 同一个文件可再次选择。
  };
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = validateBackup(JSON.parse(e.target.result.replace(/^\uFEFF/, '')));
      if (!confirm(`确认导入 ${data.sites.length} 个网址并覆盖现有 ${appData.sites.length} 个网址？覆盖前会在本浏览器保存一份备份。`)) return;
      localStorage.setItem(BACKUP_KEY, JSON.stringify(appData));
      await applyBackup(data);
      toast(`成功导入 ${data.sites.length} 个网址，可恢复导入前备份`, 'success');
    } catch (err) { toast('导入失败：' + err.message, 'error', 5000); }
    finally { finish(); }
  };
  reader.onerror = () => { toast('无法读取文件，请重新选择备份', 'error'); finish(); };
  reader.onabort = finish;
  reader.readAsText(file, 'UTF-8');
}

async function restoreBackup() {
  const backup = localStorage.getItem(BACKUP_KEY);
  if (!backup || importingData) return;
  if (!confirm('恢复上次导入前的备份？这将覆盖当前的网址、分类和个人配置。')) return;
  setImportingData(true);
  try {
    await applyBackup(validateBackup(JSON.parse(backup)));
    toast('已恢复导入前备份', 'success');
  } catch (err) { toast('恢复失败：' + err.message, 'error', 5000); }
  finally { setImportingData(false); }
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
let isPreviewMode = false;
let clipReady = false;
let clipDirty = false;
let clipEditVersion = 0;
let clipServerTime = 0;
let clipRequestRunning = false;
let lastClipWriteTime = 0;
let lastSyncTime = 0;

/** 粘贴板只从服务器初始化，不读取或广播浏览器中的旧内容。 */
function initClipboard() {
  setClipboardEnabled(false);
  updateSyncStatus('loading', '正在连接云端粘贴板…');
  updateClipMeta();
  syncClipboard();
  window.addEventListener('online', () => scheduleClipSync(0));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleClipSync(0);
  });
}

function setClipboardEnabled(enabled) {
  ['#clipTextarea', '#drawerTextarea', '#btnPasteFromSys', '#btnClearClip'].forEach(selector => {
    _qs(selector).disabled = !enabled;
  });
}

function renderClipContent() {
  ['#clipTextarea', '#drawerTextarea'].forEach(selector => {
    const input = _qs(selector);
    // 相同内容不重新赋值，以免移动正在编辑的光标。
    if (input.value !== clipContent) input.value = clipContent;
  });
  if (isPreviewMode) renderMarkdownPreview();
  updateClipMeta();
}

/** 更新字数/行数统计 */
function updateClipMeta() {
  const txt = clipContent || '';
  const lines = txt.split('\n').length;
  _qs('#clipWordsMeta').textContent = `字符: ${txt.length}`;
  _qs('#clipLinesMeta').textContent = `行数: ${lines}`;
  const mins = Math.floor((Date.now() - lastSyncTime) / 60000);
  _qs('#clipTimeMeta').textContent = clipDirty ? '修改尚未上传' : !lastSyncTime ? '尚未连接' : mins === 0 ? '刚刚同步' : `${mins} 分钟前同步`;
}

function onClipInput(content) {
  if (!clipReady) return;
  clipContent = content;
  clipDirty = true;
  clipEditVersion++;
  renderClipContent();
  updateSyncStatus('syncing', '等待上传到云端…');
  scheduleClipSync(1000);
}

function scheduleClipSync(delay) {
  clearTimeout(clipSyncTimer);
  // KV 同一键的写入至少间隔一秒；输入防抖也使用此间隔。
  if (clipDirty) delay = Math.max(delay, 1000 - (Date.now() - lastClipWriteTime));
  clipSyncTimer = setTimeout(syncClipboard, delay);
}

/** 单次只发送一个请求：有修改时上传，否则每三秒检查云端内容。 */
async function syncClipboard() {
  if (clipRequestRunning) return;
  clearTimeout(clipSyncTimer);
  clipRequestRunning = true;
  const sending = clipDirty;
  const editVersion = clipEditVersion;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let succeeded = false;
  if (sending) {
    lastClipWriteTime = Date.now();
    updateSyncStatus('syncing', '正在上传到云端…');
  }
  try {
    const options = { cache: 'no-store', signal: controller.signal };
    if (sending) Object.assign(options, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: clipContent }),
    });
    const response = await fetch('/api/clipboard', options);
    if (!response.ok) throw new Error('服务器连接失败');
    const data = await response.json();
    if (typeof data.content !== 'string' || typeof data.updatedAt !== 'number' || !Number.isFinite(data.updatedAt)) {
      throw new Error('服务器返回无效数据');
    }
    if (sending) {
      clipServerTime = Math.max(clipServerTime, data.updatedAt);
      if (editVersion === clipEditVersion) clipDirty = false;
    }
    // 保护请求期间的新输入，并忽略 KV 传播过程中比已确认内容更旧的响应。
    if (!clipDirty && editVersion === clipEditVersion && data.updatedAt >= clipServerTime) {
      clipContent = data.content;
      clipServerTime = data.updatedAt;
      renderClipContent();
    }
    clipReady = true;
    setClipboardEnabled(true);
    lastSyncTime = Date.now();
    succeeded = true;
    updateSyncStatus(clipDirty ? 'syncing' : 'ready', clipDirty ? '等待上传到云端…' : '已连接云端，自动检查更新');
  } catch (e) {
    updateSyncStatus('error', clipDirty ? '同步失败，内容尚未上传，正在重试' : '云端连接失败，正在重试');
  } finally {
    clearTimeout(timeout);
    clipRequestRunning = false;
    updateClipMeta();
    scheduleClipSync(succeeded && clipDirty ? 1000 : 3000);
  }
}

function updateSyncStatus(state, text) {
  const indicator = _qs('#clipLiveIndicator');
  const statusText = _qs('#clipStatusText');
  const badge = _qs('#syncStatusBadge');
  const online = state === 'ready';
  indicator.className = `live-indicator ${online ? 'online' : ''}`;
  statusText.textContent = text;
  badge.textContent = online ? '● 云端共享' : state === 'error' ? '○ 同步失败' : '○ 连接 / 同步中';
  badge.style.color = online ? 'var(--success)' : state === 'error' ? 'var(--danger)' : 'var(--warning)';
  setCloudState('clipboard', state);
}

function renderMarkdownPreview() {
  const preview = _qs('#clipPreviewPanel');
  if (typeof marked !== 'undefined') {
    preview.innerHTML = marked.parse(clipContent || '*（暂无内容）*');
  } else {
    preview.textContent = clipContent;
  }
}

/* =====================================================================
   9. 二维码与当前站点地址
   ===================================================================== */
async function openQrModal(forClipboard = false) {
  const modal = _qs('#qrModal');
  const address = window.location.origin + (forClipboard ? '/#clipboard' : '');
  _qs('#qrAddressInput').value = address;
  // 使用 QR 码生成 API
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(address)}&bgcolor=ffffff&color=000000`;
  _qs('#qrCodeImage').src = qrUrl;
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
  _qs('#bgLayer').style.background = BG_THEMES[bgIndex];
  toast('背景已切换 🎨', 'info', 1500);
}

/* =====================================================================
   12. 事件绑定
   ===================================================================== */
function bindEvents() {
  const sitesMatrix = _qs('#sitesMatrix');
  const categoryFilterBar = _qs('#categoryFilterBar');
  sitesMatrix.addEventListener('pointerdown', startSiteDrag);
  categoryFilterBar.addEventListener('pointerdown', startCategoryDrag);
  sitesMatrix.addEventListener('dragstart', event => {
    if (event.target.closest('.site-card')) event.preventDefault();
  });
  document.addEventListener('pointermove', moveSiteDrag);
  document.addEventListener('pointermove', moveCategoryDrag);
  document.addEventListener('pointerup', event => finishSiteDrag(event, false));
  document.addEventListener('pointerup', event => finishCategoryDrag(event, false));
  document.addEventListener('pointercancel', event => finishSiteDrag(event, true));
  document.addEventListener('pointercancel', event => finishCategoryDrag(event, true));
  document.addEventListener('click', suppressDraggedSiteClick, true);
  document.addEventListener('click', suppressDraggedCategoryClick, true);

  // --- 搜索 ---
  const searchInput = _qs('#searchInput');
  const clearBtn = _qs('#searchClearBtn');

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

  _qs('#searchSubmitBtn').addEventListener('click', doSearch);

  // 引擎下拉
  _qs('#currentEngineBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    _qs('#engineMenu').classList.toggle('show');
  });

  document.addEventListener('click', () => _qs('#engineMenu').classList.remove('show'));

  _qsa('.engine-option').forEach(opt => {
    opt.addEventListener('click', () => {
      setEngine(opt.dataset.engine);
      _qs('#engineMenu').classList.remove('show');
    });
  });

  _qsa('.pill-item').forEach(pill => {
    pill.addEventListener('click', () => setEngine(pill.dataset.engine));
  });

  // --- Tab 切换 ---
  _qsa('.nav-tab[data-target]').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.target));
  });

  // --- 添加网站按钮 ---
  _qs('#openAddSiteBtn').addEventListener('click', () => openSiteModal());

  // --- 网站编辑弹窗 ---
  _qs('#closeSiteModalBtn').addEventListener('click', closeSiteModal);
  _qs('#cancelSiteModalBtn').addEventListener('click', closeSiteModal);
  _qs('#siteModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSiteModal(); });
  _qs('#siteForm').addEventListener('submit', saveSite);
  _qs('#btnAutoFetchIcon').addEventListener('click', () => autoFetchMetadata(true));
  _qs('#formSiteUrl').addEventListener('input', () => {
    cancelMetadataFetch();
    metadataUrl = '';
    _qs('#saveSiteBtn').disabled = true;
    metadataTimer = setTimeout(() => autoFetchMetadata(), 600);
  });
  _qs('#formSiteUrl').addEventListener('blur', () => {
    clearTimeout(metadataTimer);
    autoFetchMetadata();
  });
  _qs('#formSiteIcon').addEventListener('input', (e) => {
    updateIconPreview(e.target.value);
  });
  _qs('#btnAddNewCat').addEventListener('click', () => {
    const name = prompt('请输入新分类名称:');
    if (!name || !name.trim()) return;
    if (appData.categories.includes(name.trim())) { toast('分类已存在', 'warning'); return; }
    appData.categories.push(name.trim());
    saveData();
    renderCategoryOptions();
    renderCategoryBar();
    _qs('#formSiteCategory').value = name.trim();
    toast(`分类「${name}」已创建 ✅`, 'success');
  });
  _qs('#btnEditCat').addEventListener('click', () => renameCategory(_qs('#formSiteCategory').value));

  // --- Profile 编辑 (双击) ---
  _qs('#portalTitle').addEventListener('dblclick', () => {
    const val = prompt('请输入站点名称:', appData.profile.title);
    if (val && val.trim()) { appData.profile.title = val.trim(); saveData(); renderProfile(); }
  });
  _qs('#portalDesc').addEventListener('dblclick', () => {
    const val = prompt('请输入站点简介:', appData.profile.subtitle);
    if (val !== null) { appData.profile.subtitle = val; saveData(); renderProfile(); }
  });
  _qs('#avatarBox').addEventListener('click', () => {
    const val = prompt('请输入头像图片 URL:', appData.profile.avatar);
    if (val && val.trim()) { appData.profile.avatar = val.trim(); saveData(); renderProfile(); }
  });

  // --- 最近访问 ---
  _qs('#clearRecentBtn').addEventListener('click', () => {
    localStorage.removeItem(RECENT_KEY);
    renderRecent();
    toast('最近访问记录已清空', 'info');
  });

  // --- 顶栏按钮 ---
  _qs('#changeBgBtn').addEventListener('click', cycleBg);
  _qs('#dataManageBtn').addEventListener('click', () => {
    updateDataStats();
    _qs('#dataModal').classList.add('open');
  });
  _qs('#qrShareBtn').addEventListener('click', () => openQrModal(false));

  // --- 数据管理弹窗 ---
  _qs('#closeDataModalBtn').addEventListener('click', () => { if (!importingData) _qs('#dataModal').classList.remove('open'); });
  _qs('#dataModal').addEventListener('click', (e) => { if (!importingData && e.target === e.currentTarget) _qs('#dataModal').classList.remove('open'); });
  _qs('#btnExportData').addEventListener('click', exportData);
  _qs('#importFileInput').addEventListener('change', (e) => importData(e.target.files[0]));
  _qs('#btnRestoreBackup').addEventListener('click', restoreBackup);
  _qs('#btnResetDefault').addEventListener('click', resetDefault);

  // --- 粘贴板主面板 ---
  _qs('#clipTextarea').addEventListener('input', (e) => onClipInput(e.target.value));
  
  _qs('#btnModeEdit').addEventListener('click', () => {
    isPreviewMode = false;
    _qs('#clipTextarea').style.display = '';
    _qs('#clipPreviewPanel').style.display = 'none';
    _qs('#btnModeEdit').classList.add('active');
    _qs('#btnModePreview').classList.remove('active');
  });

  _qs('#btnModePreview').addEventListener('click', () => {
    isPreviewMode = true;
    _qs('#clipTextarea').style.display = 'none';
    _qs('#clipPreviewPanel').style.display = '';
    _qs('#btnModeEdit').classList.remove('active');
    _qs('#btnModePreview').classList.add('active');
    renderMarkdownPreview();
  });

  _qs('#btnCopyAll').addEventListener('click', function() {
    copyTextCompat(clipContent, '全文已复制到剪贴板 ✅', '复制失败，请手动选中复制');
  });

  _qs('#btnPasteFromSys').addEventListener('click', function() {
    // 兼容旧iOS: 优先用 Clipboard API，否则提示手动粘贴
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(text) {
        var newContent = clipContent ? clipContent + '\n' + text : text;
        _qs('#clipTextarea').value = newContent;
        _qs('#drawerTextarea').value = newContent;
        onClipInput(newContent);
        toast('已从系统剪贴板粘贴 📋', 'success');
      }).catch(function() {
        toast('请直接在文本框中长按粘贴', 'warning');
      });
    } else {
      toast('请直接在文本框中长按粘贴', 'warning');
    }
  });

  _qs('#btnClearClip').addEventListener('click', function() {
    if (!clipContent) return;
    if (!confirm('确定要清空全部粘贴板内容吗？')) return;
    _qs('#clipTextarea').value = '';
    _qs('#drawerTextarea').value = '';
    onClipInput('');
    toast('粘贴板已清空', 'info');
  });

  _qs('#clipQrBtn').addEventListener('click', function() { openQrModal(true); });

  // --- 右侧抽屉快捷便签板 ---
  _qs('#openDrawerCapsule').addEventListener('click', function() { _qs('#quickDrawer').classList.add('open'); });
  _qs('#closeDrawerBtn').addEventListener('click', function() { _qs('#quickDrawer').classList.remove('open'); });
  _qs('#drawerTextarea').addEventListener('input', function(e) {
    _qs('#clipTextarea').value = e.target.value;
    onClipInput(e.target.value);
  });
  _qs('#drawerCopyBtn').addEventListener('click', function() {
    copyTextCompat(clipContent, '便签内容已复制 ✅', '复制失败');
  });

  // --- 扫码 QR 弹窗 ---
  _qs('#closeQrModalBtn').addEventListener('click', function() { _qs('#qrModal').classList.remove('open'); });
  _qs('#qrModal').addEventListener('click', function(e) { if (e.target === e.currentTarget) _qs('#qrModal').classList.remove('open'); });
  _qs('#btnCopyAddress').addEventListener('click', function() {
    copyTextCompat(_qs('#qrAddressInput').value, '地址已复制 ✅', '复制失败');
  });

  // URL hash 路由切换
  if (window.location.hash === '#clipboard') switchTab('tab-clipboard');
}

/* =====================================================================
   13. 应用启动入口
   ===================================================================== */
async function main() {
  detectFlexGap();
  await initData();
  initClipboard();
  renderAll();
  bindEvents();
  setEngine('local');
  // 每分钟更新"上次同步"显示
  setInterval(updateClipMeta, 60000);
}

document.addEventListener('DOMContentLoaded', main);

})(); // end IIFE
