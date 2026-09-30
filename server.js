/**
 * 极光导航 - 本地 Node.js 服务器
 * 功能: 静态文件服务 + 站点数据持久化 + SSE 粘贴板实时同步
 * 运行: node server.js
 * 支持: 局域网多设备实时联动（自动打印本机 IP + 二维码地址）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
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
  try { return JSON.parse(fs.readFileSync(target, 'utf-8')); } catch { return { profile: {}, categories: [], sites: [] }; }
}

function writeSites(data) {
  fs.writeFileSync(SITES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function readClip() {
  try { return fs.existsSync(CLIP_FILE) ? fs.readFileSync(CLIP_FILE, 'utf-8') : ''; } catch { return ''; }
}

function writeClip(content) {
  fs.writeFileSync(CLIP_FILE, content, 'utf-8');
}

/* =====================================================================
   SSE (Server-Sent Events) - 多设备实时粘贴板广播
   ===================================================================== */
const sseClients = new Set();

function broadcastClip(content, excludeRes = null) {
  const msg = `data: ${JSON.stringify({ type: 'clip-update', content })}\n\n`;
  sseClients.forEach(client => {
    if (client !== excludeRes) {
      try { client.write(msg); } catch { sseClients.delete(client); }
    }
  });
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
  // 获取站点数据
  if (pathname === '/api/sites' && method === 'GET') {
    return sendJson(res, readSites());
  }

  // 保存站点数据
  if (pathname === '/api/sites' && method === 'POST') {
    const body = await readBody(req);
    writeSites(body);
    return sendJson(res, { ok: true });
  }

  // 获取粘贴板内容
  if (pathname === '/api/clipboard' && method === 'GET') {
    return sendJson(res, { content: readClip() });
  }

  // 更新粘贴板内容并广播
  if (pathname === '/api/clipboard' && method === 'POST') {
    const body = await readBody(req);
    const content = typeof body === 'string' ? body : (body.content ?? '');
    writeClip(content);
    broadcastClip(content, res);
    return sendJson(res, { ok: true });
  }

  // SSE 长连接（粘贴板多端实时广播）
  if (pathname === '/api/clipboard/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // 立刻推送当前内容
    const current = readClip();
    res.write(`data: ${JSON.stringify({ type: 'clip-update', content: current })}\n\n`);

    sseClients.add(res);

    // 心跳保活 (15s)
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); sseClients.delete(res); }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

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
   启动与局域网信息输出
   ===================================================================== */
server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  let localIP = 'localhost';

  // 获取本机局域网 IP
  for (const iface of Object.values(ifaces)) {
    for (const config of iface) {
      if (config.family === 'IPv4' && !config.internal) {
        localIP = config.address;
        break;
      }
    }
    if (localIP !== 'localhost') break;
  }

  const localUrl  = `http://localhost:${PORT}`;
  const lanUrl    = `http://${localIP}:${PORT}`;

  console.log('\n');
  console.log('  ✨ 极光导航 (Aurora Portal) 已启动！');
  console.log('  ─────────────────────────────────────');
  console.log(`  🌐 本机地址:      ${localUrl}`);
  console.log(`  📡 局域网地址:    ${lanUrl}`);
  console.log(`  📋 粘贴板同步:    ${lanUrl}/#clipboard`);
  console.log('  ─────────────────────────────────────');
  console.log(`  手机扫码访问（同一 WiFi 下）:`);
  console.log(`  二维码: https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(lanUrl)}`);
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
