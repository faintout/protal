/**
 * 极光导航 - Cloudflare Worker 入口
 * 
 * 部署说明:
 *  1. 安装 Wrangler: npm install -g wrangler
 *  2. 登录: wrangler login
 *  3. 创建 KV 命名空间: wrangler kv:namespace create "AURORA_KV"
 *  4. 将下方 wrangler.toml 中的 kv_namespaces id 替换为上方命令输出的 ID
 *  5. 部署: wrangler deploy
 * 
 * 特性:
 *  - 静态资源内嵌于 Worker（无需额外 Pages/R2）
 *  - KV 存储: 站点数据 + 粘贴板内容（全球边缘持久化）
 *  - 粘贴板通过 HTTP 轮询同步；KV 跨地区更新可能有延迟
 */

// ===================== KV 键常量 =====================
const KV_SITES    = 'aurora:sites';
const KV_CLIP     = 'aurora:clipboard';
const KV_CLIP_STATE = 'aurora:clipboard-state';

// ===================== CORS 响应头 =====================
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Shared URL validation and metadata parsing, embedded by build.js.
// Shared by the local server and the bundled Cloudflare Worker.
const METADATA_MAX_BYTES = 512 * 1024;

function metadataError(message, status) {
  const error = new Error(message);
  error.status = status || 502;
  return error;
}

function isPublicAddress(address) {
  address = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (address.indexOf(':') !== -1) {
    try { address = new URL('http://[' + address + ']').hostname.slice(1, -1); }
    catch (error) { return false; }
    // Global unicast only; exclude transition and documentation ranges.
    return /^[23][0-9a-f]{3}:/.test(address) &&
      !/^2001:(?::|0:|2:|db8:|[12][0-9a-f]:)/.test(address) && !/^2002:/.test(address);
  }
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 ||
      (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function metadataUrl(value, base) {
  let url;
  try { url = base ? new URL(value, base) : new URL(value); }
  catch (error) { throw metadataError('请输入有效的网址', 400); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
    (host.indexOf(':') !== -1 || /^[\d.]+$/.test(host) ? !isPublicAddress(host) :
      host.indexOf('.') === -1 || /\.(?:localhost|local|internal|lan|home|test|invalid|onion)$/.test(host))) {
    throw metadataError('仅支持公开网站的 HTTP 或 HTTPS 地址', 400);
  }
  url.hash = '';
  return url;
}

function decodeMetadataText(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…' };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()] || match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function parseSiteMetadata(html, address) {
  const url = metadataUrl(address);
  const source = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = titleMatch ? decodeMetadataText(titleMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  let base = url.href;
  let icon = '';
  let touchIcon = '';
  let hasBase = false;
  const links = [];
  const tags = source.match(/<(?:base|link)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || [];
  tags.forEach(tag => {
    const attrs = {};
    tag.replace(/([^\s"'<>\/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
      (match, name, doubleQuoted, singleQuoted, unquoted) => {
        attrs[name.toLowerCase()] = decodeMetadataText(doubleQuoted !== undefined ? doubleQuoted : singleQuoted !== undefined ? singleQuoted : unquoted);
        return match;
      });
    if (/^<base\b/i.test(tag) && !hasBase && attrs.href) {
      hasBase = true;
      try { base = metadataUrl(attrs.href, url).href; } catch (error) { /* Ignore unsafe bases. */ }
    } else if (/^<link\b/i.test(tag) && attrs.href) links.push(attrs);
  });
  links.forEach(attrs => {
    const rel = (attrs.rel || '').toLowerCase().split(/\s+/);
    try {
      const href = metadataUrl(attrs.href, base).href;
      if (!icon && rel.indexOf('icon') !== -1) icon = href;
      if (!touchIcon && rel.indexOf('apple-touch-icon') !== -1) touchIcon = href;
    } catch (error) { /* Ignore non-HTTP icons. */ }
  });
  return { title, icon: icon || touchIcon || url.origin + '/favicon.ico', url: url.href };
}

async function fetchSiteMetadata(address, requestPage) {
  let url = metadataUrl(address);
  const deadline = Date.now() + 8000;
  for (let redirects = 0; redirects <= 4; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw metadataError('获取网站信息超时', 504);
    const page = await requestPage(url, remaining);
    if ([301, 302, 303, 307, 308].indexOf(page.status) !== -1) {
      if (!page.location || redirects === 4) throw metadataError('网站重定向过多或无效');
      url = metadataUrl(page.location, url);
      continue;
    }
    if (page.status < 200 || page.status >= 300) throw metadataError('网站暂时无法访问');
    if (page.contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType)) {
      throw metadataError('该网址未返回网页内容');
    }
    return parseSiteMetadata(page.html, url);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { METADATA_MAX_BYTES, metadataError, isPublicAddress, metadataUrl, parseSiteMetadata, fetchSiteMetadata };
}


async function requestMetadataPage(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname.indexOf(':') === -1 && !/^[\d.]+$/.test(hostname)) {
      // Workers do not expose DNS lookup. Check both address families through DoH;
      // Cloudflare's outbound fetch also rejects private-network destinations.
      const answers = await Promise.all(['A', 'AAAA'].map(async type => {
        const response = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(hostname) + '&type=' + type,
          { headers: { Accept: 'application/dns-json' }, signal: controller.signal });
        if (!response.ok) throw metadataError('无法解析网站地址');
        const data = await response.json();
        return (data.Answer || []).filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data);
      }));
      const addresses = answers[0].concat(answers[1]);
      if (!addresses.length || addresses.some(address => !isPublicAddress(address))) {
        throw metadataError('仅支持公开网站的 HTTP 或 HTTPS 地址', 400);
      }
    }
    const response = await fetch(url.href, {
      redirect: 'manual', signal: controller.signal,
      headers: { Accept: 'text/html, application/xhtml+xml', 'User-Agent': 'AuroraPortal/1.0' },
    });
    const page = { status: response.status, location: response.headers.get('location'),
      contentType: response.headers.get('content-type') || '', html: '' };
    if (page.status < 200 || page.status >= 300 ||
      (page.contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType))) {
      if (response.body) await response.body.cancel();
      return page;
    }
    if (!response.body) return page;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    try {
      while (size < METADATA_MAX_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const bytes = chunk.value.slice(0, METADATA_MAX_BYTES - size);
        page.html += decoder.decode(bytes, { stream: true });
        size += bytes.length;
      }
      page.html += decoder.decode();
    } finally { await reader.cancel(); }
    return page;
  } catch (error) {
    if (controller.signal.aborted) throw metadataError('获取网站信息超时', 504);
    throw error;
  } finally { clearTimeout(timer); }
}

// ===================== 工具函数 =====================
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

function htmlResp(html) {
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function cssResp(css) {
  return new Response(css, {
    status: 200,
    headers: { 'Content-Type': 'text/css; charset=utf-8' },
  });
}

function jsResp(js) {
  return new Response(js, {
    status: 200,
    headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
  });
}

// ===================== 主处理器 =====================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    // CORS 预检
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ---- API: 网站标题与图标 ----
    if (pathname === '/api/site-metadata' && method === 'GET') {
      try {
        return jsonResp(await fetchSiteMetadata(url.searchParams.get('url'), requestMetadataPage));
      } catch (error) {
        return jsonResp({ error: error.status ? error.message : '无法获取网站信息，请手动填写' }, error.status || 502);
      }
    }

    // ---- API: 站点数据 ----
    if (pathname === '/api/sites') {
      if (method === 'GET') {
        try {
          const data = await env.AURORA_KV.get(KV_SITES);
          if (data) return jsonResp(JSON.parse(data));
          // 首次访问，读取内嵌默认数据
          return jsonResp(DEFAULT_DATA);
        } catch { return jsonResp({ error: '云端存储暂不可用，请稍后重试' }, 503); }
      }

      if (method === 'POST') {
        let body;
        try { body = await request.json(); }
        catch { return jsonResp({ error: '请求必须是有效 JSON' }, 400); }
        try {
          await env.AURORA_KV.put(KV_SITES, JSON.stringify(body));
          return jsonResp({ ok: true });
        } catch { return jsonResp({ error: '云端存储暂不可用，请稍后重试' }, 503); }
      }
    }

    // ---- API: 粘贴板获取 ----
    if (pathname === '/api/clipboard' && method === 'GET') {
      try {
        const saved = await env.AURORA_KV.get(KV_CLIP_STATE);
        if (saved !== null) {
          const state = JSON.parse(saved);
          if (!state || typeof state.content !== 'string' || !Number.isFinite(state.updatedAt) || state.updatedAt < 0) {
            throw new Error('Invalid clipboard state');
          }
          return jsonResp({ content: state.content, updatedAt: state.updatedAt });
        }
        // 旧键保存的是任意文本，不能将看似 JSON 的旧内容当作状态解析。
        const content = (await env.AURORA_KV.get(KV_CLIP)) || '';
        return jsonResp({ content, updatedAt: 0 });
      } catch { return jsonResp({ error: '云端粘贴板暂不可用，请稍后重试' }, 503); }
    }

    // ---- API: 粘贴板更新 ----
    if (pathname === '/api/clipboard' && method === 'POST') {
      let body;
      try { body = await request.json(); }
      catch { return jsonResp({ error: '请求必须是有效 JSON' }, 400); }
      if (!body || typeof body.content !== 'string') return jsonResp({ error: 'content 必须是字符串' }, 400);
      try {
        const state = { content: body.content, updatedAt: Date.now() };
        await env.AURORA_KV.put(KV_CLIP_STATE, JSON.stringify(state));
        return jsonResp(state);
      } catch { return jsonResp({ error: '云端粘贴板暂不可用，请稍后重试' }, 503); }
    }

    if (pathname.startsWith('/api/')) return jsonResp({ error: 'Not Found' }, 404);

    // ---- 静态资源路由 ----
    if (pathname === '/css/style.css') return cssResp(CSS_CONTENT);
    if (pathname === '/js/app.js') return jsResp(JS_CONTENT);

    // 默认: 返回 index.html (SPA fallback)
    return htmlResp(HTML_CONTENT);
  },
};

