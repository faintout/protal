#!/usr/bin/env node
/**
 * 极光导航 - Cloudflare Worker 构建脚本
 * 功能: 将 public/ 下的静态资源内嵌到 worker.js 中，生成独立可部署的 worker-dist.js
 * 运行: node build.js
 */

const fs = require('fs');
const path = require('path');

console.log('🔨 开始构建 Cloudflare Worker...');

const workerTemplate = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf-8');
const htmlContent    = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
const cssContent     = fs.readFileSync(path.join(__dirname, 'public', 'css', 'style.css'), 'utf-8');
const defaultData    = fs.readFileSync(path.join(__dirname, 'data', 'default-sites.json'), 'utf-8');
const metadataCode   = fs.readFileSync(path.join(__dirname, 'site-metadata.js'), 'utf-8');

// 读取前端 JS 并将 marked.min.js 的 CDN 引用保留（Worker 只是转发 JS 文件，不需要内联）
let jsContent = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf-8');

// 将 HTML 中的本地引用路径调整为相对路径（Worker 单文件模式下路径一致）
let html = htmlContent;

// 转义模板字符串中的反引号和反斜杠
function escapeForTemplateLiteral(str) {
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

const htmlEscaped = escapeForTemplateLiteral(html);
const cssEscaped  = escapeForTemplateLiteral(cssContent);
const jsEscaped   = escapeForTemplateLiteral(jsContent);

let workerDist = workerTemplate
  .replace('__SITE_METADATA_CODE__', () => metadataCode)
  .replace('`__HTML_CONTENT__`', () => `\`${htmlEscaped}\``)
  .replace('`__CSS_CONTENT__`',  () => `\`${cssEscaped}\``)
  .replace('`__JS_CONTENT__`',   () => `\`${jsEscaped}\``)
  .replace('__DEFAULT_DATA__',  () => defaultData.trim());

fs.writeFileSync(path.join(__dirname, 'worker-dist.js'), workerDist, 'utf-8');

const sizeKB = (fs.statSync(path.join(__dirname, 'worker-dist.js')).size / 1024).toFixed(1);

console.log(`\n  ✅ 构建成功！`);
console.log(`  📦 输出文件: worker-dist.js (${sizeKB} KB)`);
console.log(`\n  部署至 Cloudflare:`);
console.log(`  1. 创建 KV: wrangler kv:namespace create "AURORA_KV"`);
console.log(`     （将输出的 ID 填入 wrangler.toml）`);
console.log(`  2. 部署:    wrangler deploy`);
console.log(`\n  本地调试:`);
console.log(`  wrangler dev\n`);
