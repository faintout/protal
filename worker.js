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
__SITE_METADATA_CODE__

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
const HTML_CONTENT = `__HTML_CONTENT__`;

// 内嵌 CSS（由构建脚本替换）
const CSS_CONTENT = `__CSS_CONTENT__`;

// 内嵌 JS（由构建脚本替换）
const JS_CONTENT = `__JS_CONTENT__`;

// 内嵌默认站点数据（由构建脚本替换）
const DEFAULT_DATA = __DEFAULT_DATA__;