// ============================================================
// 内嵌静态资源（Cloudflare Worker 不依赖文件系统）
// 构建时由 build 脚本自动注入实际内容
// ============================================================

// 内嵌 HTML（由构建脚本替换）
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>极光导航 - 聚合导航与多端共享粘贴板</title>
  <meta name="description" content="高颜值个人网站导航门户，支持自定义编辑网站、名称与多端实时共享粘贴板。">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>✨</text></svg>">
  <link rel="stylesheet" href="/css/style.css">
  <!-- 引入轻量 Markdown 解析器 -->
  <script src="https://cdn.jsdelivr.net/npm/marked@4.3.0/marked.min.js" defer></script>
</head>
<body class="theme-glass">
  <!-- 背景特效层 -->
  <div class="bg-layer" id="bgLayer"></div>
  <div class="bg-overlay"></div>

  <!-- 顶部控制条 -->
  <header class="top-nav-bar">
    <div class="brand-badge">
      <span class="pulse-dot"></span>
      <span class="brand-text">Aurora Portal</span>
      <!-- 云端连接状态 -->
      <span class="kv-sync-badge" id="kvSyncBadge">
        <span class="kv-dot" id="kvSyncIndicator"></span>
        <span class="kv-label" id="kvSyncLabel" role="status">连接中…</span>
      </span>
    </div>
    <div class="top-actions">
      <!-- 云端站点扫码互联 -->
      <button class="icon-btn" id="qrShareBtn" title="跨设备扫码同步">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><path d="M7 7h.01M17 7h.01M7 17h.01M17 17h.01"></path></svg>
        <span class="btn-text">扫码互联</span>
      </button>
      <!-- 换壁纸 -->
      <button class="icon-btn" id="changeBgBtn" title="切换背景">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
      </button>
      <!-- 数据备份 -->
      <button class="icon-btn" id="dataManageBtn" title="网址导入导出与备份" aria-label="网址导入导出与备份">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>
        <span>备份</span>
      </button>
    </div>
  </header>

  <div class="main-wrapper">
    <!-- ===================== 顶部 Hero 区域 ===================== -->
    <section class="hero-section">
      <div class="profile-card">
        <div class="avatar-box" id="avatarBox" title="点击更换头像URL">
          <img id="userAvatar" src="https://api.dicebear.com/7.x/bottts/svg?seed=portal&backgroundColor=6366f1" alt="Avatar">
          <span class="avatar-edit-tag">✎</span>
        </div>
        <div class="profile-meta">
          <h1 class="portal-title" id="portalTitle" title="双击编辑标题">极光导航</h1>
          <p class="portal-desc" id="portalDesc" title="双击编辑简介">上网，从这开始！</p>
        </div>
      </div>

      <!-- ===================== 多引擎聚合搜索 ===================== -->
      <div class="search-box-card">
        <div class="search-bar">
          <div class="engine-dropdown-wrap">
            <button class="engine-current-btn" id="currentEngineBtn">
              <span id="currentEngineIcon" class="engine-icon">⚡</span>
              <span id="currentEngineText">站内</span>
              <span class="arrow-down">▾</span>
            </button>
            <div class="engine-menu" id="engineMenu">
              <div class="engine-option active" data-engine="local">
                <span class="engine-icon">⚡</span>
                <span class="name">站内搜索</span>
              </div>
              <div class="engine-option" data-engine="baidu">
                <span class="engine-icon">🐾</span>
                <span class="name">百度</span>
              </div>
              <div class="engine-option" data-engine="bing">
                <span class="engine-icon">💠</span>
                <span class="name">微软必应</span>
              </div>
              <div class="engine-option" data-engine="google">
                <span class="engine-icon">🌐</span>
                <span class="name">谷歌 Google</span>
              </div>
              <div class="engine-option" data-engine="bilibili">
                <span class="engine-icon">📺</span>
                <span class="name">哔哩哔哩</span>
              </div>
              <div class="engine-option" data-engine="github">
                <span class="engine-icon">🐙</span>
                <span class="name">GitHub</span>
              </div>
              <div class="engine-option" data-engine="zhihu">
                <span class="engine-icon">💡</span>
                <span class="name">知乎</span>
              </div>
            </div>
          </div>

          <input type="text" id="searchInput" class="search-input" placeholder="输入关键字搜索站内网址或直接回车..." autocomplete="off">
          
          <button class="search-clear-btn" id="searchClearBtn" title="清空" style="display:none;">✕</button>
          
          <button class="search-submit-btn" id="searchSubmitBtn" aria-label="搜索">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          </button>
        </div>

        <!-- PC端快捷引擎气泡药丸 -->
        <div class="engine-pills" id="enginePills">
          <span class="pill-item active" data-engine="local">⚡ 站内</span>
          <span class="pill-item" data-engine="baidu">🐾 百度</span>
          <span class="pill-item" data-engine="bing">💠 必应</span>
          <span class="pill-item" data-engine="google">🌐 谷歌</span>
          <span class="pill-item" data-engine="bilibili">📺 B站</span>
          <span class="pill-item" data-engine="github">🐙 GitHub</span>
          <span class="pill-item" data-engine="zhihu">💡 知乎</span>
        </div>
      </div>

      <!-- ===================== 主功能导航 Tab ===================== -->
      <nav class="nav-tabs-container">
        <button class="nav-tab active" data-target="tab-sites">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
          <span>网址导航</span>
        </button>
        <button class="nav-tab" data-target="tab-clipboard">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
          <span>共享粘贴板</span>
          <span class="badge-live" id="syncStatusBadge">○ 连接中</span>
        </button>
        <button class="nav-tab btn-highlight" id="openAddSiteBtn">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>添加网站</span>
        </button>
      </nav>
    </section>

    <!-- ===================== 内容主面板 1: 网址导航 ===================== -->
    <main class="tab-panel active" id="tab-sites">
      <!-- 分类快捷标签栏 -->
      <div class="category-filter-bar" id="categoryFilterBar">
        <button class="cat-pill active" data-all="true">全部</button>
        <!-- 动态生成各个分类标签 -->
      </div>

      <!-- 最近访问 -->
      <section class="section-container" id="recentSection" style="display: none;">
        <div class="section-header">
          <h2 class="section-title"><span class="icon">📌</span> 最近访问</h2>
          <div class="section-actions">
            <button class="btn-text-sm" id="clearRecentBtn">清空历史</button>
          </div>
        </div>
        <div class="sites-grid" id="recentGrid"></div>
      </section>

      <!-- 网址分类主矩阵 -->
      <div id="sitesMatrix">
        <!-- 动态填充各分类网格 -->
      </div>
    </main>

    <!-- ===================== 内容主面板 2: 共享粘贴板 ===================== -->
    <main class="tab-panel" id="tab-clipboard">
      <div class="clipboard-card glass-panel">
        <div class="clipboard-top-bar">
          <div class="clipboard-status-info">
            <span class="live-indicator" id="clipLiveIndicator"></span>
            <span class="status-text" id="clipStatusText" role="status">正在连接云端粘贴板…</span>
            <span class="sep">|</span>
            <span class="meta-item" id="clipWordsMeta">字数: 0</span>
            <span class="meta-item" id="clipLinesMeta">行数: 1</span>
            <span class="sep">|</span>
            <span class="meta-item" id="clipTimeMeta">尚未连接</span>
          </div>

          <div class="clipboard-actions">
            <!-- 模式切换: 编辑 / Markdown 预览 -->
            <div class="view-toggle-group">
              <button class="toggle-btn active" id="btnModeEdit">编辑模式</button>
              <button class="toggle-btn" id="btnModePreview">Markdown 预览</button>
            </div>
            <button class="btn-secondary" id="btnPasteFromSys" title="从本机剪贴板快速填入">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
              <span>快速粘贴</span>
            </button>
            <button class="btn-primary" id="btnCopyAll" title="一键复制全文">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span>一键复制</span>
            </button>
            <button class="btn-danger-outline" id="btnClearClip" title="清空全部内容">清空</button>
          </div>
        </div>

        <div class="clipboard-editor-body">
          <!-- 实时编辑区域 -->
          <textarea id="clipTextarea" class="clip-textarea" disabled placeholder="在此输入或粘贴内容，联网后自动上传；其他设备打开同一网址即可共享。"></textarea>
          
          <!-- Markdown 预览展示面板 -->
          <div id="clipPreviewPanel" class="clip-preview markdown-body" style="display: none;"></div>
        </div>

        <div class="clipboard-footer-tips">
          <div class="tip-left">
            <span class="badge-tip">💡 协同说明</span>
            <span>内容通过服务器共享，每 3 秒检查更新。请确认上传成功后再关闭页面；网络异常时会自动重试。</span>
          </div>
          <button class="link-btn" id="clipQrBtn">📱 手机扫码直达本粘贴板</button>
        </div>
      </div>
    </main>
  </div>

  <!-- ===================== 右侧悬浮快捷抽屉组件: 便捷粘贴板 ===================== -->
  <aside class="drawer-panel" id="quickDrawer">
    <div class="drawer-header">
      <div class="drawer-title">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
        <span>云端共享粘贴板</span>
      </div>
      <button class="drawer-close" id="closeDrawerBtn">✕</button>
    </div>
    <div class="drawer-body">
      <textarea id="drawerTextarea" class="drawer-textarea" disabled placeholder="内容通过云端与其他设备共享，上传状态显示在页面左上角。"></textarea>
    </div>
    <div class="drawer-footer">
      <button class="btn-primary w-full" id="drawerCopyBtn">一键复制便签内容</button>
    </div>
  </aside>

  <!-- 浮动呼出按钮 -->
  <div class="floating-capsule" id="openDrawerCapsule" title="呼出共享便签板">
    <span class="capsule-icon">📋</span>
    <span class="capsule-text">便签板</span>
  </div>

  <!-- ===================== 弹窗 1: 网站添加 / 编辑弹窗 ===================== -->
  <div class="modal-overlay" id="siteModal">
    <div class="modal-dialog glass-panel">
      <div class="modal-header">
        <h3 class="modal-title" id="siteModalTitle">添加新网站</h3>
        <button class="modal-close" id="closeSiteModalBtn">✕</button>
      </div>
      <form id="siteForm" class="modal-form">
        <input type="hidden" id="editSiteId">
        
        <div class="form-group">
          <label for="formSiteUrl">网站链接 (URL) <span class="req">*</span></label>
          <div class="input-with-action">
            <input type="url" id="formSiteUrl" placeholder="https://example.com" required autocomplete="off">
            <button type="button" class="btn-sm" id="btnAutoFetchIcon">获取名称和图标</button>
          </div>
          <small class="form-hint" id="siteMetadataStatus" role="status" aria-live="polite">输入网址后自动获取名称和图标，也可手动修改。</small>
        </div>

        <div class="form-group">
          <label for="formSiteName">网站名称 <span class="req">*</span></label>
          <input type="text" id="formSiteName" placeholder="自动获取网站标题，也可手动填写" required autocomplete="off">
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label for="formSiteCategory">网站分类 <span class="req">*</span></label>
            <div class="cat-select-wrap">
              <select id="formSiteCategory" required></select>
              <button type="button" class="btn-icon-addon" id="btnAddNewCat" title="新增分类">+</button>
              <button type="button" class="btn-icon-addon" id="btnEditCat" title="编辑当前标签名称" aria-label="编辑当前标签名称">✎</button>
            </div>
          </div>
          <div class="form-group flex-1">
            <label for="formSiteIcon">图标地址 (可选)</label>
            <div class="icon-preview-row">
              <div class="icon-avatar-preview" id="iconPreviewBox">
                <img id="formIconPreview" src="" alt="ico" onerror="this.style.display='none'">
                <span id="formIconPlaceholder">🌐</span>
              </div>
              <input type="text" id="formSiteIcon" placeholder="https://.../favicon.ico" autocomplete="off">
            </div>
          </div>
        </div>

        <div class="form-group">
          <label for="formSiteDesc">网站简介与描述</label>
          <input type="text" id="formSiteDesc" placeholder="一句话描述，鼠标悬浮在卡片上时显示" autocomplete="off">
        </div>

        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="cancelSiteModalBtn">取消</button>
          <button type="submit" class="btn-primary" id="saveSiteBtn">保存网站</button>
        </div>
      </form>
    </div>
  </div>

  <!-- ===================== 弹窗 2: 数据管理 / 导入导出 / 备份 ===================== -->
  <div class="modal-overlay" id="dataModal">
    <div class="modal-dialog glass-panel">
      <div class="modal-header">
        <h3 class="modal-title">网址导入导出与备份</h3>
        <button class="modal-close" id="closeDataModalBtn">✕</button>
      </div>
      <div class="modal-body data-manage-body">
        <div class="data-stat-card">
          <div class="stat-item">
            <span class="stat-val" id="statSitesCount">0</span>
            <span class="stat-label">收录网址数</span>
          </div>
          <div class="stat-item">
            <span class="stat-val" id="statCatsCount">0</span>
            <span class="stat-label">分类数目</span>
          </div>
          <div class="stat-item">
            <span class="stat-val" id="statStorageType">服务器</span>
            <span class="stat-label">持久化模式</span>
          </div>
        </div>

        <div class="data-btn-grid">
          <button class="action-card-btn" id="btnExportData">
            <span class="btn-icon">💾</span>
            <div class="btn-info">
              <strong>导出网址备份 (JSON)</strong>
              <span>保存网址、名称、图标、分类及个人配置</span>
            </div>
          </button>

          <label class="action-card-btn" for="importFileInput">
            <span class="btn-icon">📥</span>
            <div class="btn-info">
              <strong>导入网址备份 (JSON)</strong>
              <span>覆盖前自动保存本浏览器的原数据，最大 5 MB</span>
            </div>
            <input type="file" id="importFileInput" accept=".json,application/json" style="display:none;">
          </label>

          <button class="action-card-btn" id="btnRestoreBackup" disabled>
            <span class="btn-icon">↩</span>
            <div class="btn-info">
              <strong>恢复导入前备份</strong>
              <span>恢复本浏览器上一次导入前保存的数据</span>
            </div>
          </button>

          <button class="action-card-btn danger" id="btnResetDefault">
            <span class="btn-icon">🔄</span>
            <div class="btn-info">
              <strong>恢复系统初始预置</strong>
              <span>重置为精选预置的优质导航站</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- ===================== 弹窗 3: 扫码互联模态框 ===================== -->
  <div class="modal-overlay" id="qrModal">
    <div class="modal-dialog glass-panel qr-dialog">
      <div class="modal-header">
        <h3 class="modal-title">手机/跨设备扫码同步</h3>
        <button class="modal-close" id="closeQrModalBtn">✕</button>
      </div>
      <div class="modal-body qr-modal-body">
        <div class="qr-canvas-box" id="qrCanvasBox">
          <img id="qrCodeImage" src="" alt="二维码">
        </div>
        <div class="qr-address-info">
          <p class="qr-hint">其他设备联网后扫描二维码，打开同一网站即可共享。请使用已部署的公网地址：</p>
          <div class="address-copy-bar">
            <input type="text" id="qrAddressInput" readonly>
            <button class="btn-sm" id="btnCopyAddress">复制地址</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 轻量全局通知浮层 -->
  <div class="toast-container" id="toastContainer"></div>

  <!-- 应用交互脚本 -->
  <script src="/js/app.js"></script>
