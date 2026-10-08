const http = require('http');
const https = require('https');
const dns = require('dns');
const { METADATA_MAX_BYTES, metadataError, isPublicAddress, fetchSiteMetadata } = require('./site-metadata');

function isFakeDnsAddress(address) {
  if (/^198\.(?:18|19)\.\d+\.\d+$/.test(address)) return true;
  try {
    const normalized = new URL('http://[' + address + ']').hostname;
    return /^\[2001:2:(?::|0:)/.test(normalized);
  } catch (error) { return false; }
}

async function resolvePublicDns(hostname, timeout) {
  const answers = await Promise.all(['A', 'AAAA'].map(type => new Promise((resolve, reject) => {
    // Only the fixed trusted resolver bypasses target-address validation.
    const req = https.get('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(hostname) + '&type=' + type,
      { headers: { Accept: 'application/dns-json' } }, res => {
        if (res.statusCode !== 200) {
          res.destroy();
          return finish(metadataError('无法解析网站地址'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 64 * 1024) return req.destroy(metadataError('域名解析响应过大'));
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (data.Status !== 0) throw metadataError('无法解析网站地址');
            finish(null, (data.Answer || []).filter(answer => answer.type === 1 || answer.type === 28)
              .map(answer => ({ address: answer.data, family: answer.type === 1 ? 4 : 6 })));
          } catch (error) { finish(metadataError('无法解析网站地址')); }
        });
        res.on('error', error => finish(error));
      });
    const timer = setTimeout(() => req.destroy(metadataError('获取网站信息超时', 504)), Math.max(1, Math.min(timeout, 3000)));
    function finish(error, result) {
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }
    req.on('error', error => finish(error));
  })));
  return answers[0].concat(answers[1]);
}

function requestMetadataPage(url, timeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: { Accept: 'text/html, application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'AuroraPortal/1.0' },
      // Validate and use the same DNS answer, including after every redirect.
      lookup(hostname, options, callback) {
        dns.lookup(hostname, { all: true }, async (error, addresses) => {
          if (error) return callback(error);
          try {
            // Some local proxies replace all DNS answers with benchmark-range IPs.
            // Resolve those through DoH, then pin the checked public address below.
            if (addresses.length && addresses.every(item => isFakeDnsAddress(item.address))) {
              addresses = await resolvePublicDns(hostname, deadline - Date.now());
            }
            if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
              throw metadataError('仅支持公开网站的 HTTP 或 HTTPS 地址', 400);
            }
            const first = addresses[0];
            callback(null, options.all ? [first] : first.address, first.family);
          } catch (lookupError) { callback(lookupError); }
        });
      },
    }, res => {
      const page = { status: res.statusCode, location: res.headers.location,
        contentType: res.headers['content-type'] || '', html: '' };
      if (page.status < 200 || page.status >= 300 ||
        (page.contentType && !/(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType))) {
        res.destroy();
        return finish(null, page);
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        const limited = chunk.slice(0, METADATA_MAX_BYTES - size);
        chunks.push(limited);
        size += limited.length;
        if (size === METADATA_MAX_BYTES) {
          page.html = Buffer.concat(chunks).toString('utf8');
          finish(null, page);
          res.destroy();
        }
      });
      res.on('end', () => {
        page.html = Buffer.concat(chunks).toString('utf8');
        finish(null, page);
      });
      res.on('error', error => finish(error));
    });
    const timer = setTimeout(() => req.destroy(metadataError('获取网站信息超时', 504)), timeout);
    function finish(error, page) {
      clearTimeout(timer);
      if (error) reject(error); else resolve(page);
    }
    req.on('error', error => finish(error));
  });
}

module.exports = address => fetchSiteMetadata(address, requestMetadataPage);
