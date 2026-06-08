// api/audit-pages.js — Site Audit Agent v3.1
// Audits a batch of URLs — 90+ checks across 8 categories
// Returns detailed results with element paths, line numbers, selectors

export const config = { maxDuration: 55 };

// ─────────────────────────────────────────────────────────────
// FETCH HELPERS
// ─────────────────────────────────────────────────────────────
async function safeFetch(url, opts = {}, ms = 10000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const res = await fetch(url, {
      ...opts,
      signal: c.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditBot/3.1)', ...(opts.headers || {}) },
    });
    clearTimeout(t);
    return res;
  } catch { return null; }
}

async function fetchPage(url) {
  const start = Date.now();
  const res = await safeFetch(url, { redirect: 'manual' }, 12000);
  if (!res) return { ok: false, error: 'Timeout or refused', ttfb: Date.now() - start };

  // Follow redirects manually to detect chains
  let redirectChain = [];
  let current = res;
  let currentUrl = url;
  let hops = 0;

  while ((current.status >= 300 && current.status < 400) && hops < 10) {
    const loc = current.headers.get('location') || '';
    if (!loc) break;
    const nextUrl = new URL(loc, currentUrl).href;
    redirectChain.push({ from: currentUrl, to: nextUrl, status: current.status });
    currentUrl = nextUrl;
    current = await safeFetch(nextUrl, { redirect: 'manual' }, 10000);
    if (!current) break;
    hops++;
  }

  const ttfb = Date.now() - start;
  try {
    const html = await current.text();
    return {
      ok: true, html,
      status: current.status,
      ttfb,
      finalUrl: currentUrl,
      redirectChain,
      headers: Object.fromEntries(current.headers),
    };
  } catch(e) {
    return { ok: false, error: e.message, ttfb };
  }
}

async function headReq(url) {
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 6000);
    const res = await safeFetch(url, { method: 'HEAD', redirect: 'follow' }, 6000);
    if (!res) return { status: 0, size: 0, type: '' };
    return {
      status: res.status,
      size: parseInt(res.headers.get('content-length') || '0'),
      type: res.headers.get('content-type') || '',
      cacheControl: res.headers.get('cache-control') || '',
      xfo: res.headers.get('x-frame-options') || '',
      hsts: res.headers.get('strict-transport-security') || '',
      xcto: res.headers.get('x-content-type-options') || '',
    };
  } catch { return { status: 0, size: 0, type: '' }; }
}

// ─────────────────────────────────────────────────────────────
// ELEMENT PATH HELPERS
// ─────────────────────────────────────────────────────────────
function lineNum(html, idx) { return html.substring(0, idx).split('\n').length; }
function ctx(html, idx, len = 80) {
  return html.substring(Math.max(0, idx - 20), Math.min(html.length, idx + len + 20))
    .replace(/\s+/g, ' ').trim();
}
function sel(attrs, tag) {
  let s = tag;
  const id  = (attrs.match(/\bid=["']([^"']+)["']/) || [])[1];
  const cls = (attrs.match(/\bclass=["']([^"']+)["']/) || [])[1];
  const src = (attrs.match(/\bsrc=["']([^"']{0,50})["']/) || [])[1];
  const href= (attrs.match(/\bhref=["']([^"']{0,50})["']/) || [])[1];
  if (id) s += '#' + id;
  else if (cls) s += '.' + cls.split(' ')[0];
  if (tag === 'img' && src) s += '[src*="' + src.split('/').pop().split('?')[0].slice(0, 30) + '"]';
  if (tag === 'a'  && href) s += '[href="' + href.slice(0, 40) + '"]';
  return s;
}
function locate(html, raw, tag) {
  const idx = html.indexOf(raw);
  if (idx === -1) return null;
  const attrs = raw.replace(new RegExp(`^<${tag}`, 'i'), '').replace(/>[\s\S]*$/, '');
  return { line: lineNum(html, idx), selector: sel(attrs, tag), context: ctx(html, idx, raw.length), raw: raw.slice(0, 120) };
}