</body>
</html>
`;

// 内嵌 CSS（由构建脚本替换）
const CSS_CONTENT = `/* ============================================================
   极光导航 (Aurora Portal) 现代轻奢毛玻璃主题样式
   ============================================================ */

:root {
  --primary: #6366f1;
  --primary-hover: #4f46e5;
  --primary-light: rgba(99, 102, 241, 0.15);
  --primary-glow: rgba(99, 102, 241, 0.4);
  
  --bg-dark: #0b0f19;
  --bg-gradient: radial-gradient(circle at 15% 15%, rgba(99, 102, 241, 0.18), transparent 45%),
                 radial-gradient(circle at 85% 80%, rgba(236, 72, 153, 0.15), transparent 40%),
                 radial-gradient(circle at 50% 50%, rgba(14, 165, 233, 0.12), transparent 50%),
                 #0b0f19;

  --glass-bg: rgba(22, 27, 46, 0.65);
  --glass-card: rgba(30, 41, 59, 0.55);
  --glass-card-hover: rgba(51, 65, 85, 0.75);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-border-focus: rgba(99, 102, 241, 0.5);

  --text-main: #f8fafc;
  --text-muted: #94a3b8;
  --text-sub: #64748b;
  
  --success: #10b981;
  --warning: #f59e0b;
  --danger: #ef4444;

  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --radius-full: 9999px;

  --shadow-sm: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
  --shadow-md: 0 10px 25px -3px rgba(0, 0, 0, 0.35);
  --shadow-lg: 0 20px 35px -5px rgba(0, 0, 0, 0.5);
  --shadow-glow: 0 0 25px var(--primary-glow);

  --transition-fast: 0.18s ease;
  --transition-normal: 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  background-color: var(--bg-dark);
  color: var(--text-main);
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
  line-height: 1.5;
}

