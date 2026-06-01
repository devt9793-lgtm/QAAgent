// api/audit-pages.js
// Step 2: Audits a batch of URLs (up to 8 at once)
// Returns detailed results with element paths, line numbers, selectors

export const config = { maxDuration: 55 };

// ─────────────────────────────────────────────────────────────
// FETCH
// ─────────────────────────────────────────────────────────────
async function fetchPage(url) {
  const start = Date.now();
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 12000);
    const res = await fetch(url, {
      signal: c.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditBot/3.0)', 'Accept': 'text/html' },
    });
    clearTimeout(t);
    const html = await res.text();
    return { ok: true, html, status: res.status, ttfb: Date.now() - start, finalUrl: res.url, headers: Object.fromEntries(res.headers), redirectCount: res.redirected ? 1 : 0 };
  } catch(e) {
    return { ok: false, error: e.message, status: 0, ttfb: Date.now() - start };
  }
}

async function headRequest(url) {
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 6000);
    const res = await fetch(url, { method: 'HEAD', signal: c.signal, redirect: 'follow' });
    return { status: res.status, size: parseInt(res.headers.get('content-length') || '0'), type: res.headers.get('content-type') || '' };
  } catch { return { status: 0, size: 0, type: '' }; }
}

// ─────────────────────────────────────────────────────────────
// ELEMENT PATH HELPERS
// ─────────────────────────────────────────────────────────────

// Get line number from char index
function getLineNumber(html, charIndex) {
  return html.substring(0, charIndex).split('\n').length;
}

// Get short context snippet around an element
function getContext(html, charIndex, length = 80) {
  const start = Math.max(0, charIndex - 20);
  const end   = Math.min(html.length, charIndex + length + 20);
  return html.substring(start, end).replace(/\s+/g, ' ').trim();
}

// Build a simple CSS-like selector for an element
function buildSelector(attrs, tag) {
  let sel = tag;
  const id    = (attrs.match(/\bid=["']([^"']+)["']/) || [])[1];
  const cls   = (attrs.match(/\bclass=["']([^"']+)["']/) || [])[1];
  const src   = (attrs.match(/\bsrc=["']([^"']{0,60})["']/) || [])[1];
  const href  = (attrs.match(/\bhref=["']([^"']{0,60})["']/) || [])[1];
  const name  = (attrs.match(/\bname=["']([^"']+)["']/) || [])[1];

  if (id)  sel += `#${id}`;
  else if (cls) sel += `.${cls.split(' ')[0]}`;

  if (tag === 'img' && src) sel += `[src="${src.split('/').pop().split('?')[0]}"]`;
  if (tag === 'a'  && href) sel += `[href="${href.slice(0, 40)}"]`;
  if (tag === 'input' && name) sel += `[name="${name}"]`;
  return sel;
}

// Find an element in HTML and return full location info
function locateElement(html, elementRaw, tag = 'img') {
  const idx = html.indexOf(elementRaw);
  if (idx === -1) return null;
  const attrs = elementRaw.replace(new RegExp(`^<${tag}`,'i'), '').replace(/>.*$/s, '');
  return {
    line:     getLineNumber(html, idx),
    selector: buildSelector(attrs, tag),
    context:  getContext(html, idx, elementRaw.length),
    raw:      elementRaw.slice(0, 120),
  };
}

