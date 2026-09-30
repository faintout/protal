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
const HTML_CONTENT = `__HTML_CONTENT__`;

// 内嵌 CSS（由构建脚本替换）
const CSS_CONTENT = `__CSS_CONTENT__`;

// 内嵌 JS（由构建脚本替换）
const JS_CONTENT = `__JS_CONTENT__`;

// 内嵌默认站点数据（由构建脚本替换）
const DEFAULT_DATA = __DEFAULT_DATA__;