/* 全屏动态星空与渐变背景层 */
.bg-layer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: var(--bg-gradient);
  background-size: cover;
  background-attachment: fixed;
  z-index: -2;
  transition: opacity 0.5s ease;
}

.bg-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: radial-gradient(ellipse at center, transparent 0%, rgba(11, 15, 25, 0.7) 100%);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: -1;
  pointer-events: none;
}

/* ================= 顶部控制导航 ================= */
.top-nav-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 28px;
  background: rgba(15, 23, 42, 0.4);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-bottom: 1px solid var(--glass-border);
  position: sticky;
  top: 0;
  z-index: 100;
}

.brand-badge {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #e2e8f0;
}

.pulse-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 10px var(--success);
  animation: pulse-ring 2s infinite ease-out;
}

@keyframes pulse-ring {
  0% { transform: scale(0.95); opacity: 0.8; }
  50% { transform: scale(1.2); opacity: 1; }
  100% { transform: scale(0.95); opacity: 0.8; }
}

/* KV 同步状态徽章 */
.kv-sync-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-border);
  padding: 2px 10px 2px 8px;
  border-radius: var(--radius-full);
  font-size: 11px;
  color: var(--text-sub);
  margin-left: 6px;
}

.kv-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-sub);
  transition: background 0.4s;
  flex-shrink: 0;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-border);
  color: var(--text-muted);
  padding: 6px 12px;
  border-radius: var(--radius-full);
  cursor: pointer;
  font-size: 13px;
  transition: var(--transition-fast);
  white-space: nowrap;
}

.icon-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-main);
  border-color: rgba(255, 255, 255, 0.2);
}

/* ================= 布局主容器 ================= */
.main-wrapper {
  max-width: 1260px;
  margin: 0 auto;
  padding: 24px 20px 80px;
}

/* ================= Hero 区域 ================= */
.hero-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 30px;
}

.profile-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 22px;
  text-align: center;
}

.avatar-box {
  width: 82px;
  height: 82px;
  border-radius: 50%;
  overflow: hidden;
  border: 3px solid rgba(255, 255, 255, 0.2);
  box-shadow: var(--shadow-glow);
  position: relative;
  cursor: pointer;
  transition: transform 0.3s ease, border-color 0.3s ease;
  background: #1e293b;
}