// ─────────────────────────────────────────────────────────────
// PARSERS
// ─────────────────────────────────────────────────────────────
function parseImages(html) {
  const imgs = []; const re = /<img([^>]*)>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1], raw = m[0];
    let src = (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '';
    const dataSrc = (a.match(/\bdata-(?:src|lazy-src|srcset)=["']([^"']+)["']/) || [])[1] || '';
    imgs.push({
      raw, src: src || dataSrc,
      hasAlt:  /\balt=/.test(a), altVal: (a.match(/\balt=["']([^"']*)["']/) || [,null])[1],
      w: (a.match(/\bwidth=["']?(\d+)/) || [])[1] || '',
      h: (a.match(/\bheight=["']?(\d+)/) || [])[1] || '',
      loading: (a.match(/\bloading=["']([^"']+)["']/) || [])[1] || '',
      fetchPriority: (a.match(/\bfetchpriority=["']([^"']+)["']/) || [])[1] || '',
    });
  }
  return imgs;
}

function parseLinks(html) {
  const links = []; const re = /<a([^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1], raw = m[0], inner = m[2].replace(/<[^>]+>/g, '').trim();
    links.push({
      raw, href: (a.match(/\bhref=["']([^"']+)["']/) || [])[1] || '',
      text: inner, aria: (a.match(/\baria-label=["']([^"']+)["']/) || [])[1] || '',
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
  const s = []; const re = /<script([^>]*)>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1];
    const src = (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '';
    if (src) s.push({ src, defer: /\bdefer\b/i.test(a), async: /\basync\b/i.test(a), type: (a.match(/\btype=["']([^"']+)["']/) || [])[1] || '' });
  }
  // Also check inline scripts for UA/GA patterns
  const inlineRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = inlineRe.exec(html)) !== null) {
    const code = m[1];
    if (code.includes('UA-') || code.includes('gtag') || code.includes('fbq') || code.includes('dataLayer'))
      s.push({ src: '', inline: true, code: code.slice(0, 200) });
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
    favicon:     get(/<link[^>]*rel=["'](?:shortcut )?icon["'][^>]*href=["']([^"']+)["']/i),
    appleTouchIcon: get(/<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i),
  };
}

// ─────────────────────────────────────────────────────────────
// DUMMY / DEV / DUPLICATE CONTENT CHECKS
// ─────────────────────────────────────────────────────────────
const DUMMY_PATTERNS = [
  { pattern: /lorem\s+ipsum/i,                    label: 'Lorem ipsum placeholder text' },
  { pattern: /dolor\s+sit\s+amet/i,               label: 'Lorem ipsum (dolor sit amet)' },
  { pattern: /\btest@test\.com\b/i,               label: 'Placeholder email: test@test.com' },
  { pattern: /\badmin@example\.com\b/i,           label: 'Placeholder email: admin@example.com' },
  { pattern: /\bjohn\.doe@/i,                     label: 'Placeholder email: john.doe@...' },
  { pattern: /\bJohn Doe\b/,                      label: 'Placeholder name: John Doe' },
  { pattern: /\bJane Doe\b/,                      label: 'Placeholder name: Jane Doe' },
  { pattern: /\bTest User\b/i,                    label: 'Placeholder name: Test User' },
  { pattern: /123 Fake Street/i,                  label: 'Placeholder address: 123 Fake Street' },
  { pattern: /123-456-7890/,                      label: 'Placeholder phone: 123-456-7890' },
  { pattern: /\(555\)\s*\d{3}-\d{4}/,            label: 'Placeholder phone: (555) format' },
  { pattern: /placeholder\s+text/i,               label: '"Placeholder text" found in content' },
  { pattern: /coming\s+soon/i,                    label: '"Coming soon" text found — content not ready' },
  { pattern: /under\s+construction/i,             label: '"Under construction" found' },
  { pattern: /\bTBD\b|\bTBA\b/,                   label: 'TBD/TBA placeholder found in content' },
  { pattern: /sample\s+(?:text|content|data)/i,   label: 'Sample text/content/data found' },
  { pattern: /dummy\s+(?:text|content|data)/i,    label: 'Dummy text/content/data found' },
];

const DEV_URL_PATTERNS = [
  /https?:\/\/localhost/i,
  /https?:\/\/127\.0\.0\.1/,
  /https?:\/\/(?:[\w-]+\.)?(?:local|dev|test|staging|stage)\b/i,
  /https?:\/\/(?:[\w-]+\.)?ardentirdev\.us/i,
  /https?:\/\/(?:[\w-]+\.)?wpengine\.com/i,
  /https?:\/\/(?:[\w-]+\.)?kinsta\.cloud/i,
  /https?:\/\/(?:[\w-]+\.)?pantheonsite\.io/i,
  /https?:\/\/(?:[\w-]+\.)?flywheelsites\.com/i,
  /https?:\/\/(?:[\w-]+\.)?myftpupload\.com/i,
  /https?:\/\/(?:[\w-]+\.)?cloudwaysapps\.com/i,
];

function findDevUrls(html, pageUrl) {
  const found = [];
  const base = new URL(pageUrl);

  // Check all href and src attributes
  const attrRx = /(?:href|src|action|content)=["']([^"']+)["']/gi;
  let m;
  while ((m = attrRx.exec(html)) !== null) {
    const val = m[1];
    for (const pattern of DEV_URL_PATTERNS) {
      if (pattern.test(val)) {
        try {
          const devHost = new URL(val).hostname;
          if (devHost !== base.hostname) {
            const idx = html.indexOf(m[0]);
            found.push({
              url: val.slice(0, 100),
              attr: m[0].slice(0, 60),
              line: getLineNumber(html, idx),
              context: getContext(html, idx, 80),
            });
          }
        } catch {}
        break;
      }
    }
  }

  // Also check visible text content (for accidentally published dev URLs)
  const textContent = html.replace(/<[^>]+>/g, ' ');
  for (const pattern of DEV_URL_PATTERNS) {
    const tm = pattern.exec(textContent);
    if (tm) {
      found.push({ url: tm[0], attr: 'text content', line: '?', context: tm[0] });
    }
  }

  return found;
}

function findDummyContent(html) {
  // Remove scripts and styles before checking
  const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const textContent = cleaned.replace(/<[^>]+>/g, ' ');
  const found = [];

  for (const { pattern, label } of DUMMY_PATTERNS) {
    const m = pattern.exec(textContent);
    if (m) {
      const idx = textContent.indexOf(m[0]);
      found.push({
        label,
        context: textContent.substring(Math.max(0, idx - 30), idx + m[0].length + 30).trim(),
      });
    }
  }
  return found;
}

// Check for broken links on a page (HEAD request all internal links)
async function checkBrokenLinks(links, baseUrl) {
  const base = new URL(baseUrl);
  const internal = links.filter(l => {
    try {
      const u = new URL(l.href, baseUrl);
      return u.hostname === base.hostname && l.href && !l.href.startsWith('#') && !l.href.startsWith('javascript:') && !l.href.startsWith('mailto:') && !l.href.startsWith('tel:');
    } catch { return false; }
  }).slice(0, 20); // max 20 link checks per page

  const broken = [];
  await Promise.all(internal.map(async (link) => {
    try {
      const absUrl = new URL(link.href, baseUrl).href;
      const r = await headRequest(absUrl);
      if (r.status === 404 || r.status === 410 || r.status === 403) {
        broken.push({ url: absUrl, status: r.status, text: link.text.slice(0, 60), raw: link.raw.slice(0, 100) });
      }
    } catch {}
  }));
  return broken;
}

// Check image file sizes and WebP status
async function auditImages(images, baseUrl, checkFiles = true) {
  const results = [];
  const candidates = images.filter(i => i.src && !i.src.startsWith('data:') && /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(i.src)).slice(0, 10);

  if (!checkFiles) {
    return candidates.map(img => ({
      src: img.src, filename: img.src.split('/').pop().split('?')[0].slice(0, 60),
      sizeKB: 0, isWebP: /\.webp(\?|$)/i.test(img.src), isAvif: /\.avif(\?|$)/i.test(img.src),
      isModern: /\.(webp|avif)(\?|$)/i.test(img.src), hasAlt: img.hasAlt, altVal: img.altVal,
      isLazy: img.loading === 'lazy', hasDimensions: !!(img.w && img.h), raw: img.raw,
    }));
  }

  await Promise.all(candidates.map(async (img) => {
    let absUrl = img.src;
    try { absUrl = new URL(img.src, baseUrl).href; } catch {}
    const meta = await headRequest(absUrl);
    const isWebP = /webp/i.test(meta.type) || /\.webp(\?|$)/i.test(img.src);
    const isAvif = /avif/i.test(meta.type) || /\.avif(\?|$)/i.test(img.src);
    results.push({
      src: absUrl,
      filename: absUrl.split('/').pop().split('?')[0].slice(0, 60),
      sizeKB: meta.size ? Math.round(meta.size / 1024) : 0,
      isWebP, isAvif, isModern: isWebP || isAvif,
      hasAlt: img.hasAlt, altVal: img.altVal,
      isLazy: img.loading === 'lazy',
      hasDimensions: !!(img.w && img.h),
      raw: img.raw.slice(0, 100),
    });
  }));
  return results;
}

// ─────────────────────────────────────────────────────────────
// MAIN AUDIT FUNCTION
// ─────────────────────────────────────────────────────────────
async function auditPage(url, html, status, ttfb, headers, imgData, siteBaseUrl) {
  const issues = [];
  const meta     = parseMeta(html);
  const images   = parseImages(html);
  const links    = parseLinks(html);
  const headings = parseHeadings(html);
  const scripts  = parseScripts(html);
  const styles   = parseStyles(html);
  const iframes  = parseIframes(html);
  const base     = new URL(siteBaseUrl);

  // Helper: push an issue with optional element location
  const push = (cat, sev, title, detail, fix, location = null) => {
    issues.push({ category: cat, severity: sev, title, detail, fix, location });
  };

  // ── SECURITY ────────────────────────────────────────────────
  if (url.startsWith('http://'))
    push('Security', 'critical', 'Page not using HTTPS',
      `Page served over HTTP — connection is unencrypted.`,
      'Install SSL certificate. Enable HTTPS redirect in .htaccess. Cloudflare free tier provides automatic SSL.');

  if (status === 404)
    push('SEO', 'critical', `Page returns 404 Not Found`, `URL: ${url}`, 'Fix the URL or set up a 301 redirect to the correct page.');
  else if (status === 403)
    push('Security', 'high', `Page returns 403 Forbidden`, `URL: ${url}`, 'Check server permissions. If this page should be public, fix file/folder permissions.');
  else if (status === 500)
    push('Security', 'critical', `Server error 500 on page`, `URL: ${url}`, 'Check server error logs. Fix the PHP/server error causing this.');

  // Mixed content check (HTTP assets on HTTPS page)
  if (url.startsWith('https://')) {
    const httpAssets = [];
    const assetRx = /(?:src|href|action)=["'](http:\/\/[^"']+)["']/gi;
    let m;
    while ((m = assetRx.exec(html)) !== null) {
      const asset = m[1];
      if (!asset.includes(base.hostname)) httpAssets.push(asset.slice(0, 80));
    }
    if (httpAssets.length > 0) {
      push('Security', 'high', `Mixed content — ${httpAssets.length} HTTP asset(s) on HTTPS page`,
        `HTTP assets found: ${httpAssets.slice(0,3).join(', ')}`,
        'Replace all http:// asset URLs with https://. Run Search & Replace in WordPress database for old HTTP URLs. Use Better Search Replace plugin.',
        { raw: httpAssets[0], context: 'src/href attribute', selector: 'Check all src/href attributes' });
    }
  }

  // WP Admin URL exposed
  const wpAdminRes = await headRequest(base.origin + '/wp-admin/');
  if (wpAdminRes.status === 200 || wpAdminRes.status === 302) {
    push('Security', 'medium', 'Default WordPress /wp-admin/ URL is accessible',
      `${base.origin}/wp-admin/ returns HTTP ${wpAdminRes.status}`,
      'Hide the admin URL using a security plugin (WPS Hide Login, Perfmatters). Change login URL to something unique like /manage/ or /dashboard/.');
  }

  // SSL check
  if (url.startsWith('https://')) {
    const httpVersion = url.replace('https://', 'http://');
    const httpRes = await headRequest(httpVersion);
    if (httpRes.status === 200) {
      push('Security', 'high', 'HTTP version of site returns 200 — no redirect to HTTPS',
        `${httpVersion} returns 200 instead of 301 redirect to HTTPS.`,
        'Add HTTPS redirect in .htaccess: RewriteEngine On / RewriteCond %{HTTPS} off / RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]');
    }
  }

  // ── SEO ────────────────────────────────────────────────────
  if (/noindex/i.test(meta.robots)) {
    const idx = html.search(/name=["']robots["'][^>]*content=["'][^"']*noindex/i);
    push('SEO', 'critical', 'Page set to noindex — invisible to Google',
      `meta robots: "${meta.robots}" — Google will not index this page.`,
      'WordPress: Settings → Reading → uncheck "Discourage search engines". Or fix in Yoast/RankMath → edit page → Robots → set to Index.',
      { line: idx >= 0 ? getLineNumber(html, idx) : null, selector: 'meta[name="robots"]', context: idx >= 0 ? getContext(html, idx, 80) : '', raw: `<meta name="robots" content="${meta.robots}">` });
  }

  // Check for "Discourage search engines" WordPress setting
  if (html.includes("'Discourage'") || html.includes('discourage_search_engines') || html.includes('blog_public') && html.includes('0')) {
    push('SEO', 'critical', '"Discourage search engines" appears to be enabled',
      'WordPress blog_public setting may be set to block search engines.',
      'WordPress Admin → Settings → Reading → uncheck "Discourage search engines from indexing this site" → Save.');
  }

  if (!meta.title) {
    push('SEO', 'critical', 'Missing <title> tag', 'No title tag found.',
      'Add a unique 50–60 character title. In Yoast/RankMath: edit page → SEO Title field.',
      { line: 1, selector: 'head > title', context: '<head> — no title tag found', raw: '(missing)' });
  } else if (meta.title.length < 30) {
    const idx = html.indexOf('<title');
    push('SEO', 'medium', `Title too short — ${meta.title.length} chars`,
      `"${meta.title}"`,
      'Expand to 50–60 characters with primary keyword + brand name.',
      { line: idx >= 0 ? getLineNumber(html, idx) : null, selector: 'head > title', context: `<title>${meta.title}</title>`, raw: `<title>${meta.title}</title>` });
  } else if (meta.title.length > 65) {
    const idx = html.indexOf('<title');
    push('SEO', 'low', `Title too long — ${meta.title.length} chars`,
      `"${meta.title.slice(0,70)}…"`,
      'Shorten to under 60 characters.',
      { line: idx >= 0 ? getLineNumber(html, idx) : null, selector: 'head > title', context: `<title>${meta.title.slice(0,60)}</title>`, raw: `<title>${meta.title}</title>` });
  }

  if (!meta.desc) {
    push('SEO', 'high', 'Missing meta description', 'No meta description found.',
      'Add 150–160 char meta description in Yoast/RankMath → Description field.',
      { line: null, selector: 'meta[name="description"]', context: '<head> — no meta description found', raw: '(missing)' });
  } else if (meta.desc.length < 70) {
    push('SEO', 'medium', `Meta description too short — ${meta.desc.length} chars`, meta.desc.slice(0, 100),
      'Expand to 150–160 characters.');
  } else if (meta.desc.length > 165) {
    push('SEO', 'low', `Meta description too long — ${meta.desc.length} chars`, meta.desc.slice(0, 100) + '…',
      'Shorten to 155 characters.');
  }

  if (!meta.canonical) {
    push('SEO', 'medium', 'Missing canonical tag', 'No rel="canonical" link.',
      'Canonical prevents duplicate content. Yoast/RankMath adds this automatically. Verify it is enabled.',
      { line: null, selector: 'link[rel="canonical"]', context: '<head> — no canonical tag found', raw: '(missing)' });
  } else {
    // Canonical pointing to different domain
    try {
      const canHost = new URL(meta.canonical).hostname;
      if (canHost !== base.hostname) {
        const idx = html.indexOf('canonical');
        push('SEO', 'high', `Canonical points to different domain: ${canHost}`,
          `Canonical: "${meta.canonical}"`,
          'Update canonical to point to this site\'s URL. Check Yoast/RankMath settings.',
          { line: idx >= 0 ? getLineNumber(html, idx) : null, selector: 'link[rel="canonical"]', context: `<link rel="canonical" href="${meta.canonical}">`, raw: `<link rel="canonical" href="${meta.canonical}">` });
      }
    } catch {}
  }

  if (!meta.ogImage) {
    push('SEO', 'medium', 'Missing og:image — no social preview',
      'When shared on LinkedIn/Twitter/Facebook — no image shows.',
      'Add 1200×630px og:image in Yoast/RankMath → Social tab.',
      { line: null, selector: 'meta[property="og:image"]', context: '(missing from <head>)', raw: '(missing)' });
  } else if (meta.ogImgW > 1600) {
    push('SEO', 'medium', `og:image oversized — ${meta.ogImgW}px wide`,
      `Current: ${meta.ogImgW}px. Social platforms use 1200×630px max.`,
      'Resize og:image to 1200×630px in your SEO plugin social settings.');
  }

  if (!meta.lang) {
    push('SEO', 'medium', 'Missing lang attribute on <html>',
      'Screen readers and search engines cannot detect the page language.',
      'Add lang to html tag: <html lang="en">. WordPress: Settings → General → Site Language.',
      { line: 1, selector: 'html[lang]', context: html.slice(0, 60), raw: html.slice(0, 60) });
  }

  if (!meta.viewport) {
    push('SEO', 'high', 'Missing viewport meta tag',
      'Page won\'t render correctly on mobile — Google penalises this.',
      'Add: <meta name="viewport" content="width=device-width, initial-scale=1">',
      { line: null, selector: 'meta[name="viewport"]', context: '(missing from <head>)', raw: '(missing)' });
  }

  if (!meta.charset) {
    push('SEO', 'low', 'Missing charset declaration',
      'No charset meta tag found.',
      'Add as first tag in <head>: <meta charset="UTF-8">');
  }

  // Favicon
  if (!meta.favicon) {
    push('SEO', 'medium', 'Missing favicon',
      'No favicon link tag found.',
      'Add favicon: <link rel="icon" href="/favicon.ico" sizes="32x32">. WordPress: Appearance → Customize → Site Identity → Site Icon.');
  }
  if (!meta.appleTouchIcon) {
    push('SEO', 'low', 'Missing Apple touch icon',
      'No apple-touch-icon link tag found.',
      'Add: <link rel="apple-touch-icon" href="/apple-touch-icon.png">. Should be 180×180px PNG.');
  }

  // H1 checks
  const h1s = headings.filter(h => h.level === 'h1');
  if (h1s.length === 0) {
    push('SEO', 'high', 'No H1 heading on page', 'Every page needs exactly one H1.',
      'Add one H1 tag. In Elementor: click main heading widget → Content → HTML Tag → H1.',
      { line: null, selector: 'h1', context: '(no h1 found)', raw: '(missing)' });
  } else if (h1s.length > 1) {
    const loc = locateElement(html, h1s[1].raw, 'h1');
    push('SEO', 'medium', `${h1s.length} H1 tags found — only 1 allowed`,
      h1s.map(h => `"${h.text.slice(0, 50)}"`).join(', '),
      'Keep only one H1. Change extras to H2/H3 in Elementor or theme settings.',
      loc ? { ...loc, selector: 'h1:nth-of-type(2)' } : null);
  }

  // Heading order
  let prevLvl = 0;
  for (const h of headings) {
    const lvl = parseInt(h.level[1]);
    if (prevLvl > 0 && lvl > prevLvl + 1) {
      const loc = locateElement(html, h.raw, h.level);
      push('Accessibility', 'medium', `Heading level skipped: H${prevLvl} → H${lvl}`,
        `"${h.text.slice(0, 60)}"`,
        'Use sequential heading levels. Change this heading to H' + (prevLvl + 1) + ' in your page builder.',
        loc ? { ...loc, selector: h.level } : null);
      break;
    }
    prevLvl = lvl;
  }

  // Generic link text
  const genericTexts = ['learn more', 'read more', 'click here', 'find out more', 'more', 'here', 'link', 'this'];
  const badLinks = links.filter(l => genericTexts.includes((l.text || '').toLowerCase().trim()) && !l.aria);
  if (badLinks.length > 0) {
    const first = badLinks[0];
    const loc = locateElement(html, first.raw, 'a');
    push('SEO', 'high', `${badLinks.length} non-descriptive link(s) — hurts SEO & accessibility`,
      `Links with generic text: "${badLinks.slice(0,4).map(l => l.text).join('", "')}"`,
      'Replace with descriptive text (e.g. "View our Services" instead of "Learn more"). Or add aria-label.',
      loc ? { ...loc, selector: buildSelector(first.raw, 'a') } : null);
  }

  // Hash-only links (#)
  const hashLinks = links.filter(l => l.href === '#' || l.href === 'javascript:void(0)' || l.href === 'javascript:;');
  if (hashLinks.length > 2) {
    push('SEO', 'low', `${hashLinks.length} empty/hash-only links (#)`,
      `Links with href="#" or javascript:void(0) — these go nowhere.`,
      'Add proper href values. Empty links confuse both users and search engines.');
  }

  // OG tags
  if (!meta.ogTitle) push('SEO', 'low', 'Missing og:title', 'No Open Graph title.', 'Add og:title in Yoast/RankMath → Social tab.');
  if (!meta.twitterCard) push('SEO', 'low', 'Missing twitter:card meta tag', 'No Twitter/X card.', 'Yoast SEO adds this automatically — check Social → Twitter settings.');

  // ── PERFORMANCE ────────────────────────────────────────────
  if (ttfb > 1800) {
    push('Performance', 'critical', `Slow TTFB: ${ttfb}ms — page not being cached`,
      'Time to First Byte over 1800ms. Every visitor gets full PHP render.',
      'Install LiteSpeed Cache or WP Rocket. Enable page cache + mobile cache. TTFB should be <200ms with cache.');
  } else if (ttfb > 800) {
    push('Performance', 'high', `TTFB elevated: ${ttfb}ms`,
      'Google "Good" TTFB is under 800ms.',
      'Enable caching plugin. Check server plan. Consider Cloudflare free tier.');
  }

  const cc = headers['cache-control'] || headers['Cache-Control'] || '';
  if (!cc || cc.includes('no-store')) {
    push('Performance', 'high', 'No browser cache headers',
      `Cache-Control: "${cc || 'missing'}"`,
      'LiteSpeed Cache → Cache → Browser Cache TTL → 31557600 (1 year for static assets).');
  }

  const blockCSS = styles.filter(s => !s.media || s.media === 'all' || s.media === 'screen');
  if (blockCSS.length > 8) {
    push('Performance', 'critical', `${blockCSS.length} render-blocking CSS files`,
      blockCSS.slice(0,3).map(s => s.href.split('/').pop()).join(', ') + '…',
      'Elementor: Settings → Experiments → Improved CSS Loading. LiteSpeed: CSS Minify + Combine + QUIC.cloud for Critical CSS.');
  } else if (blockCSS.length > 4) {
    push('Performance', 'high', `${blockCSS.length} render-blocking CSS files`, '', 'LiteSpeed Cache → CSS Combine + Minify.');
  }

  const headHtml = html.split('</head>')[0] || '';
  const syncHead = parseScripts(headHtml).filter(s => s.src && !s.defer && !s.async && !s.type);
  if (syncHead.length > 0) {
    push('Performance', 'critical', `${syncHead.length} sync script(s) blocking <head>`,
      syncHead.slice(0,3).map(s => s.src.split('/').pop()).join(', '),
      'Add defer to all non-critical scripts. LiteSpeed Cache → JS Defer → ON. Exclude: jquery.min.js, elementor-frontend.min.js.',
      { line: getLineNumber(html, html.indexOf(syncHead[0].src) - 20), selector: `script[src*="${syncHead[0].src.split('/').pop()}"]`, context: `<script src="${syncHead[0].src}">`, raw: `<script src="${syncHead[0].src}">` });
  }

  // Video embeds
  const videoIf = iframes.filter(i => /vimeo|youtube|youtu\.be/i.test(i.src));
  if (videoIf.length > 0) {
    const loc = locateElement(html, videoIf[0].raw, 'iframe');
    push('Performance', 'critical', `${videoIf.length} video embed(s) loading on every page visit`,
      videoIf.map(i => { try { return new URL(i.src).hostname; } catch { return i.src.slice(0,40); }}).join(', '),
      'LiteSpeed Cache → Lazy Load Iframes → ON. Or show thumbnail + play button, load iframe on click only.',
      loc ? { ...loc, selector: 'iframe[src*="vimeo"], iframe[src*="youtube"]' } : null);
  }

  // Third-party scripts
  const tpScripts = scripts.filter(s => { try { return s.src && new URL(s.src).hostname !== base.hostname; } catch { return false; }});
  const slowTp = tpScripts.filter(s => /facebook|fbevents|pixel|gtm|analytics|hotjar|intercom|drift|hubspot|talkfurther|panoskin|tourbuilder|crisp|tidio|zendesk/i.test(s.src));
  if (slowTp.length > 2) {
    push('Performance', 'high', `${slowTp.length} third-party tracking scripts`,
      slowTp.slice(0,4).map(s => { try { return new URL(s.src).hostname; } catch { return s.src.slice(0,40); }}).join(', '),
      'Consolidate all tracking via Google Tag Manager. Remove standalone GA, FB Pixel plugins. Fire everything from GTM.');
  }

  // Dead UA
  const allCode = scripts.map(s => s.code || s.src).join(' ');
  if (/UA-\d{6,}-\d/.test(allCode) || /UA-\d{6,}-\d/.test(html.slice(0, 10000))) {
    push('Performance', 'high', 'Dead Universal Analytics (UA-) still firing',
      'UA was shut down March 2024. Still loading wastes ~50ms per page.',
      'Remove UA tag from GTM. Verify GA4 (G-XXXXXXXX) is active in Google Analytics → Reports → Realtime.');
  }

  // Elementor-specific
  if (/css_print_method-external/i.test(meta.generator))
    push('Performance', 'high', 'Elementor: css_print_method-external',
      'Elementor loading CSS as separate blocking files.',
      'Elementor → Settings → Experiments → Improved CSS Loading → ON → Regenerate Files & Data → Flush cache.');

  if (/font_display-auto/i.test(meta.generator))
    push('Performance', 'medium', 'Elementor: font_display-auto — text invisible while fonts load',
      'font-display: auto causes FOIT (Flash of Invisible Text). Hurts FCP.',
      'Elementor → Settings → Performance → Font Display → Swap.');

  // Hero preload check
  if (!/<link[^>]*rel=["']preload["'][^>]*as=["']image["']/i.test(html) && images.length > 0) {
    push('Performance', 'high', 'No hero image preload tag in <head>',
      'LCP hero image discovered late — browser waits for CSS before finding it.',
      'Add to <head>: <link rel="preload" as="image" fetchpriority="high" href="HERO-IMAGE-URL">. In Elementor: Site Settings → Custom Code → Head.',
      { line: null, selector: 'link[rel="preload"][as="image"]', context: '(missing from <head>)', raw: '(missing)' });
  }

  // ── IMAGES ─────────────────────────────────────────────────
  const noAlt = images.filter(i => !i.hasAlt && i.src && !i.src.startsWith('data:'));
  for (const img of noAlt.slice(0, 5)) {
    const loc = locateElement(html, img.raw, 'img');
    push('Accessibility', 'high', `Image missing alt text`,
      `src="${img.src.split('/').pop().split('?')[0]}"`,
      'Add alt text describing the image. Use Fix Missing Alt Tags plugin or wp_get_attachment_image_attributes filter.',
      loc ? { ...loc, imageUrl: img.src } : { imageUrl: img.src, selector: `img[src*="${img.src.split('/').pop()}"]` });
  }
  if (noAlt.length > 5) {
    push('Accessibility', 'high', `${noAlt.length - 5} more images missing alt text`,
      `${noAlt.length} total images without alt attribute on this page.`,
      'Use Fix Missing Alt Tags plugin for bulk fixing across the whole site.');
  }

  // Lazy loading
  const noLazy = images.filter(i => i.src && !i.src.startsWith('data:') && i.loading !== 'lazy' && i.fetchPriority !== 'high' && !/logo/i.test(i.src));
  if (noLazy.length > 5) {
    push('Performance', 'high', `${noLazy.length} images without lazy loading`,
      'All below-fold images should have loading="lazy".',
      'LiteSpeed Cache → Image Optimization → Lazy Load Images → ON.');
  }

  // Dimensions
  const noDim = images.filter(i => i.src && !i.src.startsWith('data:') && (!i.w || !i.h));
  if (noDim.length > 3) {
    push('Performance', 'medium', `${noDim.length} images missing width/height`,
      'Browser cannot reserve space before load — causes layout shift (CLS).',
      'Add explicit width and height to all img tags. LiteSpeed → Add Missing Image Dimensions.');
  }

  // Image file sizes from audit
  if (imgData && imgData.length > 0) {
    const vheavy = imgData.filter(i => i.sizeKB > 500);
    const heavy  = imgData.filter(i => i.sizeKB > 200 && i.sizeKB <= 500);
    const nonWebP = imgData.filter(i => !i.isModern && i.sizeKB > 0 && !/\.svg/i.test(i.src));

    for (const img of vheavy.slice(0, 3)) {
      push('Performance', 'critical', `Heavy image: ${img.filename} (${img.sizeKB}KB)`,
        `File size: ${img.sizeKB}KB — target is under 150KB per image.`,
        'Compress with ShortPixel/Imagify. Convert to WebP. Consider resizing to display dimensions.',
        { imageUrl: img.src, selector: `img[src*="${img.filename}"]`, context: img.raw || '', raw: img.raw || '' });
    }
    for (const img of heavy.slice(0, 2)) {
      push('Performance', 'high', `Large image: ${img.filename} (${img.sizeKB}KB)`,
        `File size: ${img.sizeKB}KB — aim for under 150KB.`,
        'Compress image. Convert to WebP. LiteSpeed Cache → Image Optimization → WebP Replacement → ON.',
        { imageUrl: img.src, selector: `img[src*="${img.filename}"]`, context: img.raw || '', raw: img.raw || '' });
    }
    if (nonWebP.length > 0) {
      push('Performance', 'high', `${nonWebP.length} image(s) not in WebP/AVIF format`,
        nonWebP.slice(0,3).map(i => i.filename).join(', '),
        'Convert to WebP: LiteSpeed Cache → Image Optimization → WebP Replacement → ON (needs QUIC.cloud free API key).');
    }
    const totalKB = imgData.reduce((s, i) => s + i.sizeKB, 0);
    if (totalKB > 1500)
      push('Performance', 'high', `Total image weight: ${totalKB}KB (target: under 500KB)`,
        `${imgData.length} images sampled total ${totalKB}KB.`,
        'Compress all images. Enable WebP. Lazy-load below-fold images.');
  }

  // ── IFRAMES ─────────────────────────────────────────────────
  const untitledIf = iframes.filter(i => i.src && !i.title);
  for (const iframe of untitledIf.slice(0, 3)) {
    const loc = locateElement(html, iframe.raw, 'iframe');
    push('Accessibility', 'medium', `iframe missing title attribute`,
      `src="${iframe.src.slice(0, 60)}"`,
      'Add title attribute: <iframe title="Descriptive label here" ...>',
      loc ? { ...loc, selector: `iframe[src*="${iframe.src.split('/')[2] || 'embed'}"]` } : null);
  }

  // ── DEV URLS ────────────────────────────────────────────────
  const devUrls = findDevUrls(html, url);
  if (devUrls.length > 0) {
    push('SEO', 'critical', `${devUrls.length} staging/dev URL(s) found in page source`,
      devUrls.slice(0,3).map(d => d.url).join(', '),
      'Run Search & Replace plugin to replace all staging URLs with live URLs. Use Better Search Replace or WP-CLI: wp search-replace "staging.example.com" "example.com" --all-tables',
      { line: devUrls[0].line, selector: devUrls[0].attr, context: devUrls[0].context, raw: devUrls[0].url });
  }

  // ── DUMMY CONTENT ───────────────────────────────────────────
  const dummy = findDummyContent(html);
  for (const d of dummy.slice(0, 3)) {
    push('Content', 'high', `Dummy/placeholder content: ${d.label}`,
      `Found: "${d.context.slice(0, 100)}"`,
      'Replace all placeholder content with real copy before launch.');
  }

  // ── TRACKING ────────────────────────────────────────────────
  const fullCode = scripts.map(s => s.src + ' ' + (s.code || '')).join(' ') + html.slice(0, 15000);

  const hasGA4 = /G-[A-Z0-9]{6,}/i.test(fullCode);
  const hasGTM = /GTM-[A-Z0-9]{4,}/i.test(fullCode);
  const hasUA  = /UA-\d{5,}-\d/.test(fullCode);
  const hasFBPixel   = /fbq\s*\(|facebook\.net\/en_US\/fbevents|facebook-pixel/i.test(fullCode);
  const hasMetaPixel = hasFBPixel;
  const hasTikTok    = /analytics\.tiktok\.com|ttq\s*\./i.test(fullCode);
  const hasLinkedIn  = /linkedin\.com\/insight/i.test(fullCode);
  const hasGAds      = /googleadservices|google_conversion|gtag.*AW-/i.test(fullCode);

  if (!hasGA4 && !hasGTM) {
    push('Tracking', 'high', 'No Google Analytics 4 or GTM detected',
      'Neither GA4 (G-XXXXXX) nor Google Tag Manager (GTM-XXXXX) found.',
      'Install GA4 via GTM or directly. WordPress: use GTM4WP plugin for GTM. Verify in Google Analytics → Reports → Realtime.');
  } else {
    if (hasUA) push('Tracking', 'high', 'Universal Analytics (UA-) still firing alongside GA4', 'UA shut down March 2024.', 'Remove UA tag from GTM immediately.');
    if (!hasGA4 && hasGTM) push('Tracking', 'medium', 'GTM present but no GA4 tag detected', 'GA4 configuration tag not found in page source.', 'Check GTM → GA4 Configuration tag is published and firing on All Pages.');
    if (!hasGTM && hasGA4) push('Tracking', 'low', 'GA4 hardcoded — recommend using GTM instead', 'Direct GA4 install detected without GTM.', 'Migrate to GTM for easier tag management without code deployments.');
  }

  // Redirects - check for redirect chains
  if (url !== url) {} // handled by fetch
  const cc2 = headers['cache-control'] || '';
  // www/non-www check
  const wwwRes = await headRequest(url.replace('://www.', '://').replace('://', '://www.'));
  if (wwwRes.status === 200) {
    push('SEO', 'medium', 'Both www and non-www versions accessible',
      'Both https://example.com and https://www.example.com return 200.',
      'Set up a 301 redirect: one version should redirect to the other. Set canonical to preferred version. Check WordPress Address settings.');
  }

  // ── BROKEN LINKS ────────────────────────────────────────────
  // (Sampled — full check done async)

  return {
    url, status, ttfb,
    meta: { title: meta.title, desc: meta.desc, robots: meta.robots, lang: meta.lang, canonical: meta.canonical, hasGA4, hasGTM },
    counts: { images: images.length, links: links.length, headings: headings.length, scripts: scripts.length, styles: styles.length, iframes: iframes.length },
    imageData: imgData || [],
    tracking: { hasGA4, hasGTM, hasUA, hasFBPixel, hasTikTok, hasLinkedIn, hasGAds },
    devUrls: devUrls.length,
    dummyContent: dummy.length,
    issues: issues.sort((a, b) => {
      const o = { critical: 0, high: 1, medium: 2, low: 3 };
      return (o[a.severity] || 3) - (o[b.severity] || 3);
    }),
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
    const { urls = [], siteBaseUrl, checkImages = true } = req.body || {};
    if (!urls.length) return res.status(400).json({ error: 'No URLs provided' });

    const batch = urls.slice(0, 8); // max 8 per batch call
    const results = await Promise.all(batch.map(async (url) => {
      try {
        const page = await fetchPage(url);
        if (!page.ok) {
          return { url, status: page.status || 0, ttfb: page.ttfb, issues: [{ category: 'Performance', severity: 'critical', title: `Page failed to load: ${page.error}`, detail: url, fix: 'Check the URL is correct and the server is responding.', location: null }], meta: {}, counts: {}, imageData: [], tracking: {}, devUrls: 0, dummyContent: 0 };
        }
        const imgData = checkImages ? await auditImages(parseImages(page.html), page.finalUrl || url, true) : [];
        return await auditPage(page.finalUrl || url, page.html, page.status, page.ttfb, page.headers, imgData, siteBaseUrl || url);
      } catch(e) {
        return { url, status: 0, ttfb: 0, error: e.message, issues: [], meta: {}, counts: {}, imageData: [], tracking: {}, devUrls: 0, dummyContent: 0 };
      }
    }));

    return res.status(200).json({ success: true, results });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
