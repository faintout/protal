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
 *  - SSE 通过轮询降级方式兼容 Worker 限制（Worker 不支持原生 SSE 长连接）
 */

// ===================== KV 键常量 =====================
const KV_SITES    = 'aurora:sites';
const KV_CLIP     = 'aurora:clipboard';

// ===================== CORS 响应头 =====================
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ===================== 工具函数 =====================
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
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

    // ---- API: 站点数据 ----
    if (pathname === '/api/sites') {
      if (method === 'GET') {
        const data = await env.AURORA_KV.get(KV_SITES);
        if (data) return jsonResp(JSON.parse(data));
        // 首次访问，读取内嵌默认数据
        return jsonResp(DEFAULT_DATA);
      }

      if (method === 'POST') {
        const body = await request.json();
        await env.AURORA_KV.put(KV_SITES, JSON.stringify(body));
        return jsonResp({ ok: true });
      }
    }

    // ---- API: 粘贴板获取 ----
    if (pathname === '/api/clipboard' && method === 'GET') {
      const content = (await env.AURORA_KV.get(KV_CLIP)) || '';
      return jsonResp({ content });
    }

    // ---- API: 粘贴板更新 ----
    if (pathname === '/api/clipboard' && method === 'POST') {
      const body = await request.json();
      const content = body.content ?? '';
      await env.AURORA_KV.put(KV_CLIP, content);
      return jsonResp({ ok: true });
    }

    // ---- API: 粘贴板 SSE 降级为长轮询 ----
    // Cloudflare Worker 不支持原生 SSE，此接口通过 Streaming Response 模拟单次推送
    // 前端会 fallback 到轮询模式
    if (pathname === '/api/clipboard/sse') {
      const content = (await env.AURORA_KV.get(KV_CLIP)) || '';
      const msg = `data: ${JSON.stringify({ type: 'clip-update', content })}\n\n`;
      return new Response(msg, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...CORS_HEADERS,
        },
      });
    }

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
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
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
    </div>
    <div class="top-actions">
      <!-- 局域网扫码互联 -->
      <button class="icon-btn" id="qrShareBtn" title="跨设备扫码同步">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><path d="M7 7h.01M17 7h.01M7 17h.01M17 17h.01"></path></svg>
        <span class="btn-text">扫码互联</span>
      </button>
      <!-- 换壁纸 -->
      <button class="icon-btn" id="changeBgBtn" title="切换背景">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
      </button>
      <!-- 数据备份 -->
      <button class="icon-btn" id="dataManageBtn" title="数据管理与备份">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>
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
          <span class="badge-live" id="syncStatusBadge">● 实时同步</span>
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
        <button class="cat-pill active" data-cat="all">全部</button>
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
            <span class="live-indicator online" id="clipLiveIndicator"></span>
            <span class="status-text" id="clipStatusText">已连接至云同步</span>
            <span class="sep">|</span>
            <span class="meta-item" id="clipWordsMeta">字数: 0</span>
            <span class="meta-item" id="clipLinesMeta">行数: 1</span>
            <span class="sep">|</span>
            <span class="meta-item" id="clipTimeMeta">刚刚更新</span>
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
          <textarea id="clipTextarea" class="clip-textarea" placeholder="在此直接键入或粘贴文本/代码/笔记，局域网多设备和多标签页秒级实时共享编辑..."></textarea>
          
          <!-- Markdown 预览展示面板 -->
          <div id="clipPreviewPanel" class="clip-preview markdown-body" style="display: none;"></div>
        </div>

        <div class="clipboard-footer-tips">
          <div class="tip-left">
            <span class="badge-tip">💡 协同说明</span>
            <span>修改即自动保存并广播至所有设备与标签页，支持手机浏览器扫码后直接双向互传！</span>
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
        <span>快捷便签板 (同步中)</span>
      </div>
      <button class="drawer-close" id="closeDrawerBtn">✕</button>
    </div>
    <div class="drawer-body">
      <textarea id="drawerTextarea" class="drawer-textarea" placeholder="随时随地随手记，与主粘贴板实时双向联动..."></textarea>
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
            <button type="button" class="btn-sm" id="btnAutoFetchIcon">自动探测图标</button>
          </div>
          <small class="form-hint">输入网址后将自动尝试提取对应网站的高清 Favicon 图标</small>
        </div>

        <div class="form-group">
          <label for="formSiteName">网站名称 <span class="req">*</span></label>
          <input type="text" id="formSiteName" placeholder="例如: 哔哩哔哩" required autocomplete="off">
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label for="formSiteCategory">网站分类 <span class="req">*</span></label>
            <div class="cat-select-wrap">
              <select id="formSiteCategory" required></select>
              <button type="button" class="btn-icon-addon" id="btnAddNewCat" title="新增分类">+</button>
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
        <h3 class="modal-title">数据管理与备份</h3>
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
            <span class="stat-val" id="statStorageType">本地+云端</span>
            <span class="stat-label">持久化模式</span>
          </div>
        </div>

        <div class="data-btn-grid">
          <button class="action-card-btn" id="btnExportData">
            <span class="btn-icon">💾</span>
            <div class="btn-info">
              <strong>导出配置备份 (JSON)</strong>
              <span>将全部网站分类及名称导出为本地文件</span>
            </div>
          </button>

          <label class="action-card-btn" for="importFileInput">
            <span class="btn-icon">📥</span>
            <div class="btn-info">
              <strong>导入已有配置 (JSON)</strong>
              <span>从之前备份的 JSON 文件恢复</span>
            </div>
            <input type="file" id="importFileInput" accept=".json" style="display:none;">
          </label>

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
          <p class="qr-hint">手机连接同一局域网 WiFi 或通过浏览器扫一扫即可同步共享：</p>
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
  inset: 0;
  background: var(--bg-gradient);
  background-size: cover;
  background-attachment: fixed;
  z-index: -2;
  transition: opacity 0.5s ease;
}