.avatar-box:hover {
  transform: scale(1.06);
  border-color: var(--primary);
}

.avatar-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-edit-tag {
  position: absolute;
  bottom: 0;
  right: 0;
  left: 0;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
  padding: 2px 0;
  opacity: 0;
  transition: opacity 0.2s;
}

.avatar-box:hover .avatar-edit-tag {
  opacity: 1;
}

.portal-title {
  margin-top: 12px;
  font-size: 28px;
  font-weight: 800;
  letter-spacing: 0.5px;
  background: linear-gradient(135deg, #ffffff 40%, #a5b4fc 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  cursor: pointer;
}

.portal-desc {
  margin-top: 4px;
  font-size: 14px;
  color: var(--text-muted);
  cursor: pointer;
}

/* ================= 搜索框 ================= */
.search-box-card {
  width: 100%;
  max-width: 680px;
  margin-bottom: 24px;
}

.search-bar {
  display: flex;
  align-items: center;
  background: rgba(30, 41, 59, 0.7);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-full);
  padding: 6px 10px;
  box-shadow: var(--shadow-md);
  transition: var(--transition-normal);
}

.search-bar:focus-within {
  border-color: var(--primary);
  box-shadow: var(--shadow-glow);
  background: rgba(30, 41, 59, 0.9);
}

.engine-dropdown-wrap {
  position: relative;
  flex-shrink: 0;
}

.engine-current-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.08);
  border: none;
  color: var(--text-main);
  padding: 8px 14px;
  border-radius: var(--radius-full);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition-fast);
  white-space: nowrap;
}

.engine-current-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.arrow-down {
  font-size: 10px;
  color: var(--text-muted);
}

.engine-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  background: #1e293b;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 6px;
  min-width: 140px;
  display: none;
  flex-direction: column;
  z-index: 50;
}

.engine-menu.show {
  display: flex;
}

.engine-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-muted);
  transition: var(--transition-fast);
}

.engine-option:hover, .engine-option.active {
  background: rgba(99, 102, 241, 0.18);
  color: var(--text-main);
}

.search-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  padding: 10px 16px;
  font-size: 15px;
  color: var(--text-main);
}

.search-input::placeholder {
  color: var(--text-sub);
}

.search-clear-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 4px 8px;
  cursor: pointer;
  font-size: 14px;
}

.search-submit-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--primary);
  border: none;
  color: #fff;
  cursor: pointer;
  transition: transform 0.2s, background 0.2s;
  margin-left: 4px;
}

.search-submit-btn:hover {
  background: var(--primary-hover);
  transform: scale(1.06);
}

/* PC 端药丸标签 */
.engine-pills {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.pill-item {
  font-size: 12px;
  padding: 4px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  color: var(--text-muted);
  cursor: pointer;
  transition: var(--transition-fast);
}

.pill-item:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-main);
}

.pill-item.active {
  background: var(--primary-light);
  color: #c7d2fe;
  border-color: var(--primary);
  font-weight: 600;
}

/* ================= 顶栏 Tab 栏 ================= */
.nav-tabs-container {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.nav-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 22px;
  border-radius: var(--radius-full);
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid var(--glass-border);
  color: var(--text-muted);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition-normal);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}

.nav-tab:hover {
  background: rgba(51, 65, 85, 0.7);
  color: var(--text-main);
  transform: translateY(-1px);
}

.nav-tab.active {
  background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(79, 70, 229, 0.35));
  border-color: var(--primary);
  color: #fff;
  box-shadow: 0 4px 15px rgba(99, 102, 241, 0.25);
}

.nav-tab.btn-highlight {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.nav-tab.btn-highlight:hover {
  background: var(--primary-hover);
  box-shadow: var(--shadow-glow);
}

.badge-live {
  font-size: 11px;
  color: var(--success);
  background: rgba(16, 185, 129, 0.15);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  margin-left: 4px;
}

/* ================= 面板切换 ================= */
.tab-panel {
  display: none;
  animation: fadeIn 0.3s ease;
}

.tab-panel.active {
  display: block;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ================= 分类过滤胶囊 ================= */
.category-filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow-x: auto;
  padding: 10px 0 18px;
  margin-bottom: 12px;
  scrollbar-width: none;
}

.category-filter-bar::-webkit-scrollbar {
  display: none;
}

.cat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  padding: 6px 18px;
  border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--glass-border);
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
  transition: var(--transition-fast);
}

.cat-pill:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-main);
}

.cat-pill.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  font-weight: 600;
  box-shadow: 0 2px 10px rgba(99, 102, 241, 0.3);
}

.category-filter-bar .cat-pill[data-cat] {
  cursor: grab;
}

.cat-pill.is-dragging {
  opacity: 0.2;
  border-style: dashed;
  border-color: var(--primary);
  box-shadow: none;
  transition: none;
  cursor: grabbing;
}

.cat-pill.drop-target {
  border-color: var(--primary);
}

.category-drag-preview {
  position: fixed;
  z-index: 1000;
  pointer-events: none;
  opacity: 0.96;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
  transition: none;
  cursor: grabbing;
}

.category-drop-placeholder {
  flex: 0 0 auto;
  border: 1px dashed var(--primary);
  border-radius: var(--radius-full);
  background: rgba(99, 102, 241, 0.08);
  box-shadow: inset 0 1px 3px rgba(99, 102, 241, 0.14), 0 4px 10px rgba(0, 0, 0, 0.12);
}

.category-drag-handle {
  display: none;
  align-items: center;
  justify-content: center;
  flex: 0 0 18px;
  min-height: 20px;
  color: currentColor;
  border-radius: 4px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

/* ================= 网站卡片区域 ================= */
.section-container {
  margin-bottom: 34px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-left: 4px;
  border-left: 4px solid var(--primary);
}

.section-title {
  font-size: 18px;
  font-weight: 700;
  color: #f1f5f9;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 8px;
}

.section-actions {
  display: flex;
  gap: 8px;
}

.btn-text-sm {
  background: transparent;
  border: none;
  color: var(--text-sub);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.2s;
}

.btn-text-sm:hover {
  color: var(--danger);
}

.category-header .section-title {
  display: block;
  min-width: 0;
  overflow-wrap: break-word;
}

.edit-category-btn {
  flex-shrink: 0;
  white-space: nowrap;
  min-height: 32px;
  color: var(--text-muted);
}

.edit-category-btn:hover {
  color: var(--primary);
}

/* 网格矩阵 */
.sites-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(195px, 1fr));
  gap: 16px;
}

/* 单个网站卡片 */
.site-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--glass-card);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  text-decoration: none;
  color: inherit;
  transition: var(--transition-normal);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

#sitesMatrix .site-card[data-draggable="true"] {
  cursor: grab;
}

.site-card:hover {
  background: var(--glass-card-hover);
  border-color: rgba(255, 255, 255, 0.16);
  transform: translateY(-3px);
  box-shadow: 0 10px 20px -3px rgba(0, 0, 0, 0.4);
}

.site-card.highlight {
  border-color: var(--primary);
  box-shadow: 0 0 16px var(--primary-glow);
}

.site-card.is-dragging {
  opacity: 0.2;
  transform: none;
  border-style: dashed;
  border-color: var(--primary);
  box-shadow: none;
  transition: none;
  cursor: grabbing;
}