// ─────────────────────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────────────────────
function parseImages(html) {
  const imgs = []; const re = /<img([^>]*)>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1], raw = m[0];
    let src = (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '';
    const ds = (a.match(/\bdata-(?:src|lazy-src)=["']([^"']+)["']/) || [])[1] || '';
    imgs.push({
      raw, src: src || ds,
      hasAlt: /\balt=/.test(a), altVal: (a.match(/\balt=["']([^"']*)["']/) || [, null])[1],
      w: (a.match(/\bwidth=["']?(\d+)/) || [])[1] || '',
      h: (a.match(/\bheight=["']?(\d+)/) || [])[1] || '',
      loading: (a.match(/\bloading=["']([^"']+)["']/) || [])[1] || '',
      fetchPriority: (a.match(/\bfetchpriority=["']([^"']+)["']/) || [])[1] || '',
      srcset: (a.match(/\bsrcset=["']([^"']+)["']/) || [])[1] || '',
      emptySrc: !src && !ds,
    });
  }
  return imgs;
}

function parseLinks(html) {
  const links = []; const re = /<a([^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1], raw = m[0], text = m[2].replace(/<[^>]+>/g, '').trim();
    links.push({
      raw, href: (a.match(/\bhref=["']([^"']+)["']/) || [])[1] || '',
      text, aria: (a.match(/\baria-label=["']([^"']+)["']/) || [])[1] || '',
      rel: (a.match(/\brel=["']([^"']+)["']/) || [])[1] || '',
      target: (a.match(/\btarget=["']([^"']+)["']/) || [])[1] || '',
    });
  }
  return links;
}

function parseHeadings(html) {
  const h = []; const re = /<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    h.push({ level: m[1], text: m[3].replace(/<[^>]+>/g, '').trim(), raw: m[0] });
  }
  return h;
}

function parseScripts(html) {
  const s = []; const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1], code = m[2] || '';
    const src = (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '';
    s.push({ src, defer: /\bdefer\b/i.test(a), async: /\basync\b/i.test(a), type: (a.match(/\btype=["']([^"']+)["']/) || [])[1] || '', inline: !src, code: code.slice(0, 300) });
  }
  return s;
}

function parseStyles(html) {
  const s = []; const re = /<link([^>]*)>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1];
    if (!/rel=["']stylesheet["']/i.test(a)) continue;
    s.push({ href: (a.match(/\bhref=["']([^"']+)["']/) || [])[1] || '', media: (a.match(/\bmedia=["']([^"']+)["']/) || [])[1] || 'all' });
  }
  return s;
}

function parseIframes(html) {
  const f = []; const re = /<iframe([^>]*)>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1], raw = m[0];
    f.push({ raw, src: (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '', title: (a.match(/\btitle=["']([^"']+)["']/) || [])[1] || '' });
  }
  return f;
}

function parseMeta(html) {
  const get = (rx) => { const m = html.match(rx); return m ? m[1].trim() : ''; };
  const getAll = (rx) => { const r = []; let m; while ((m = rx.exec(html)) !== null) r.push(m[1]); return r; };
  return {
    title:       get(/<title[^>]*>([\s\S]*?)<\/title>/i),
    desc:        get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) || get(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i),
    robots:      get(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']+)["']/i) || 'index,follow',
    canonical:   get(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i),
    ogTitle:     get(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i),
    ogDesc:      get(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i),
    ogImage:     get(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
    ogImgW:      parseInt(get(/<meta[^>]*property=["']og:image:width["'][^>]*content=["']([^"']+)["']/i) || '0'),
    twitterCard: get(/<meta[^>]*name=["']twitter:card["'][^>]*content=["']([^"']+)["']/i),
    viewport:    get(/<meta[^>]*name=["']viewport["'][^>]*content=["']([^"']+)["']/i),
    generator:   get(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i),
    lang:        get(/<html[^>]*lang=["']([^"']+)["']/i),
    charset:     (/<meta[^>]*charset/i.test(html) ? 'utf-8' : ''),
    favicon:     get(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i) || get(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'](?:shortcut )?icon["']/i),
    appleTouchIcon: get(/<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i),
    jsonLd:      getAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
    inlineStyles: (html.match(/\bstyle=["'][^"']+["']/gi) || []).length,
    domElements:  (html.match(/<[a-z][^>]*>/gi) || []).length,
    htmlSizeKB:   Math.round(html.length / 1024),
  };
}

// ─────────────────────────────────────────────────────────────
// DUMMY / DEV CONTENT PATTERNS
// ─────────────────────────────────────────────────────────────
const DUMMY = [
  { p: /lorem\s+ipsum/i,              l: 'Lorem ipsum placeholder text' },
  { p: /dolor\s+sit\s+amet/i,         l: 'Lorem ipsum (dolor sit amet)' },
  { p: /\btest@test\.com\b/i,         l: 'Placeholder email: test@test.com' },
  { p: /\badmin@example\.com\b/i,     l: 'Placeholder email: admin@example.com' },
  { p: /\bjohn\.doe@/i,               l: 'Placeholder email: john.doe@...' },
  { p: /\bJohn\s+Doe\b/,              l: 'Placeholder name: John Doe' },
  { p: /\bJane\s+Doe\b/,              l: 'Placeholder name: Jane Doe' },
  { p: /\bTest\s+User\b/i,            l: 'Placeholder name: Test User' },
  { p: /123\s+Fake\s+Street/i,        l: 'Placeholder address: 123 Fake Street' },
  { p: /\(555\)\s*\d{3}-\d{4}/,       l: 'Placeholder phone: (555) format' },
  { p: /123-456-7890/,                l: 'Placeholder phone: 123-456-7890' },
  { p: /placeholder\s+text/i,         l: '"Placeholder text" found in content' },
  { p: /coming\s+soon/i,              l: '"Coming soon" — content not ready' },
  { p: /under\s+construction/i,       l: '"Under construction" found' },
  { p: /\bTBD\b|\bTBA\b/,             l: 'TBD/TBA placeholder in content' },
  { p: /sample\s+(?:text|content)/i,  l: 'Sample text/content found' },
  { p: /dummy\s+(?:text|content)/i,   l: 'Dummy text/content found' },
];

const DEV_PATTERNS = [
  /https?:\/\/localhost/i,
  /https?:\/\/127\.0\.0\.1/,
  /https?:\/\/(?:[\w-]+\.)?(?:local|dev|test|staging|stage)\b/i,
  /https?:\/\/[\w-]+\.ardentirdev\.us/i,
  /https?:\/\/[\w-]+\.wpengine\.com/i,
  /https?:\/\/[\w-]+\.kinsta\.cloud/i,
  /https?:\/\/[\w-]+\.pantheonsite\.io/i,
  /https?:\/\/[\w-]+\.flywheelsites\.com/i,
  /https?:\/\/[\w-]+\.myftpupload\.com/i,
  /https?:\/\/[\w-]+\.cloudwaysapps\.com/i,
  /https?:\/\/[\w-]+\.azurewebsites\.net/i,
];

function findDevUrls(html, pageUrl) {
  const found = []; const base = new URL(pageUrl);
  const re = /(?:href|src|action|content)=["']([^"']+)["']/gi; let m;
  while ((m = re.exec(html)) !== null) {
    for (const p of DEV_PATTERNS) {
      if (p.test(m[1])) {
        try { if (new URL(m[1]).hostname !== base.hostname) found.push({ url: m[1].slice(0, 100), attr: m[0].slice(0, 60), line: lineNum(html, html.indexOf(m[0])), context: ctx(html, html.indexOf(m[0]), 80) }); }
        catch {}
        break;
      }
    }
  }
  return found;
}

function findDummyContent(html) {
  const clean = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const text = clean.replace(/<[^>]+>/g, ' ');
  const found = [];
  for (const { p, l } of DUMMY) {
    const m = p.exec(text);
    if (m) found.push({ label: l, context: text.substring(Math.max(0, text.indexOf(m[0]) - 30), text.indexOf(m[0]) + m[0].length + 30).trim() });
  }
  return found;
}

// ─────────────────────────────────────────────────────────────
// WORD COUNT
// ─────────────────────────────────────────────────────────────
function wordCount(html) {
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return clean.split(' ').filter(w => w.length > 2).length;
}

// ─────────────────────────────────────────────────────────────
// SCHEMA / JSON-LD CHECKER
// ─────────────────────────────────────────────────────────────
function checkSchemas(jsonLdBlocks) {
  const schemas = [];
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block.trim());
      const items = Array.isArray(data['@graph']) ? data['@graph'] : [data];
      for (const item of items) {
        if (item['@type']) schemas.push({ type: item['@type'], hasName: !!item.name, hasUrl: !!item.url, hasDesc: !!item.description, hasImage: !!item.image, raw: JSON.stringify(item).slice(0, 200) });
      }
    } catch {}
  }
  return schemas;
}

// ─────────────────────────────────────────────────────────────
// IMAGE FILE AUDIT
// ─────────────────────────────────────────────────────────────
async function auditImageFiles(images, baseUrl) {
  const candidates = images.filter(i => i.src && !i.src.startsWith('data:') && /\.(jpg|jpeg|png|gif|webp|avif)(\?|$)/i.test(i.src)).slice(0, 12);
  return Promise.all(candidates.map(async (img) => {
    let abs = img.src;
    try { abs = new URL(img.src, baseUrl).href; } catch {}
    const meta = await headReq(abs);
    const isWebP = /webp/i.test(meta.type) || /\.webp(\?|$)/i.test(img.src);
    const isAvif = /avif/i.test(meta.type) || /\.avif(\?|$)/i.test(img.src);
    return {
      src: abs,
      filename: abs.split('/').pop().split('?')[0].slice(0, 60),
      sizeKB: meta.size ? Math.round(meta.size / 1024) : 0,
      status: meta.status,
      isWebP, isAvif, isModern: isWebP || isAvif,
      hasAlt: img.hasAlt, altVal: img.altVal,
      isLazy: img.loading === 'lazy',
      hasDimensions: !!(img.w && img.h),
      hasSrcset: !!img.srcset,
      raw: img.raw.slice(0, 100),
    };
  }));
}

// ─────────────────────────────────────────────────────────────
// BROKEN LINKS + IMAGES (sampled)
// ─────────────────────────────────────────────────────────────
async function checkBrokenLinks(links, baseUrl, max = 15) {
  const base = new URL(baseUrl);
  const candidates = links.filter(l => {
    try {
      const u = new URL(l.href, baseUrl);
      return u.hostname === base.hostname && l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript:') && !l.href.startsWith('mailto:') && !l.href.startsWith('tel:');
    } catch { return false; }
  }).slice(0, max);

  const broken = [];
  await Promise.all(candidates.map(async (link) => {
    try {
      const abs = new URL(link.href, baseUrl).href;
      const r = await headReq(abs);
      if (r.status === 404 || r.status === 410 || r.status === 0) {
        const loc = locate(link.raw, link.raw, 'a');
        broken.push({ url: abs, status: r.status || 'timeout', text: link.text.slice(0, 50), raw: link.raw.slice(0, 100), line: loc?.line });
      }
    } catch {}
  }));
  return broken;
}

// ─────────────────────────────────────────────────────────────
// WORDPRESS SECURITY CHECKS
// ─────────────────────────────────────────────────────────────
async function checkWPSecurity(origin) {
  const checks = [
    { path: '/xmlrpc.php',  label: 'xmlrpc.php accessible',  severity: 'high',   fix: 'Disable XML-RPC via a security plugin (Wordfence, iThemes Security) or add to .htaccess: <Files xmlrpc.php> deny from all </Files>. XML-RPC is a common brute force attack vector.' },
    { path: '/readme.html', label: 'readme.html exposes WordPress version', severity: 'medium', fix: 'Delete readme.html from your server root. It exposes your WordPress version to attackers.' },
    { path: '/license.txt', label: 'license.txt accessible', severity: 'low',    fix: 'Delete license.txt from server root — it is not needed and exposes WordPress.' },
    { path: '/?author=1',   label: 'Username enumeration via ?author=1', severity: 'medium', fix: 'Block author scans via a security plugin or add rewrite rule to prevent ?author= enumeration. Attackers use this to find admin usernames.' },
  ];

  const results = [];
  await Promise.all(checks.map(async (check) => {
    const r = await headReq(origin + check.path);
    if (r.status === 200) results.push(check);
  }));
  return results;
}

// ─────────────────────────────────────────────────────────────
// SECURITY HEADERS CHECK
// ─────────────────────────────────────────────────────────────
function checkSecurityHeaders(headers) {
  const issues = [];
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

  if (!h['strict-transport-security'] && !h['hsts'])
    issues.push({ header: 'Strict-Transport-Security (HSTS)', severity: 'medium', fix: 'Add HSTS header to force HTTPS. In Apache: Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains". Or enable via Cloudflare.' });

  if (!h['x-content-type-options'])
    issues.push({ header: 'X-Content-Type-Options', severity: 'low', fix: 'Add: X-Content-Type-Options: nosniff — prevents MIME type sniffing attacks. Add to server config or via a security plugin.' });

  if (!h['x-frame-options'] && !h['content-security-policy'])
    issues.push({ header: 'X-Frame-Options', severity: 'low', fix: 'Add: X-Frame-Options: SAMEORIGIN — prevents clickjacking. Or use Content-Security-Policy: frame-ancestors \'self\'.' });

  if (!h['referrer-policy'])
    issues.push({ header: 'Referrer-Policy', severity: 'low', fix: 'Add: Referrer-Policy: strict-origin-when-cross-origin — controls how much referrer information is sent.' });

  return issues;
}

// ─────────────────────────────────────────────────────────────
// MAIN AUDIT FUNCTION — runs all 90+ checks
// ─────────────────────────────────────────────────────────────
async function auditPage(url, html, status, ttfb, headers, redirectChain, imgData, brokenLinks, wpSecurity, siteBaseUrl) {
  const issues  = [];
  const meta    = parseMeta(html);
  const images  = parseImages(html);
  const links   = parseLinks(html);
  const headings= parseHeadings(html);
  const scripts = parseScripts(html);
  const styles  = parseStyles(html);
  const iframes = parseIframes(html);
  const base    = new URL(siteBaseUrl || url);
  const allCode = scripts.map(s => s.src + ' ' + s.code).join(' ') + html.slice(0, 12000);

  const push = (cat, sev, title, detail, fix, location = null) =>
    issues.push({ category: cat, severity: sev, title, detail, fix, location });

  // ── SECURITY ─────────────────────────────────────────────
  if (url.startsWith('http://'))
    push('Security', 'critical', 'Page not using HTTPS', `Served over HTTP — unencrypted.`, 'Install SSL certificate. Add HTTP→HTTPS redirect in .htaccess. Cloudflare free tier provides automatic SSL.');

  if (status === 0 || status >= 500)
    push('Security', 'critical', `Server error HTTP ${status || 'timeout'}`, `URL: ${url}`, 'Check server error logs. Fix PHP/server error.');

  if (status === 403)
    push('Security', 'high', 'Page returns 403 Forbidden', `URL: ${url}`, 'Check file/folder permissions on the server.');

  if (status === 404)
    push('SEO', 'critical', 'Page returns 404 Not Found', `URL: ${url}`, 'Fix the URL or set up a 301 redirect to the correct destination.');

  // Mixed content
  if (url.startsWith('https://')) {
    const httpAssets = [];
    const ar = /(?:src|href|action)=["'](http:\/\/[^"']+)["']/gi; let m;
    while ((m = ar.exec(html)) !== null) {
      try { if (new URL(m[1]).hostname !== base.hostname) httpAssets.push(m[1].slice(0, 80)); } catch {}
    }
    if (httpAssets.length > 0)
      push('Security', 'high', `Mixed content — ${httpAssets.length} HTTP asset(s) on HTTPS page`,
        httpAssets.slice(0, 3).join(', '),
        'Replace all http:// asset URLs with https://. Use Better Search Replace plugin to find and replace all occurrences in the database.',
        { context: httpAssets[0], selector: 'src/href attributes with http://', raw: httpAssets[0] });
  }

  // Redirect chain
  if (redirectChain && redirectChain.length > 1)
    push('SEO', 'high', `Redirect chain: ${redirectChain.length} hops`,
      redirectChain.map(r => `${r.status}: ${r.from.replace(siteBaseUrl,'')} → ${r.to.replace(siteBaseUrl,'')}`).join(' → '),
      'Fix redirect chains — each hop adds latency and dilutes PageRank. Update links to point directly to the final URL.');

  if (redirectChain && redirectChain.length === 1 && redirectChain[0].status === 302)
    push('SEO', 'medium', '302 temporary redirect (should be 301)',
      `${redirectChain[0].from} → ${redirectChain[0].to}`,
      'Change 302 to 301 permanent redirect. 302s do not pass PageRank and tell Google the move is temporary.');

  // Security headers
  const secHeaderIssues = checkSecurityHeaders(headers);
  for (const shi of secHeaderIssues)
    push('Security', shi.severity, `Missing security header: ${shi.header}`, `Header "${shi.header}" not set on this page.`, shi.fix);

  // WP Security holes
  if (wpSecurity) {
    for (const wp of wpSecurity)
      push('Security', wp.severity, `WordPress: ${wp.label}`, `${base.origin}${wp.path} returns 200 OK`, wp.fix,
        { selector: wp.path, context: `${base.origin}${wp.path}`, raw: `HTTP 200 — should return 403 or 404` });
  }

  // WordPress version exposed
  const wpVer = meta.generator.match(/WordPress\s+([\d.]+)/i);
  if (wpVer)
    push('Security', 'low', `WordPress version exposed: ${wpVer[1]}`,
      `meta generator: "${meta.generator}"`,
      'Remove WP version from meta generator. Add to functions.php: remove_action(\'wp_head\', \'wp_generator\'); — prevents attackers knowing which version to target.',
      { line: lineNum(html, html.indexOf('generator')), selector: 'meta[name="generator"]', context: `<meta name="generator" content="${meta.generator}">`, raw: meta.generator });

  // wp-admin URL
  const wpadminR = await headReq(base.origin + '/wp-admin/');
  if (wpadminR.status === 200 || wpadminR.status === 302)
    push('Security', 'medium', 'Default /wp-admin/ URL is accessible',
      `${base.origin}/wp-admin/ returns ${wpadminR.status}`,
      'Hide admin URL using WPS Hide Login or Perfmatters plugin. Change to something unique like /manage/ or /portal/.');

  // HTTP→HTTPS redirect
  if (url.startsWith('https://')) {
    const httpR = await headReq(url.replace('https://', 'http://'));
    if (httpR.status === 200)
      push('Security', 'high', 'HTTP version returns 200 — no HTTPS redirect',
        `${url.replace('https://', 'http://')} returns 200 instead of 301 to HTTPS`,
        'Add redirect in .htaccess: RewriteEngine On / RewriteCond %{HTTPS} off / RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]');
  }

  // ── SEO ──────────────────────────────────────────────────
  if (/noindex/i.test(meta.robots)) {
    const idx = html.search(/name=["']robots["'][^>]*content=["'][^"']*noindex/i);
    push('SEO', 'critical', 'Page set to noindex — invisible to Google',
      `meta robots: "${meta.robots}"`,
      'Remove noindex. WordPress: Settings → Reading → uncheck "Discourage search engines". Yoast/RankMath → set to Index.',
      { line: idx >= 0 ? lineNum(html, idx) : null, selector: 'meta[name="robots"]', context: idx >= 0 ? ctx(html, idx, 80) : '', raw: `<meta name="robots" content="${meta.robots}">` });
  }

  if (!meta.title)
    push('SEO', 'critical', 'Missing <title> tag', 'No title tag found.',
      'Add a unique 50–60 char title. Yoast/RankMath → edit page → SEO Title field.',
      { line: null, selector: 'head > title', context: '(missing)', raw: '(missing)' });
  else if (meta.title.length < 30) {
    const i = html.indexOf('<title');
    push('SEO', 'medium', `Title too short — ${meta.title.length} chars`, `"${meta.title}"`,
      'Expand to 50–60 characters with primary keyword + brand name.',
      { line: i >= 0 ? lineNum(html, i) : null, selector: 'head > title', context: `<title>${meta.title}</title>`, raw: `<title>${meta.title}</title>` });
  } else if (meta.title.length > 65) {
    const i = html.indexOf('<title');
    push('SEO', 'low', `Title too long — ${meta.title.length} chars`, `"${meta.title.slice(0, 70)}…"`,
      'Shorten to under 60 characters.',
      { line: i >= 0 ? lineNum(html, i) : null, selector: 'head > title', context: `<title>${meta.title.slice(0, 60)}</title>`, raw: meta.title });
  }

  if (!meta.desc)
    push('SEO', 'high', 'Missing meta description', 'No meta description.',
      'Add 150–160 char description in Yoast/RankMath → Description field.',
      { line: null, selector: 'meta[name="description"]', context: '(missing)', raw: '(missing)' });
  else if (meta.desc.length < 70)
    push('SEO', 'medium', `Meta description too short — ${meta.desc.length} chars`, meta.desc.slice(0, 100), 'Expand to 150–160 characters.');
  else if (meta.desc.length > 165)
    push('SEO', 'low', `Meta description too long — ${meta.desc.length} chars`, meta.desc.slice(0, 100) + '…', 'Shorten to 155 characters.');

  if (!meta.canonical)
    push('SEO', 'medium', 'Missing canonical tag', 'No rel="canonical" link.',
      'Add canonical to prevent duplicate content. Yoast/RankMath adds this automatically — verify it is enabled.',
      { line: null, selector: 'link[rel="canonical"]', context: '(missing)', raw: '(missing)' });
  else {
    try {
      const ch = new URL(meta.canonical).hostname;
      if (ch !== base.hostname) {
        const i = html.indexOf('canonical');
        push('SEO', 'high', `Canonical points to wrong domain: ${ch}`, `canonical: "${meta.canonical}"`,
          'Update canonical to point to this site. Check Yoast/RankMath settings.',
          { line: i >= 0 ? lineNum(html, i) : null, selector: 'link[rel="canonical"]', context: `<link rel="canonical" href="${meta.canonical}">`, raw: meta.canonical });
      }
    } catch {}
  }

  if (!meta.ogImage)
    push('SEO', 'medium', 'Missing og:image', 'No social preview image.',
      'Add 1200×630px og:image in Yoast/RankMath → Social tab.',
      { line: null, selector: 'meta[property="og:image"]', context: '(missing)', raw: '(missing)' });
  else if (meta.ogImgW > 1600)
    push('SEO', 'medium', `og:image oversized — ${meta.ogImgW}px wide`, `Current: ${meta.ogImgW}px. Max recommended: 1200px.`, 'Resize og:image to 1200×630px.');

  if (!meta.lang) {
    push('SEO', 'medium', 'Missing lang attribute on <html>',
      'Screen readers and search engines cannot detect page language.',
      'Add lang: <html lang="en">. WordPress: Settings → General → Site Language.',
      { line: 1, selector: 'html[lang]', context: html.slice(0, 60), raw: html.slice(0, 60) });
  }

  if (!meta.viewport)
    push('SEO', 'high', 'Missing viewport meta tag', 'Mobile rendering broken.',
      'Add: <meta name="viewport" content="width=device-width, initial-scale=1">',
      { line: null, selector: 'meta[name="viewport"]', context: '(missing)', raw: '(missing)' });

  if (!meta.charset)
    push('SEO', 'low', 'Missing charset declaration', 'No charset meta tag.',
      'Add as first tag in <head>: <meta charset="UTF-8">');

  if (!meta.favicon)
    push('SEO', 'medium', 'Missing favicon', 'No favicon link tag.',
      'Add: <link rel="icon" href="/favicon.ico" sizes="32x32">. WordPress: Appearance → Customize → Site Identity → Site Icon.');

  if (!meta.appleTouchIcon)
    push('SEO', 'low', 'Missing Apple touch icon', 'No apple-touch-icon.',
      'Add: <link rel="apple-touch-icon" href="/apple-touch-icon.png"> (180×180px PNG).');

  if (!meta.ogTitle) push('SEO', 'low', 'Missing og:title', 'No Open Graph title.', 'Add og:title in Yoast/RankMath → Social tab.');
  if (!meta.twitterCard) push('SEO', 'low', 'Missing twitter:card', 'No Twitter/X card.', 'Enable in Yoast/RankMath → Social → Twitter.');

  // H1 checks
  const h1s = headings.filter(h => h.level === 'h1');
  if (h1s.length === 0)
    push('SEO', 'high', 'No H1 heading', 'Page needs exactly one H1.',
      'Add H1 in Elementor → click main heading → Content → HTML Tag → H1.',
      { line: null, selector: 'h1', context: '(none found)', raw: '(missing)' });
  else if (h1s.length > 1) {
    const loc = locate(html, h1s[1].raw, 'h1');
    push('SEO', 'medium', `${h1s.length} H1 tags (only 1 allowed)`,
      h1s.map(h => `"${h.text.slice(0, 40)}"`).join(', '),
      'Keep one H1. Change extras to H2/H3 in page builder.',
      loc ? { ...loc, selector: 'h1:nth-of-type(2)' } : null);
  }

  // Heading order
  let prev = 0;
  for (const h of headings) {
    const lvl = parseInt(h.level[1]);
    if (h.text.length === 0) {
      const loc = locate(html, h.raw, h.level);
      push('SEO', 'medium', `Empty ${h.level.toUpperCase()} heading tag`,
        `An empty <${h.level}></${h.level}> tag found — adds no SEO value and confuses screen readers.`,
        `Remove or fill the empty heading tag. Search in Elementor for empty heading widgets.`,
        loc || null);
    }
    if (prev > 0 && lvl > prev + 1) {
      const loc = locate(html, h.raw, h.level);
      push('Accessibility', 'medium', `Heading level skipped: H${prev} → H${lvl}`,
        `"${h.text.slice(0, 60)}"`, `Use sequential levels (H1→H2→H3). Change this to H${prev + 1}.`,
        loc ? { ...loc, selector: h.level } : null);
      break;
    }
    prev = lvl;
  }

  // Generic link text
  const generic = ['learn more', 'read more', 'click here', 'find out more', 'more', 'here', 'link', 'this'];
  const badLinks = links.filter(l => generic.includes((l.text || '').toLowerCase().trim()) && !l.aria);
  if (badLinks.length > 0) {
    const loc = locate(html, badLinks[0].raw, 'a');
    push('SEO', 'high', `${badLinks.length} non-descriptive link(s)`,
      `Links with generic text: "${badLinks.slice(0, 4).map(l => l.text).join('", "')}"`,
      'Replace with descriptive text. Add aria-label if text cannot change.',
      loc || null);
  }

  // Hash-only links
  const hashLinks = links.filter(l => l.href === '#' || l.href === 'javascript:void(0)' || l.href === 'javascript:;');
  if (hashLinks.length > 2)
    push('SEO', 'low', `${hashLinks.length} empty/hash-only links`, 'Links with href="#" go nowhere.', 'Add proper href values or remove these links.');

  // External links without noopener
  const extNoOpener = links.filter(l => {
    try {
      return new URL(l.href).hostname !== base.hostname && l.target === '_blank' && !l.rel.includes('noopener');
    } catch { return false; }
  });
  if (extNoOpener.length > 0) {
    const loc = locate(html, extNoOpener[0].raw, 'a');
    push('Security', 'medium', `${extNoOpener.length} external link(s) open in new tab without noopener`,
      extNoOpener.slice(0, 3).map(l => l.href.slice(0, 60)).join(', '),
      'Add rel="noopener noreferrer" to all target="_blank" links. Prevents the opened page accessing window.opener.',
      loc || null);
  }

  // www/non-www — only check on homepage (first page) to avoid duplicate issues per page
  if (url === siteBaseUrl || url.replace(/\/$/, '') === siteBaseUrl.replace(/\/$/, '')) {
    const altUrl = url.includes('://www.') ? url.replace('://www.', '://') : url.replace('://', '://www.');
    try {
      const altR = await headReq(altUrl);
      if (altR.status === 200)
        push('SEO', 'medium', 'Both www and non-www versions accessible — no redirect',
          `Both ${url} and ${altUrl} return 200. Pick one as canonical.`,
          'Set up a 301 redirect: one version should redirect to the other. WordPress: Settings → General → WordPress Address and Site Address must match. Add redirect in .htaccess or Cloudflare.');
    } catch {}
  }

  // Schema.org
  const schemas = checkSchemas(meta.jsonLd);
  if (schemas.length === 0) {
    push('SEO', 'medium', 'No structured data (JSON-LD / Schema.org)',
      'No JSON-LD structured data found on this page.',
      'Add Schema.org markup. For WordPress: Yoast SEO adds WebPage/Organization automatically. For blog posts add Article schema. For local businesses add LocalBusiness. Use Schema Pro plugin for custom types.');
  } else {
    for (const schema of schemas) {
      const missing = [];
      if (!schema.hasName && ['Organization', 'LocalBusiness', 'Person', 'Article', 'Product'].includes(schema.type)) missing.push('name');
      if (!schema.hasDesc && ['Article', 'Product', 'FAQ'].includes(schema.type)) missing.push('description');
      if (!schema.hasImage && ['Article', 'Product', 'Recipe'].includes(schema.type)) missing.push('image');
      if (missing.length > 0)
        push('SEO', 'low', `Schema.org ${schema.type} missing fields: ${missing.join(', ')}`,
          `Found ${schema.type} schema but missing required/recommended fields: ${missing.join(', ')}`,
          `Add ${missing.join(', ')} to your ${schema.type} schema. Use Google's Rich Results Test to validate.`);
    }
  }

  // Dev URLs
  const devUrls = findDevUrls(html, url);
  if (devUrls.length > 0)
    push('SEO', 'critical', `${devUrls.length} staging/dev URL(s) in page source`,
      devUrls.slice(0, 3).map(d => d.url).join(', '),
      'Run Search & Replace plugin. Use Better Search Replace or WP-CLI: wp search-replace "staging.example.com" "example.com" --all-tables',
      { line: devUrls[0].line, selector: devUrls[0].attr, context: devUrls[0].context, raw: devUrls[0].url });

  // Dummy content
  const dummy = findDummyContent(html);
  for (const d of dummy.slice(0, 3))
    push('Content', 'high', `Dummy content: ${d.label}`, `Found: "${d.context.slice(0, 100)}"`, 'Replace all placeholder content with real copy before launch.');

  // Thin content
  const words = wordCount(html);
  if (words < 100 && status === 200 && !url.includes('/thank') && !url.includes('/confirm'))
    push('Content', 'medium', `Thin content — ${words} words`,
      `Page body contains only ~${words} words. Google may consider this low-quality content.`,
      'Add meaningful content. Aim for at least 300 words for informational pages, 500+ for blog posts. Thin pages can harm overall domain quality score.');

  // Duplicate title check (flagged in summary, not per-page)
  // (handled in main handler below)

  // ── PERFORMANCE ──────────────────────────────────────────
  if (ttfb > 1800)
    push('Performance', 'critical', `Slow TTFB: ${ttfb}ms — page not cached`,
      'Every visitor triggers full PHP render.',
      'Install LiteSpeed Cache or WP Rocket. Enable page cache + mobile cache. TTFB should be <200ms with cache.');
  else if (ttfb > 800)
    push('Performance', 'high', `TTFB elevated: ${ttfb}ms`, 'Google "Good" is under 800ms.', 'Enable caching plugin. Check server plan.');

  const cc = headers['cache-control'] || headers['Cache-Control'] || '';
  if (!cc || cc.includes('no-store'))
    push('Performance', 'high', 'No browser cache headers', `Cache-Control: "${cc || 'missing'}"`,
      'LiteSpeed Cache → Browser Cache TTL → 31557600. WP Rocket → Cache → Browser Caching.');

  // Render-blocking CSS
  const blockCSS = styles.filter(s => !s.media || s.media === 'all' || s.media === 'screen');
  if (blockCSS.length > 8)
    push('Performance', 'critical', `${blockCSS.length} render-blocking CSS files`,
      blockCSS.slice(0, 3).map(s => s.href.split('/').pop()).join(', ') + '…',
      'Elementor: Settings → Experiments → Improved CSS Loading. LiteSpeed: CSS Minify + Combine + Critical CSS via QUIC.cloud.');
  else if (blockCSS.length > 4)
    push('Performance', 'high', `${blockCSS.length} render-blocking CSS files`, '', 'LiteSpeed Cache → CSS Combine + Minify.');

  // Unminified JS
  const unminJS = scripts.filter(s => s.src && !s.src.includes('.min.') && !s.src.includes('min.js') && s.src.includes('.js') && !s.src.includes('googleapis') && !s.src.includes('googletagmanager'));
  if (unminJS.length > 2)
    push('Performance', 'medium', `${unminJS.length} unminified JavaScript file(s)`,
      unminJS.slice(0, 3).map(s => s.src.split('/').pop()).join(', '),
      'Minify JS files. LiteSpeed Cache → JS Minify → ON. WP Rocket → Minify JS. Or use the .min.js version if available.');

  // Unminified CSS
  const unminCSS = styles.filter(s => s.href && !s.href.includes('.min.') && !s.href.includes('min.css') && s.href.includes('.css'));
  if (unminCSS.length > 2)
    push('Performance', 'medium', `${unminCSS.length} unminified CSS file(s)`,
      unminCSS.slice(0, 3).map(s => s.href.split('/').pop()).join(', '),
      'Minify CSS. LiteSpeed Cache → CSS Minify → ON. WP Rocket → Minify CSS.');

  // Google Fonts external
  const gFonts = styles.filter(s => s.href.includes('fonts.googleapis.com') || s.href.includes('fonts.gstatic.com'));
  if (gFonts.length > 0) {
    const i = html.indexOf('fonts.googleapis.com');
    push('Performance', 'medium', `Google Fonts loaded externally — ${gFonts.length} request(s)`,
      gFonts.map(s => s.href.split('family=')[1]?.split('&')[0] || s.href.slice(0, 60)).join(', '),
      'Self-host Google Fonts using OMGF plugin (free). Eliminates 2 DNS lookups + 2 network requests per page. Saves 200–400ms on FCP.',
      { line: i >= 0 ? lineNum(html, i) : null, selector: 'link[href*="fonts.googleapis.com"]', context: ctx(html, i, 80), raw: gFonts[0]?.href });
  }

  // Sync scripts in head
  const headHtml = html.split('</head>')[0] || '';
  const syncHead = parseScripts(headHtml).filter(s => s.src && !s.defer && !s.async && !s.type);
  if (syncHead.length > 0) {
    const i = html.indexOf(syncHead[0].src);
    push('Performance', 'critical', `${syncHead.length} synchronous script(s) blocking <head>`,
      syncHead.slice(0, 3).map(s => s.src.split('/').pop()).join(', '),
      'Add defer to all non-critical scripts. LiteSpeed Cache → JS Defer → ON. Exclude: jquery.min.js, elementor-frontend.min.js.',
      { line: i >= 0 ? lineNum(html, i) : null, selector: `script[src*="${syncHead[0].src.split('/').pop()}"]`, context: `<script src="${syncHead[0].src}">`, raw: `<script src="${syncHead[0].src}">` });
  }

  // Video embeds
  const videoIf = iframes.filter(i => /vimeo|youtube|youtu\.be/i.test(i.src));
  if (videoIf.length > 0) {
    const loc = locate(html, videoIf[0].raw, 'iframe');
    push('Performance', 'critical', `${videoIf.length} video embed(s) loading on page load`,
      videoIf.map(i => { try { return new URL(i.src).hostname; } catch { return i.src.slice(0, 40); } }).join(', '),
      'LiteSpeed Cache → Lazy Load Iframes → ON. Or show thumbnail + play button and inject iframe on click only.',
      loc || null);
  }

  // Third-party scripts
  const tpScripts = scripts.filter(s => { try { return s.src && new URL(s.src).hostname !== base.hostname; } catch { return false; }});
  const slowTp = tpScripts.filter(s => /facebook|fbevents|pixel|analytics|hotjar|intercom|drift|hubspot|talkfurther|panoskin|tourbuilder|crisp|tidio|zendesk/i.test(s.src));
  if (slowTp.length > 2)
    push('Performance', 'high', `${slowTp.length} third-party tracking scripts`,
      slowTp.slice(0, 4).map(s => { try { return new URL(s.src).hostname; } catch { return s.src.slice(0, 40); }}).join(', '),
      'Consolidate all tracking via GTM. Remove standalone GA, FB Pixel plugins. Fire from GTM only.');

  // Dead UA
  if (/UA-\d{6,}-\d/.test(allCode))
    push('Performance', 'high', 'Dead Universal Analytics (UA-) still firing',
      'UA shut down March 2024. Wastes ~50ms every page.',
      'Remove UA tag from GTM immediately. Verify GA4 (G-XXXXXXXX) is collecting in Analytics → Realtime.');

  // Elementor
  if (/css_print_method-external/i.test(meta.generator))
    push('Performance', 'high', 'Elementor: css_print_method-external',
      'CSS loaded as separate blocking files.',
      'Elementor → Settings → Experiments → Improved CSS Loading → ON → Regenerate Files & Data → Flush cache.');

  if (/font_display-auto/i.test(meta.generator))
    push('Performance', 'medium', 'Elementor: font_display-auto',
      'Text invisible while fonts load — hurts FCP.',
      'Elementor → Settings → Performance → Font Display → Swap.');

  // Hero preload
  if (!/<link[^>]*rel=["']preload["'][^>]*as=["']image["']/i.test(html) && images.length > 0)
    push('Performance', 'high', 'No hero image preload tag in <head>',
      'LCP hero image discovered late after CSS is parsed.',
      'Add to <head>: <link rel="preload" as="image" fetchpriority="high" href="HERO-URL">. Elementor: Site Settings → Custom Code → Head.',
      { line: null, selector: 'link[rel="preload"][as="image"]', context: '(missing)', raw: '(missing)' });

  // DNS prefetch/preconnect
  const hasPreconnect = /<link[^>]*rel=["']preconnect["']/i.test(html);
  const hasDNSPrefetch = /<link[^>]*rel=["']dns-prefetch["']/i.test(html);
  if (!hasPreconnect && !hasDNSPrefetch && tpScripts.length > 0)
    push('Performance', 'low', 'No preconnect or dns-prefetch hints for third-party domains',
      `${tpScripts.length} third-party scripts load but no preconnect hints found.`,
      'Add preconnect for key third-party domains in <head>: <link rel="preconnect" href="https://fonts.googleapis.com">. LiteSpeed Cache → DNS Prefetch settings.');

  // DOM size
  if (meta.domElements > 1500)
    push('Performance', 'medium', `Large DOM: ${meta.domElements} HTML elements`,
      `Page has ${meta.domElements} elements. Google recommends under 1500.`,
      'Reduce DOM size by: removing hidden/duplicate navigation elements, simplifying Elementor template nesting, removing unused widgets and sections.');

  // Excessive inline styles
  if (meta.inlineStyles > 100)
    push('Performance', 'low', `${meta.inlineStyles} inline style attributes`,
      'Excessive inline styles bloat HTML and prevent browser CSS caching.',
      'Move inline styles to external stylesheets. In Elementor this is expected — but avoid adding style="" manually in Custom CSS fields.');

  // Page weight
  if (meta.htmlSizeKB > 200)
    push('Performance', 'medium', `Large page HTML: ${meta.htmlSizeKB}KB`,
      `HTML document is ${meta.htmlSizeKB}KB. Target: under 100KB.`,
      'Reduce page weight by: enabling GZIP/Brotli compression in LiteSpeed Cache → Page Optimization. Remove unused content. Avoid duplicating nav/footer HTML for mobile.');

  // ── IMAGES ───────────────────────────────────────────────
  // Broken images
  if (imgData) {
    const brokenImgs = imgData.filter(i => i.status === 404 || i.status === 0);
    for (const img of brokenImgs.slice(0, 3))
      push('Performance', 'high', `Broken image (HTTP ${img.status || 'timeout'}): ${img.filename}`,
        `URL: ${img.src}`,
        'Fix or remove the broken image. Update the src URL in WordPress Media Library or in Elementor widget.',
        { imageUrl: img.src, selector: `img[src*="${img.filename}"]`, context: img.raw || '', raw: img.raw || '' });

    // File sizes
    const vheavy = imgData.filter(i => i.sizeKB > 500 && i.status !== 404);
    const heavy  = imgData.filter(i => i.sizeKB > 200 && i.sizeKB <= 500);
    const nonWebP = imgData.filter(i => !i.isModern && i.sizeKB > 0 && !/\.svg/i.test(i.src));

    for (const img of vheavy.slice(0, 3))
      push('Performance', 'critical', `Heavy image: ${img.filename} (${img.sizeKB}KB)`,
        `${img.sizeKB}KB — target under 150KB.`,
        'Compress with ShortPixel/Imagify. Convert to WebP. LiteSpeed Cache → Image Optimization → WebP → ON + QUIC.cloud key.',
        { imageUrl: img.src, selector: `img[src*="${img.filename}"]`, context: img.raw || '', raw: img.raw || '' });

    for (const img of heavy.slice(0, 2))
      push('Performance', 'high', `Large image: ${img.filename} (${img.sizeKB}KB)`,
        `${img.sizeKB}KB — aim for under 150KB.`,
        'Compress + convert to WebP.',
        { imageUrl: img.src, selector: `img[src*="${img.filename}"]`, context: img.raw || '', raw: img.raw || '' });

    if (nonWebP.length > 0)
      push('Performance', 'high', `${nonWebP.length} image(s) not in WebP/AVIF`,
        nonWebP.slice(0, 3).map(i => i.filename).join(', '),
        'Convert to WebP: LiteSpeed Cache → Image Optimization → WebP Replacement → ON (needs free QUIC.cloud API key).');

    const totalKB = imgData.reduce((s, i) => s + i.sizeKB, 0);
    if (totalKB > 1500)
      push('Performance', 'high', `Total image weight: ${totalKB}KB`,
        `${imgData.length} images total ${totalKB}KB. Target: under 500KB.`,
        'Compress all images. Enable WebP. Lazy-load below-fold images.');
  }

  // Alt text
  const noAlt = images.filter(i => !i.hasAlt && i.src && !i.src.startsWith('data:'));
  for (const img of noAlt.slice(0, 5)) {
    const loc = locate(html, img.raw, 'img');
    push('Accessibility', 'high', `Image missing alt text: ${img.src.split('/').pop().split('?')[0]}`,
      `src="${img.src.split('/').pop()}"`,
      'Add alt text. Use Fix Missing Alt Tags plugin or filter: add_filter("wp_get_attachment_image_attributes", ...)',
      loc ? { ...loc, imageUrl: img.src } : { imageUrl: img.src, selector: `img[src*="${img.src.split('/').pop()}"]` });
  }
  if (noAlt.length > 5)
    push('Accessibility', 'high', `${noAlt.length - 5} more images missing alt text`,
      `${noAlt.length} total images without alt on this page.`,
      'Use Fix Missing Alt Tags plugin for bulk fixing across the whole site.');

  // Empty src
  const emptySrc = images.filter(i => i.emptySrc);
  if (emptySrc.length > 0) {
    const loc = locate(html, emptySrc[0].raw, 'img');
    push('Performance', 'medium', `${emptySrc.length} image(s) with empty/missing src`,
      'Images with no src cause extra HTTP requests and browser errors.',
      'Add src attribute or remove the img tag.',
      loc || null);
  }

  // Responsive images
  const noSrcset = images.filter(i => i.src && !i.src.startsWith('data:') && !i.srcset && !i.src.includes('.svg') && !/logo/i.test(i.src));
  if (noSrcset.length > 4)
    push('Performance', 'low', `${noSrcset.length} images without srcset (not responsive)`,
      'Images without srcset serve the same size to all devices — wastes bandwidth on mobile.',
      'Add srcset attribute with multiple sizes. WordPress generates these automatically when you upload images at the correct size. Enable Responsive Images in LiteSpeed Cache.');

  // Lazy loading
  const noLazy = images.filter(i => i.src && !i.src.startsWith('data:') && i.loading !== 'lazy' && i.fetchPriority !== 'high' && !/logo/i.test(i.src));
  if (noLazy.length > 5)
    push('Performance', 'high', `${noLazy.length} images without lazy loading`,
      'All below-fold images should have loading="lazy".',
      'LiteSpeed Cache → Image Optimization → Lazy Load Images → ON.');

  // Dimensions
  const noDim = images.filter(i => i.src && !i.src.startsWith('data:') && (!i.w || !i.h));
  if (noDim.length > 3)
    push('Performance', 'medium', `${noDim.length} images missing width/height`,
      'No space reserved before load — causes CLS (layout shift).',
      'Add explicit width and height to all img tags. LiteSpeed → Add Missing Image Dimensions.');

  // ── IFRAMES ──────────────────────────────────────────────
  for (const iframe of iframes.filter(i => i.src && !i.title).slice(0, 3)) {
    const loc = locate(html, iframe.raw, 'iframe');
    push('Accessibility', 'medium', `iframe missing title: ${iframe.src.slice(0, 50)}`,
      `src="${iframe.src.slice(0, 60)}"`,
      'Add title: <iframe title="Descriptive label" ...>',
      loc || null);
  }

  // ── BROKEN LINKS ─────────────────────────────────────────
  if (brokenLinks && brokenLinks.length > 0) {
    for (const bl of brokenLinks.slice(0, 5))
      push('SEO', 'high', `Broken link (${bl.status}): "${bl.text || bl.url.split('/').pop()}"`,
        `URL: ${bl.url}`,
        'Fix or redirect this URL. Use 301 redirect if the content has moved. Remove the link if the page no longer exists.',
        { line: bl.line, selector: `a[href*="${bl.url.split('/').pop()}"]`, context: bl.raw, raw: bl.raw });
  }

  // ── TRACKING ─────────────────────────────────────────────
  const hasGA4     = /G-[A-Z0-9]{6,}/i.test(allCode);
  const hasGTM     = /GTM-[A-Z0-9]{4,}/i.test(allCode);
  const hasUA      = /UA-\d{5,}-\d/.test(allCode);
  const hasFBPixel = /fbq\s*\(|facebook\.net\/en_US\/fbevents/i.test(allCode);
  const hasTikTok  = /analytics\.tiktok\.com|ttq\s*\./i.test(allCode);
  const hasLinkedIn= /linkedin\.com\/insight/i.test(allCode);
  const hasGAds    = /googleadservices|AW-\d{6,}/i.test(allCode);

  if (!hasGA4 && !hasGTM)
    push('Tracking', 'high', 'No GA4 or GTM detected',
      'Neither Google Analytics 4 (G-XXXXX) nor GTM (GTM-XXXXX) found.',
      'Install GA4 via GTM. Use GTM4WP plugin for WordPress. Verify in GA → Reports → Realtime.');
  else {
    if (hasUA) push('Tracking', 'high', 'Universal Analytics (UA-) still firing', 'UA shut down March 2024.', 'Remove UA tag from GTM immediately.');
    if (!hasGA4 && hasGTM) push('Tracking', 'medium', 'GTM present but GA4 tag not detected', 'GTM installed but no GA4 config tag found.', 'Check GTM → GA4 Configuration tag is published and firing on All Pages.');
    if (!hasGTM && hasGA4) push('Tracking', 'low', 'GA4 hardcoded — recommend GTM instead', 'Direct GA4 install without GTM.', 'Migrate to GTM for easier tag management.');
  }

  return {
    url, status, ttfb,
    meta: { title: meta.title, desc: meta.desc, robots: meta.robots, lang: meta.lang, canonical: meta.canonical, generator: meta.generator, wordCount: words, domElements: meta.domElements, htmlSizeKB: meta.htmlSizeKB, schemaTypes: checkSchemas(meta.jsonLd).map(s => s.type) },
    counts: { images: images.length, links: links.length, headings: headings.length, scripts: scripts.length, styles: styles.length, iframes: iframes.length },
    imageData: imgData || [],
    tracking: { hasGA4, hasGTM, hasUA, hasFBPixel, hasTikTok, hasLinkedIn, hasGAds },
    devUrls: devUrls.length,
    dummyContent: dummy.length,
    redirectChain: redirectChain || [],
    issues: issues.sort((a, b) => { const o = { critical: 0, high: 1, medium: 2, low: 3 }; return (o[a.severity] || 3) - (o[b.severity] || 3); }),
  };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { urls = [], siteBaseUrl, checkImages = true, checkLinks = true } = req.body || {};
    if (!urls.length) return res.status(400).json({ error: 'No URLs' });

    const batch = urls.slice(0, 8);

    // Run WP security checks once per batch (against the base URL)
    const wpSecurity = siteBaseUrl ? await checkWPSecurity(new URL(siteBaseUrl).origin) : null;

    const results = await Promise.all(batch.map(async (url) => {
      try {
        const page = await fetchPage(url);
        if (!page.ok) {
          return {
            url, status: page.status || 0, ttfb: page.ttfb,
            meta: { title: '', desc: '', robots: '', wordCount: 0, domElements: 0, htmlSizeKB: 0, schemaTypes: [] },
            counts: {}, imageData: [], tracking: {}, devUrls: 0, dummyContent: 0, redirectChain: [],
            issues: [{ category: 'Performance', severity: 'critical', title: `Page failed to load: ${page.error}`, detail: url, fix: 'Check the URL is correct and server is responding.', location: null }]
          };
        }

        const [imgData, brokenLinks] = await Promise.all([
          checkImages ? auditImageFiles(parseImages(page.html), page.finalUrl || url) : Promise.resolve([]),
          checkLinks  ? checkBrokenLinks(parseLinks(page.html), page.finalUrl || url, 12) : Promise.resolve([]),
        ]);

        return await auditPage(page.finalUrl || url, page.html, page.status, page.ttfb, page.headers, page.redirectChain, imgData, brokenLinks, wpSecurity, siteBaseUrl || url);
      } catch(e) {
        return { url, status: 0, ttfb: 0, meta: { title: '', wordCount: 0, domElements: 0, htmlSizeKB: 0, schemaTypes: [] }, counts: {}, imageData: [], tracking: {}, devUrls: 0, dummyContent: 0, redirectChain: [], issues: [{ category: 'Performance', severity: 'critical', title: 'Page error: ' + e.message, detail: url, fix: 'Check server logs.', location: null }] };
      }
    }));

    return res.status(200).json({ success: true, results });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