.bg-overlay {
  position: fixed;
  inset: 0;
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
  inset-inline: 0;
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
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 300;
  padding: 16px;
}

.modal-overlay.open {
  display: flex;
  animation: fadeIn 0.25s ease;
}

.modal-dialog {
  width: 100%;
  max-width: 520px;
  border-radius: var(--radius-lg);
  overflow: hidden;
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

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
}

.cat-select-wrap {
  display: flex;
  gap: 6px;
}

.btn-icon-addon {
  width: 40px;
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

/* ================= 移动端适配 ================= */
@media (max-width: 768px) {
  .top-nav-bar {
    padding: 10px 16px;
  }
  .btn-text {
    display: none;
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
}
`;

// 内嵌 JS（由构建脚本替换）
const JS_CONTENT = `/**
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
  \`https://www.google.com/s2/favicons?domain=\${url}&sz=64\`,
  \`https://favicon.yandex.net/favicon/\${url}\`,
  \`https://api.faviconkit.com/\${url}/64\`,
];

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

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
const genId = () => \`site-\${Date.now()}-\${Math.random().toString(36).slice(2, 7)}\`;

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
  bar.innerHTML = \`<button class="cat-pill \${currentFilter === 'all' ? 'active' : ''}" data-cat="all">全部</button>\`;
  cats.forEach(cat => {
    const count = appData.sites.filter(s => s.category === cat).length;
    if (count === 0) return;
    bar.innerHTML += \`<button class="cat-pill \${currentFilter === cat ? 'active' : ''}" data-cat="\${cat}">\${cat} <span style="opacity:0.6;font-size:11px;">\${count}</span></button>\`;
  });
  $('.cat-pill', bar).forEach(btn => {
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
  const iconSrc = site.icon || \`https://www.google.com/s2/favicons?domain=\${domain}&sz=64\`;
  const card = document.createElement('a');
  card.className = 'site-card';
  card.href = 'javascript:void(0)';
  card.title = site.desc || site.name;
  card.dataset.id = site.id;
  card.innerHTML = \`
    <div class="site-icon-box">
      <img src="\${iconSrc}" alt="\${site.name}" onerror="this.parentElement.innerHTML='<span class=\\\\'default-icon\\\\'>🌐</span>'">
    </div>
    <div class="site-info">
      <div class="site-name">\${site.name}</div>
      \${site.desc ? \`<div class="site-desc">\${site.desc}</div>\` : ''}
    </div>
    \${showTools ? \`
    <div class="card-tools">
      <button class="tool-icon-btn" data-action="edit" data-id="\${site.id}" title="编辑">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
      </button>
      <button class="tool-icon-btn delete" data-action="delete" data-id="\${site.id}" title="删除">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
      </button>
    </div>\` : ''}
  \`;
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
    if (catSites.length === 0 && currentFilter !== 'all') return;

    const section = document.createElement('div');
    section.className = 'section-container';
    section.dataset.category = cat;

    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = \`<h2 class="section-title">\${getCatEmoji(cat)} \${cat}</h2>\`;
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
  $('.engine-option').forEach(opt => opt.classList.toggle('active', opt.dataset.engine === key));
  $('.pill-item').forEach(p => p.classList.toggle('active', p.dataset.engine === key));
  $('#searchInput').placeholder = key === 'local' ? '输入关键字站内搜索，实时过滤导航网站...' : \`在 \${eng.name} 中搜索...\`;
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
  $('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.target === targetId));
  $('.tab-panel').forEach(p => p.classList.toggle('active', p.id === targetId));
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
  sel.innerHTML = (appData.categories || []).map(cat => \`<option value="\${cat}" \${cat === current ? 'selected' : ''}>\${cat}</option>\`).join('');
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
    const fallback = \`https://www.google.com/s2/favicons?domain=\${domain}&sz=64\`;
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
  a.download = \`aurora-portal-backup-\${new Date().toISOString().slice(0, 10)}.json\`;
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
      if (!confirm(\`确认导入？将覆盖现有 \${appData.sites.length} 个站点，导入 \${json.sites.length} 个站点。\`)) return;
      appData = { ...appData, ...json };
      saveData();
      renderAll();
      toast(\`成功导入 \${json.sites.length} 个网站 ✅\`, 'success');
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
  const words = txt.trim() ? txt.trim().split(/\\s+/).length : 0;
  const lines = txt.split('\\n').length;
  $('#clipWordsMeta').textContent = \`字符: \${txt.length}\`;
  $('#clipLinesMeta').textContent = \`行数: \${lines}\`;
  const mins = Math.floor((Date.now() - lastSyncTime) / 60000);
  $('#clipTimeMeta').textContent = mins === 0 ? '刚刚更新' : \`\${mins} 分钟前\`;
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
  indicator.className = \`live-indicator \${online ? 'online' : ''}\`;
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
  const address = forClipboard ? \`\${getLocalAddress()}/#clipboard\` : getLocalAddress();
  $('#qrAddressInput').value = address;
  // 使用 QR 码生成 API
  const qrUrl = \`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=\${encodeURIComponent(address)}&bgcolor=ffffff&color=000000\`;
  $('#qrCodeImage').src = qrUrl;
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

  $('.engine-option').forEach(opt => {
    opt.addEventListener('click', () => {
      setEngine(opt.dataset.engine);
      $('#engineMenu').classList.remove('show');
    });
  });

  $('.pill-item').forEach(pill => {
    pill.addEventListener('click', () => setEngine(pill.dataset.engine));
  });

  // --- Tab 切换 ---
  $('.nav-tab[data-target]').forEach(tab => {
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
    toast(\`分类「\${name}」已创建 ✅\`, 'success');
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
      const newContent = clipContent ? clipContent + '\\n' + text : text;
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