.site-drag-preview {
  position: fixed;
  z-index: 1000;
  pointer-events: none;
  opacity: 0.96;
  transform: rotate(1deg);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.32);
  transition: none;
  cursor: grabbing;
}

.site-drop-placeholder {
  min-width: 0;
  border: 1px dashed var(--primary);
  border-radius: var(--radius-md);
  background: rgba(99, 102, 241, 0.06);
  box-shadow: inset 0 1px 4px rgba(99, 102, 241, 0.16), 0 4px 12px rgba(0, 0, 0, 0.12);
}

.site-drag-handle {
  display: none;
  align-items: center;
  justify-content: center;
  flex: 0 0 20px;
  min-height: 32px;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}

.site-drag-handle::before,
.category-drag-handle::before {
  content: '';
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 5px 0 currentColor, 0 5px currentColor, 5px 5px currentColor, 0 10px currentColor, 5px 10px currentColor;
  transform: translate(-2px, -5px);
}

.site-card.is-dragging .site-drag-handle {
  color: var(--primary);
}

.section-container.drop-target .section-header {
  border-left-color: var(--primary);
  border-radius: 4px;
  background: rgba(99, 102, 241, 0.08);
}

html.site-dragging {
  cursor: grabbing;
  user-select: none;
  -webkit-user-select: none;
}

@media (hover: none), (pointer: coarse) {
  .site-drag-handle,
  .category-drag-handle {
    display: flex;
  }
}

.site-icon-box {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  box-shadow: 0 2px 5px rgba(0,0,0,0.2);
}

.site-icon-box img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.site-icon-box .default-icon {
  font-size: 18px;
}

.site-info {
  flex: 1;
  min-width: 0;
}

.site-name {
  font-size: 14px;
  font-weight: 600;
  color: #f8fafc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.site-desc {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

/* 卡片悬浮操作按钮 */
.card-tools {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
  background: rgba(15, 23, 42, 0.85);
  border-radius: var(--radius-sm);
  padding: 2px 4px;
  border: 1px solid var(--glass-border);
}

.site-card:hover .card-tools {
  opacity: 1;
  pointer-events: auto;
}

.tool-icon-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s;
}

.tool-icon-btn:hover {
  color: #fff;
}

.tool-icon-btn.delete:hover {
  color: var(--danger);
}

/* “添加网站”占位卡片 */
.add-site-card {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px;
  border: 2px dashed rgba(255, 255, 255, 0.15);
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition-fast);
}

.add-site-card:hover {
  border-color: var(--primary);
  background: var(--primary-light);
  color: #c7d2fe;
}

/* ================= 共享粘贴板主面板 ================= */
.clipboard-card {
  border-radius: var(--radius-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.glass-panel {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  box-shadow: var(--shadow-lg);
}

.clipboard-top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 16px 20px;
  background: rgba(15, 23, 42, 0.5);
  border-bottom: 1px solid var(--glass-border);
}

.clipboard-status-info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text-muted);
}

.live-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warning);
}

.live-indicator.online {
  background: var(--success);
  box-shadow: 0 0 8px var(--success);
}

.sep {
  color: rgba(255, 255, 255, 0.15);
}

.clipboard-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.view-toggle-group {
  display: inline-flex;
  background: rgba(0, 0, 0, 0.25);
  padding: 3px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--glass-border);
}

.toggle-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  padding: 5px 12px;
  font-size: 12px;
  border-radius: 5px;
  cursor: pointer;
  transition: var(--transition-fast);
}

.toggle-btn.active {
  background: var(--primary);
  color: #fff;
  font-weight: 600;
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--primary);
  border: 1px solid var(--primary);
  color: #fff;
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition-fast);
}

.btn-primary:hover {
  background: var(--primary-hover);
  box-shadow: var(--shadow-glow);
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--glass-border);
  color: var(--text-main);
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
  transition: var(--transition-fast);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.14);
}

.btn-danger-outline {
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #f87171;
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  cursor: pointer;
  transition: var(--transition-fast);
}

.btn-danger-outline:hover {
  background: rgba(239, 68, 68, 0.15);
  border-color: var(--danger);
}

.clipboard-editor-body {
  position: relative;
  min-height: 420px;
}

.clip-textarea {
  width: 100%;
  height: 420px;
  padding: 20px;
  background: rgba(11, 15, 25, 0.45);
  border: none;
  outline: none;
  color: #f1f5f9;
  font-family: "Fira Code", Consolas, Monaco, monospace, sans-serif;
  font-size: 15px;
  line-height: 1.65;
  resize: vertical;
}

.clip-preview {
  padding: 24px;
  min-height: 420px;
  color: #e2e8f0;
  line-height: 1.7;
  overflow-y: auto;
}

/* Markdown 美化 */
.markdown-body h1, .markdown-body h2, .markdown-body h3 {
  margin-top: 18px;
  margin-bottom: 10px;
  color: #f8fafc;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 6px;
}
.markdown-body pre {
  background: #0f172a;
  padding: 14px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 12px 0;
  border: 1px solid var(--glass-border);
}
.markdown-body code {
  font-family: Consolas, monospace;
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
}
.markdown-body blockquote {
  border-left: 4px solid var(--primary);
  padding-left: 12px;
  color: var(--text-muted);
  margin: 12px 0;
}

.clipboard-footer-tips {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  background: rgba(15, 23, 42, 0.4);
  border-top: 1px solid var(--glass-border);
  font-size: 13px;
}

.badge-tip {
  color: #a5b4fc;
  font-weight: 600;
  margin-right: 6px;
}

.link-btn {
  background: transparent;
  border: none;
  color: var(--primary);
  cursor: pointer;
  font-size: 13px;
  text-decoration: underline;
}

/* ================= 悬浮抽屉: 便捷便签板 ================= */
.drawer-panel {
  position: fixed;
  top: 0;
  right: -380px;
  width: 360px;
  height: 100vh;
  background: #0f172a;
  border-left: 1px solid var(--glass-border);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  z-index: 200;
  transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.drawer-panel.open {
  right: 0;
}

.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid var(--glass-border);
}

.drawer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 15px;
}

.drawer-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
}

.drawer-body {
  flex: 1;
  padding: 14px;
}

.drawer-textarea {
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  padding: 12px;
  color: #fff;
  font-size: 14px;
  resize: none;
  outline: none;
}

.drawer-footer {
  padding: 14px;
  border-top: 1px solid var(--glass-border);
}

.w-full {
  width: 100%;
  justify-content: center;
}

.floating-capsule {
  position: fixed;
  bottom: 30px;
  right: 25px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  padding: 10px 18px;
  border-radius: var(--radius-full);
  box-shadow: 0 8px 24px rgba(99, 102, 241, 0.4);
  cursor: pointer;
  z-index: 90;
  transition: transform 0.2s, box-shadow 0.2s;
}

.floating-capsule:hover {
  transform: translateY(-2px) scale(1.04);
  box-shadow: 0 12px 28px rgba(99, 102, 241, 0.6);
}

/* ================= 模态弹窗系统 ================= */
.modal-overlay {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 300;
  padding: 16px;
  overflow-y: auto;
}

.modal-overlay.open {
  display: flex;
  animation: fadeIn 0.25s ease;
}

.modal-dialog {
  width: 100%;
  max-width: 520px;
  max-height: 100%;
  border-radius: var(--radius-lg);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}

