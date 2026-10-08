/**
 * 极光导航 - 本地 Node.js 服务器
 * 功能: 静态文件服务 + 站点数据持久化 + 粘贴板 API
 * 运行: node server.js
 * 用途: 本机开发；跨设备共享请部署 Cloudflare Worker
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const fetchNodeSiteMetadata = require('./site-metadata-node');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
const CLIP_FILE = path.join(DATA_DIR, 'clipboard.txt');

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* =====================================================================
   工具函数
   ===================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
};

function getMime(ext) {
  return MIME[ext] || 'application/octet-stream';
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function sendError(res, msg, status = 500) {
  sendJson(res, { error: msg }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    req.on('error', reject);
  });
}

/* =====================================================================
   数据读写
   ===================================================================== */
function readSites() {
  // 优先读取自定义 sites.json，不存在时回退至 default-sites.json
  const target = fs.existsSync(SITES_FILE) ? SITES_FILE : path.join(DATA_DIR, 'default-sites.json');
  return JSON.parse(fs.readFileSync(target, 'utf-8'));
}

function writeSites(data) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function readClip() {
  try {
    return { content: fs.readFileSync(CLIP_FILE, 'utf-8'), updatedAt: fs.statSync(CLIP_FILE).mtimeMs };
  } catch (error) {
    if (error.code === 'ENOENT') return { content: '', updatedAt: 0 };
    throw error;
  }
}

function writeClip(content) {
  fs.writeFileSync(CLIP_FILE, content, 'utf-8');
  return { content, updatedAt: fs.statSync(CLIP_FILE).mtimeMs };
}

/* =====================================================================
   静态文件服务
   ===================================================================== */
function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': getMime(ext), 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/* =====================================================================
   主路由
   ===================================================================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  // CORS 预检
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  /* ---- API 路由 ---- */
  // 获取公开网站的标题与图标（跨域请求由服务器完成）
  if (pathname === '/api/site-metadata' && method === 'GET') {
    try {
      return sendJson(res, await fetchNodeSiteMetadata(url.searchParams.get('url')));
    } catch (error) {
      return sendError(res, error.status ? error.message : '无法获取网站信息，请手动填写', error.status || 502);
    }
  }

  // 获取站点数据
  if (pathname === '/api/sites' && method === 'GET') {
    try { return sendJson(res, readSites()); }
    catch { return sendError(res, '站点存储暂不可用，请稍后重试', 503); }
  }

  // 保存站点数据
  if (pathname === '/api/sites' && method === 'POST') {
    try {
      const body = await readBody(req);
      writeSites(body);
      return sendJson(res, { ok: true });
    } catch { return sendError(res, '站点存储暂不可用，请稍后重试', 503); }
  }

  // 获取粘贴板内容
  if (pathname === '/api/clipboard' && method === 'GET') {
    try { return sendJson(res, readClip()); }
    catch { return sendError(res, '粘贴板存储暂不可用，请稍后重试', 503); }
  }

  // 更新粘贴板内容，返回已保存的版本
  if (pathname === '/api/clipboard' && method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body || typeof body.content !== 'string') {
        return sendError(res, 'content 必须是字符串', 400);
      }
      return sendJson(res, writeClip(body.content));
    } catch { return sendError(res, '粘贴板存储暂不可用，请稍后重试', 503); }
  }

  if (pathname.startsWith('/api/')) return sendError(res, 'Not Found', 404);

  /* ---- 静态文件服务 ---- */
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);

  // 路径穿越防护
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    return sendError(res, 'Forbidden', 403);
  }

  // 目录默认 index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (fs.existsSync(filePath)) {
    return serveStatic(res, filePath);
  }

  // SPA fallback -> index.html
  return serveStatic(res, path.join(__dirname, 'public', 'index.html'));
});

/* =====================================================================
   启动本机开发服务
   ===================================================================== */
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n');
  console.log('  ✨ 极光导航 (Aurora Portal) 本机开发服务已启动！');
  console.log('  ─────────────────────────────────────');
  console.log(`  🌐 本机地址: http://localhost:${PORT}`);
  console.log('  ☁️ 跨设备共享: 部署后在各设备打开同一 HTTPS 地址');
  console.log('  ─────────────────────────────────────');
  console.log('\n  按 Ctrl+C 停止服务\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌ 端口 ${PORT} 已被占用，请使用: PORT=3001 node server.js\n`);
  } else {
    console.error('服务器错误:', err);
  }
  process.exit(1);
});
