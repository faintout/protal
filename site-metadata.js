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