.qr-dialog {
  max-width: 400px;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 22px;
  border-bottom: 1px solid var(--glass-border);
  background: rgba(15, 23, 42, 0.5);
}

.modal-title {
  font-size: 17px;
  font-weight: 700;
}

.modal-close {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  cursor: pointer;
}

.modal-form {
  padding: 22px;
}

.form-group {
  margin-bottom: 18px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: #cbd5e1;
  margin-bottom: 6px;
}

.req {
  color: var(--danger);
}

.form-group input, .form-group select {
  width: 100%;
  min-width: 0;
  padding: 10px 14px;
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  color: #fff;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.form-group input:focus, .form-group select:focus {
  border-color: var(--primary);
  box-shadow: 0 0 10px rgba(99, 102, 241, 0.3);
}

.form-group select {
  -webkit-appearance: none;
  appearance: none;
  padding-right: 32px;
  background-color: #0f172a;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23cbd5e1' stroke-width='2'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}

.form-hint {
  display: block;
  font-size: 12px;
  color: var(--text-sub);
  margin-top: 4px;
}

.input-with-action {
  display: flex;
  gap: 8px;
}

.input-with-action input {
  flex: 1;
}

.btn-sm {
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--glass-border);
  color: #fff;
  border-radius: var(--radius-sm);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
  min-width: 0;
}

.cat-select-wrap {
  display: flex;
  gap: 6px;
}

.btn-icon-addon {
  width: 40px;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--glass-border);
  color: #fff;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 18px;
}

.icon-preview-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.icon-avatar-preview {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background: #1e293b;
  border: 1px solid var(--glass-border);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

.icon-avatar-preview img {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}

/* 数据管理弹窗 */
.data-manage-body {
  padding: 22px;
}

.data-stat-card {
  display: flex;
  justify-content: space-around;
  background: rgba(0, 0, 0, 0.25);
  border-radius: var(--radius-md);
  padding: 14px;
  margin-bottom: 20px;
  border: 1px solid var(--glass-border);
}

.stat-item {
  text-align: center;
}

.stat-val {
  display: block;
  font-size: 20px;
  font-weight: 700;
  color: #a5b4fc;
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
}

.data-btn-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.action-card-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  color: var(--text-main);
  text-align: left;
  cursor: pointer;
  transition: var(--transition-fast);
}

.action-card-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.action-card-btn.danger:hover {
  background: rgba(239, 68, 68, 0.15);
  border-color: var(--danger);
}

.action-card-btn .btn-icon {
  font-size: 22px;
}

.action-card-btn strong {
  display: block;
  font-size: 14px;
}

.action-card-btn span {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* 扫码互联弹窗 */
.qr-modal-body {
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.qr-canvas-box {
  width: 200px;
  height: 200px;
  background: #ffffff;
  border-radius: var(--radius-md);
  padding: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
  box-shadow: var(--shadow-md);
}

.qr-canvas-box img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.qr-hint {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.address-copy-bar {
  display: flex;
  gap: 6px;
  width: 100%;
}

.address-copy-bar input {
  flex: 1;
  min-width: 0;
  background: rgba(15, 23, 42, 0.8);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  color: #a5b4fc;
  padding: 8px 12px;
  font-size: 12px;
  outline: none;
}

/* ================= 浮层通知 Toast ================= */
.toast-container {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 500;
  pointer-events: none;
}

.toast {
  padding: 10px 20px;
  background: rgba(15, 23, 42, 0.95);
  border: 1px solid var(--primary);
  border-radius: var(--radius-full);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  box-shadow: var(--shadow-lg);
  animation: toastIn 0.25s ease-out;
}

@keyframes toastIn {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* iOS 14.2 支持 Grid gap，但 Flex gap 需要用实际布局检测后回退。 */
.no-flex-gap .brand-badge > * + *,
.no-flex-gap .top-actions > * + *,
.no-flex-gap .engine-option > * + *,
.no-flex-gap .category-filter-bar > * + *,
.no-flex-gap .clipboard-status-info > * + *,
.no-flex-gap .icon-preview-row > * + *,
.no-flex-gap .modal-actions > * + * { margin-left: 10px; }
.no-flex-gap .cat-pill > * + * { margin-left: 6px; }

.no-flex-gap .brand-badge > .kv-sync-badge { margin-left: 16px; }
.no-flex-gap .kv-sync-badge > * + * { margin-left: 5px; }
.no-flex-gap .icon-btn > * + *,
.no-flex-gap .engine-current-btn > * + *,
.no-flex-gap .btn-primary > * + *,
.no-flex-gap .btn-secondary > * + *,
.no-flex-gap .cat-select-wrap > * + *,
.no-flex-gap .address-copy-bar > * + * { margin-left: 6px; }

.no-flex-gap .nav-tab > * + *,
.no-flex-gap .section-actions > * + *,
.no-flex-gap .add-site-card > * + *,
.no-flex-gap .drawer-title > * + *,
.no-flex-gap .floating-capsule > * + *,
.no-flex-gap .input-with-action > * + * { margin-left: 8px; }
.no-flex-gap .nav-tab > .badge-live { margin-left: 12px; }
.no-flex-gap .section-title > .icon { margin-right: 8px; }

.no-flex-gap .nav-tabs-container > * + *,
.no-flex-gap .form-row > * + *,
.no-flex-gap .site-card > .site-info { margin-left: 12px; }
.no-flex-gap .site-card > .site-drag-handle + .site-icon-box { margin-left: 8px; }
.no-flex-gap .card-tools > * + * { margin-left: 4px; }
.no-flex-gap .action-card-btn > .btn-info { margin-left: 14px; }
.no-flex-gap .data-btn-grid > * + * { margin-top: 10px; }
.no-flex-gap .toast-container > * + * { margin-top: 8px; }

/* 换行容器让每一行都保留间距，外侧补偿不会挤占内容宽度。 */
.no-flex-gap .engine-pills { margin: 8px -4px -4px; }
.no-flex-gap .engine-pills > * { margin: 4px; }
.no-flex-gap .clipboard-top-bar { padding-top: 4px; }
.no-flex-gap .clipboard-top-bar > * { margin-top: 12px; }
.no-flex-gap .clipboard-status-info { margin-right: 12px; }
.no-flex-gap .clipboard-actions { margin-right: -10px; margin-bottom: -10px; }
.no-flex-gap .clipboard-actions > * { margin-right: 10px; margin-bottom: 10px; }

/* ================= 移动端适配 ================= */
@media (max-width: 768px) {
  .top-nav-bar {
    padding: 10px 16px;
  }
  .btn-text {
    display: none;
  }
  .brand-text {
    display: none;
  }
  .kv-sync-badge {
    white-space: nowrap;
  }
  .nav-tabs-container {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    width: 100%;
    gap: 8px;
  }
  .nav-tab {
    justify-content: center;
    padding: 10px 6px;
    font-size: 13px;
    white-space: nowrap;
  }
  .nav-tab svg, .nav-tab .badge-live {
    display: none;
  }
  .no-flex-gap .nav-tabs-container > * + *,
  .no-flex-gap .nav-tab > span {
    margin-left: 0;
  }
  .main-wrapper {
    padding: 16px 12px 60px;
  }
  .sites-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }
  .site-card {
    padding: 10px;
    gap: 8px;
  }
  .site-icon-box {
    width: 32px;
    height: 32px;
  }
  .site-name {
    font-size: 13px;
  }
  .site-desc {
    display: none;
  }
  .card-tools {
    opacity: 1;
    pointer-events: auto;
  }
  .engine-pills {
    display: none;
  }
  .clipboard-top-bar {
    flex-direction: column;
    align-items: flex-start;
  }
  .drawer-panel {
    width: 100%;
    right: -100%;
  }
  .form-row {
    flex-direction: column;
    gap: 0;
  }
  .no-flex-gap .site-card > .site-info {
    margin-left: 8px;
  }
  .no-flex-gap .form-row > * + * {
    margin-left: 0;
  }
}
`;

// 内嵌 JS（由构建脚本替换）
const JS_CONTENT = `﻿/**
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
  try { return new URL(normalizeSiteUrl(url)).hostname.replace(/^www\\./i, ''); }
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
  bar.innerHTML = \`<button class="cat-pill \${currentFilter === null ? 'active' : ''}" data-all="true">全部</button>\`;
  cats.forEach(cat => {
    const count = appData.sites.filter(s => s.category === cat).length;
    if (count === 0) return;
    bar.innerHTML += \`<button class="cat-pill \${currentFilter === cat ? 'active' : ''}" data-cat="\${escapeHtml(cat)}">\${escapeHtml(cat)} <span style="opacity:0.6;font-size:11px;">\${count}</span><span class="category-drag-handle" title="拖动排序" aria-hidden="true"></span></button>\`;
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
  const iconSrc = site.icon || \`https://www.google.com/s2/favicons?domain=\${domain}&sz=64\`;
  const canDrag = showTools && !searchKeyword.trim();
  const card = document.createElement('a');
  card.className = 'site-card';
  card.href = 'javascript:void(0)';
  card.title = site.desc || site.name;
  card.dataset.id = site.id;
  card.dataset.draggable = canDrag ? 'true' : 'false';
  card.innerHTML = \`
    \${canDrag ? '<span class="site-drag-handle" title="拖动排序或移动分类" aria-hidden="true"></span>' : ''}
    <div class="site-icon-box">
      <img src="\${escapeHtml(iconSrc)}" alt="\${escapeHtml(site.name)}">
    </div>
    <div class="site-info">
      <div class="site-name">\${escapeHtml(site.name)}</div>
      \${site.desc ? \`<div class="site-desc">\${escapeHtml(site.desc)}</div>\` : ''}
    </div>
    \${showTools ? \`
    <div class="card-tools">
      <button class="tool-icon-btn" data-action="edit" data-id="\${escapeHtml(site.id)}" title="编辑">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
      </button>
      <button class="tool-icon-btn delete" data-action="delete" data-id="\${escapeHtml(site.id)}" title="删除">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
      </button>
    </div>\` : ''}
  \`;
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
    section.innerHTML = \`<div class="section-header"><h2 class="section-title"><span class="icon">🔍</span> 搜索结果 (\${filtered.length} 个)</h2></div>\`;
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
    header.innerHTML = \`<h2 class="section-title">\${getCatEmoji(cat)} \${escapeHtml(cat)}</h2>\`;
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
  _qs('#searchInput').placeholder = key === 'local' ? '输入关键字站内搜索，实时过滤导航网站...' : \`在 \${eng.name} 中搜索...\`;
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
  sel.innerHTML = (appData.categories || []).map(cat => \`<option value="\${escapeHtml(cat)}" \${cat === current ? 'selected' : ''}>\${escapeHtml(cat)}</option>\`).join('');
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
  a.download = \`aurora-portal-backup-\${new Date().toISOString().replace(/[:.]/g, '-')}.json\`;
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
      throw new Error(\`第 \${index + 1} 个网址的名称、链接或分类格式错误\`);
    }
    let url, icon;
    try {
      url = normalizeSiteUrl(site.url);
      icon = site.icon ? normalizeSiteUrl(site.icon) : '';
    } catch (e) { throw new Error(\`第 \${index + 1} 个网址或图标地址无效\`); }
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
      const data = validateBackup(JSON.parse(e.target.result.replace(/^\\uFEFF/, '')));
      if (!confirm(\`确认导入 \${data.sites.length} 个网址并覆盖现有 \${appData.sites.length} 个网址？覆盖前会在本浏览器保存一份备份。\`)) return;
      localStorage.setItem(BACKUP_KEY, JSON.stringify(appData));
      await applyBackup(data);
      toast(\`成功导入 \${data.sites.length} 个网址，可恢复导入前备份\`, 'success');
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
  const lines = txt.split('\\n').length;
  _qs('#clipWordsMeta').textContent = \`字符: \${txt.length}\`;
  _qs('#clipLinesMeta').textContent = \`行数: \${lines}\`;
  const mins = Math.floor((Date.now() - lastSyncTime) / 60000);
  _qs('#clipTimeMeta').textContent = clipDirty ? '修改尚未上传' : !lastSyncTime ? '尚未连接' : mins === 0 ? '刚刚同步' : \`\${mins} 分钟前同步\`;
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
  indicator.className = \`live-indicator \${online ? 'online' : ''}\`;
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
  const qrUrl = \`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=\${encodeURIComponent(address)}&bgcolor=ffffff&color=000000\`;
  _qs('#qrCodeImage').src = qrUrl;
  modal.classList.add('open');
}

/* =====================================================================
   11. 背景切换
   ===================================================================== */
const BG_THEMES = [
  // 渐变极光动感主题
  \`radial-gradient(circle at 20% 20%, rgba(99, 102, 241, 0.35) 0%, transparent 50%),radial-gradient(circle at 80% 80%, rgba(236, 72, 153, 0.25) 0%, transparent 45%),radial-gradient(circle at 60% 30%, rgba(14, 165, 233, 0.2) 0%, transparent 40%),#080c18\`,
  // 深海蓝绿
  \`radial-gradient(circle at 30% 70%, rgba(6, 182, 212, 0.3) 0%, transparent 50%),radial-gradient(circle at 70% 20%, rgba(34, 197, 94, 0.2) 0%, transparent 45%),#061018\`,
  // 紫罗兰霞光
  \`radial-gradient(circle at 10% 60%, rgba(168, 85, 247, 0.35) 0%, transparent 50%),radial-gradient(circle at 80% 40%, rgba(251, 146, 60, 0.2) 0%, transparent 45%),#100820\`,
  // 红橙暖色
  \`radial-gradient(circle at 20% 40%, rgba(239, 68, 68, 0.25) 0%, transparent 45%),radial-gradient(circle at 75% 70%, rgba(249, 115, 22, 0.25) 0%, transparent 45%),#150a08\`,
  // 纯暗极简
  \`linear-gradient(135deg, #0b0f1a 0%, #111827 100%)\`,
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
    toast(\`分类「\${name}」已创建 ✅\`, 'success');
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
        var newContent = clipContent ? clipContent + '\\n' + text : text;
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
`;

// 内嵌默认站点数据（由构建脚本替换）
const DEFAULT_DATA = {
  "profile": {
    "title": "极光导航",
    "subtitle": "上网，从这开始！",
    "avatar": "https://api.dicebear.com/7.x/bottts/svg?seed=portal&backgroundColor=6366f1"
  },
  "categories": [
    "常用推荐",
    "AI 人工智能",
    "影视影音",
    "音乐听歌",
    "开发编程",
    "实用工具",
    "学习资讯"
  ],
  "sites": []
};
