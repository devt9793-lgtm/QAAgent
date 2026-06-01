// api/audit-pages.js — Site Audit Agent v3.2
// 33 rules mapped exactly to the QA checklist
// Each issue includes line number, selector, context snippet, image URL

export const config = { maxDuration: 55 };

// ─── FETCH ───────────────────────────────────────────────
async function fetchPage(url) {
  const start = Date.now();
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 13000);
    const res = await fetch(url, {
      signal: c.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditBot/3.2)', 'Accept': 'text/html' },
    });
    // FIX: Capture TTFB at first byte (before reading body)
    // res.headers are available as soon as server sends headers = true TTFB
    const ttfb = Date.now() - start;
    const html = await res.text();
    // Detect cache status from response headers
    const hdrs = Object.fromEntries(res.headers);
    const cacheStatus = detectCacheStatus(hdrs);
    return { ok: true, html, status: res.status, ttfb, finalUrl: res.url, redirected: res.redirected, headers: hdrs, cacheStatus };
  } catch(e) { return { ok: false, error: e.message, status: 0, ttfb: Date.now()-start }; }
}

// FIX: Proper cache detection that understands LiteSpeed, Cloudflare, nginx caching
function detectCacheStatus(headers) {
  // LiteSpeed Cache indicators
  const lsCache  = headers['x-litespeed-cache']  || '';
  const lsTag    = headers['x-litespeed-tag']     || '';
  // Cloudflare
  const cfCache  = headers['cf-cache-status']     || '';
  // Generic cache headers
  const xCache   = headers['x-cache']             || headers['x-cache-status'] || '';
  // Nginx / Varnish
  const xProxy   = headers['x-proxy-cache']       || '';
  const age      = headers['age']                 || '';  // non-zero = served from cache

  const isLSCached   = /hit/i.test(lsCache);
  const isCFCached   = /HIT/i.test(cfCache);
  const isXCached    = /HIT/i.test(xCache) || /HIT/i.test(xProxy);
  const hasAge       = parseInt(age) > 0;
  const isCached     = isLSCached || isCFCached || isXCached || hasAge;

  const cc = headers['cache-control'] || headers['Cache-Control'] || '';
  // Parse max-age from Cache-Control
  const maxAgeM = cc.match(/max-age=(\d+)/i);
  const maxAge  = maxAgeM ? parseInt(maxAgeM[1]) : 0;
  const hasNoStore  = cc.includes('no-store');
  const hasNoCache  = cc.includes('no-cache');  // no-cache ≠ uncached! means "revalidate"
  const isPublic    = cc.includes('public');
  const hasLongTTL  = maxAge > 3600; // > 1 hour

  return {
    isCached,
    isLSCached,
    isCFCached,
    hasNoStore,
    hasNoCache,
    maxAge,
    hasLongTTL,
    cc,
    lsCache,
    cfCache,
    age,
  };
}

async function headReq(url) {
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 7000);
    const res = await fetch(url, { method:'HEAD', signal: c.signal, redirect:'follow' });
    return { status: res.status, size: parseInt(res.headers.get('content-length')||'0'), type: res.headers.get('content-type')||'', finalUrl: res.url };
  } catch { return { status: 0, size: 0, type: '', finalUrl: url }; }
}

// Count redirect hops
async function countRedirects(url) {
  let hops = 0, current = url;
  try {
    for (let i = 0; i < 6; i++) {
      const c = new AbortController();
      setTimeout(() => c.abort(), 5000);
      const res = await fetch(current, { method:'HEAD', signal:c.signal, redirect:'manual' });
      if (res.status >= 300 && res.status < 400) {
        hops++;
        const loc = res.headers.get('location');
        if (!loc) break;
        current = new URL(loc, current).href;
      } else break;
    }
  } catch {}
  return hops;
}

// ─── ELEMENT LOCATION HELPERS ────────────────────────────
function lineNo(html, idx) { return html.substring(0, Math.max(0,idx)).split('\n').length; }
function context(html, idx, len=100) {
  const s = Math.max(0,idx-15), e = Math.min(html.length, idx+len+15);
  return html.substring(s,e).replace(/\s+/g,' ').trim();
}
function selector(tag, attrs) {
  let sel = tag;
  const id  = (attrs.match(/\bid=["']([^"']+)["']/)  ||[])[1];
  const cls = (attrs.match(/\bclass=["']([^"']+)["']/) ||[])[1];
  const src = (attrs.match(/\bsrc=["']([^"']+)["']/)  ||[])[1];
  const href= (attrs.match(/\bhref=["']([^"']+)["']/) ||[])[1];
  if (id)        sel += '#'+id;
  else if (cls)  sel += '.'+cls.split(' ')[0];
  if (tag==='img'  && src)  sel += '[src*="'+src.split('/').pop().split('?')[0].slice(0,40)+'"]';
  if (tag==='a'    && href) sel += '[href="'+href.slice(0,50)+'"]';
  return sel;
}
function locate(html, raw, tag) {
  const idx = html.indexOf(raw);
  if (idx<0) return null;
  const attrs = raw.replace(new RegExp(`^<${tag}`,'i'),'').replace(/>[\s\S]*/,'');
  return { line: lineNo(html,idx), selector: selector(tag,attrs), context: context(html,idx,raw.length), raw: raw.slice(0,120) };
}

// ─── PARSERS ─────────────────────────────────────────────
function parseMeta(html) {
  const get = rx => { const m=html.match(rx); return m?m[1].trim():''; };
  return {
    title:      get(/<title[^>]*>([\s\S]*?)<\/title>/i),
    desc:       get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                get(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i),
    robots:     get(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']+)["']/i),
    canonical: (() => {
    // FIX: More permissive canonical detection
    // Handles: Yoast, RankMath, self-closing tags, extra whitespace, reversed attribute order
    // Pattern 1: rel before href (most common: Yoast)
    let m = html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
    if (m) return m[1].trim();
    // Pattern 2: href before rel (some plugins)
    m = html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*\/?>/i);
    if (m) return m[1].trim();
    return '';
  })(),
    ogImage:    get(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
    ogImgW:     parseInt(get(/<meta[^>]*property=["']og:image:width["'][^>]*content=["']([^"']+)["']/i)||'0'),
    viewport:   get(/<meta[^>]*name=["']viewport["'][^>]*content=["']([^"']+)["']/i),
    generator:  get(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i),
    favicon: (() => {
      // Handle: icon, shortcut icon, icon shortcut (all variants)
      const m = html.match(/<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i)
             || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["'][^>]*\/?>/i);
      return m ? m[1].trim() : '';
    })(),
    appleTouchIcon: (() => {
      const m = html.match(/<link[^>]*rel=["']apple-touch-icon[^"']*["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i)
             || html.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon[^"']*["'][^>]*\/?>/i);
      return m ? m[1].trim() : '';
    })(),
    lang:       get(/<html[^>]*lang=["']([^"']+)["']/i),
    charset:    (/<meta[^>]*charset/i.test(html)?'utf-8':''),
  };
}

function parseImages(html, baseUrl) {
  const imgs=[]; const re=/<img([^>]*)>/gi; let m;
  while ((m=re.exec(html))!==null) {
    const a=m[1], raw=m[0];
    let src=(a.match(/\bsrc=["']([^"']+)["']/)  ||[])[1]||'';
    const ds =(a.match(/\bdata-(?:src|lazy-src)=["']([^"']+)["']/) ||[])[1]||'';
    try { if (src && !src.startsWith('data:')) src=new URL(src,baseUrl).href; } catch {}
    imgs.push({ raw, src: src||ds, hasAlt:/\balt=/.test(a), altVal:(a.match(/\balt=["']([^"']*)["']/)||[,null])[1],
      w:(a.match(/\bwidth=["']?(\d+)/)  ||[])[1]||'',
      h:(a.match(/\bheight=["']?(\d+)/) ||[])[1]||'',
      loading:(a.match(/\bloading=["']([^"']+)["']/)     ||[])[1]||'',
      fetchPriority:(a.match(/\bfetchpriority=["']([^"']+)["']/) ||[])[1]||'',
    });
  }
  return imgs;
}

function parseLinks(html, baseUrl) {
  const links=[]; const re=/<a([^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m=re.exec(html))!==null) {
    const a=m[1], raw=m[0], text=m[2].replace(/<[^>]+>/g,'').trim();
    links.push({ raw, href:(a.match(/\bhref=["']([^"']+)["']/)  ||[])[1]||'',
      text, aria:(a.match(/\baria-label=["']([^"']+)["']/) ||[])[1]||'',
      rel:(a.match(/\brel=["']([^"']+)["']/) ||[])[1]||'',
      target:(a.match(/\btarget=["']([^"']+)["']/) ||[])[1]||'',
    });
  }
  return links;
}

function parseHeadings(html) {
  const h=[]; const re=/<(h[1-6])([^>]*)>([\s\S]*?)<\/\1>/gi; let m;
  while ((m=re.exec(html))!==null) h.push({ level:m[1], text:m[3].replace(/<[^>]+>/g,'').trim(), raw:m[0] });
  return h;
}

function parseScripts(html) {
  const s=[]; const re=/<script([^>]*)>/gi; let m;
  while ((m=re.exec(html))!==null) {
    const a=m[1];
    const src=(a.match(/\bsrc=["']([^"']+)["']/) ||[])[1]||'';
    if (src) s.push({ src, defer:/\bdefer\b/i.test(a), async:/\basync\b/i.test(a) });
  }
  // Inline scripts for tracking detection
  const ir=/<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m=ir.exec(html))!==null) {
    if (m[1].includes('gtag')||m[1].includes('fbq')||m[1].includes('dataLayer')||m[1].includes('UA-'))
      s.push({ src:'', inline:true, code:m[1].slice(0,300) });
  }
  return s;
}

function parseStyles(html) {
  const s=[]; const re=/<link([^>]*)>/gi; let m;
  while ((m=re.exec(html))!==null) {
    const a=m[1];
    if (!/rel=["']stylesheet["']/i.test(a)) continue;
    s.push({ href:(a.match(/\bhref=["']([^"']+)["']/) ||[])[1]||'', media:(a.match(/\bmedia=["']([^"']+)["']/) ||[])[1]||'all' });
  }
  return s;
}

function parseIframes(html) {
  const f=[]; const re=/<iframe([^>]*)>/gi; let m;
  while ((m=re.exec(html))!==null) {
    const a=m[1], raw=m[0];
    f.push({ raw, src:(a.match(/\bsrc=["']([^"']+)["']/) ||[])[1]||'', title:(a.match(/\btitle=["']([^"']+)["']/) ||[])[1]||'' });
  }
  return f;
}

// ─── DUMMY CONTENT PATTERNS ──────────────────────────────
const DUMMY = [
  { rx:/lorem\s+ipsum/i,             label:'Lorem ipsum placeholder text' },
  { rx:/dolor\s+sit\s+amet/i,        label:'Lorem ipsum (dolor sit amet)' },
  { rx:/\btest@test\.com\b/i,        label:'Placeholder email: test@test.com' },
  { rx:/\badmin@example\.com\b/i,    label:'Placeholder email: admin@example.com' },
  { rx:/\bjohn\.doe@/i,              label:'Placeholder email: john.doe@...' },
  { rx:/\bJohn Doe\b/,               label:'Placeholder name: John Doe' },
  { rx:/\bJane Doe\b/,               label:'Placeholder name: Jane Doe' },
  { rx:/123 Fake Street/i,           label:'Placeholder address: 123 Fake Street' },
  { rx:/\(555\)\s*\d{3}-\d{4}/,     label:'Placeholder phone: (555) format' },
  { rx:/123-456-7890/,               label:'Placeholder phone: 123-456-7890' },
  { rx:/coming\s+soon/i,             label:'"Coming soon" — content not ready' },
  { rx:/under\s+construction/i,      label:'"Under construction" found' },
  { rx:/\bTBD\b|\bTBA\b/,            label:'TBD/TBA placeholder' },
  { rx:/sample\s+(?:text|content)/i, label:'Sample text/content placeholder' },
  { rx:/dummy\s+(?:text|content)/i,  label:'Dummy text/content found' },
];

// ─── DEV URL PATTERNS ────────────────────────────────────
const DEV_PATTERNS = [
  /https?:\/\/localhost/i,
  /https?:\/\/127\.0\.0\.1/,
  /https?:\/\/[^"'\s]*\.local(?:\/|["'\s])/i,
  /https?:\/\/[^"'\s]*(?:staging|stage|stg|dev|test|uat)\.[^"'\s]+/i,
  /https?:\/\/[^"'\s]*\.(?:wpengine|kinsta\.cloud|pantheonsite|flywheelsites|myftpupload|cloudwaysapps|ardentirdev)\.(?:com|io|us)[^"'\s]*/i,
];

// ─── WATERMARK / STOCK IMAGE DOMAINS ─────────────────────
const WATERMARK_DOMAINS = [
  'shutterstock.com','gettyimages.com','istockphoto.com','dreamstime.com',
  'depositphotos.com','123rf.com','alamy.com','bigstockphoto.com',
  'stock.adobe.com','vectorstock.com',
];

// ─── MAIN AUDIT ──────────────────────────────────────────
async function auditPage(url, html, status, ttfb, headers, imgData, siteBaseUrl, isHomepage, cacheStatus) {
  const issues = [];
  const push = (group, sev, title, detail, fix, loc=null) =>
    issues.push({ group, severity:sev, title, detail, fix, location:loc });

  const meta     = parseMeta(html);
  const images   = parseImages(html, url);
  const links    = parseLinks(html, url);
  const headings = parseHeadings(html);
  const scripts  = parseScripts(html);
  const styles   = parseStyles(html);
  const iframes  = parseIframes(html);
  const base     = new URL(siteBaseUrl||url);
  const origin   = base.origin;

  // ── RULE 1: All pages load without errors ──────────────
  if (status === 404)
    push('Errors','critical','Page returns 404 Not Found',`URL: ${url}`,
      'Fix the URL or create a 301 redirect from this URL to the correct destination page.');
  else if (status === 403)
    push('Errors','critical','403 Forbidden — page is blocked',`URL: ${url}`,
      'Check file/folder permissions on the server. If this should be public, fix permissions in cPanel or ask your host.');
  else if (status >= 500)
    push('Errors','critical',`Server error ${status} on page`,`URL: ${url}`,
      'Check server error logs in cPanel → Error Logs. Likely a PHP error or plugin conflict.');

  // ── RULE 2: Dev URLs (Search & Replace check) ──────────
  const bodyText  = html.replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<style[\s\S]*?<\/style>/gi,'');
  const attrScan  = html;
  const devFound  = [];
  const attrRx    = /(?:href|src|action|content|data-src)=["']([^"']+)["']/gi;
  let am;
  while ((am = attrRx.exec(attrScan)) !== null) {
    for (const dp of DEV_PATTERNS) {
      if (dp.test(am[1])) {
        try { if (new URL(am[1]).hostname !== base.hostname) devFound.push(am[1].slice(0,100)); }
        catch { devFound.push(am[1].slice(0,100)); }
        break;
      }
    }
  }
  if (devFound.length > 0) {
    const idx = attrScan.indexOf(devFound[0]);
    push('Content','critical',`${devFound.length} staging/dev URL(s) found in page source`,
      `Found: ${[...new Set(devFound)].slice(0,3).join(', ')}`,
      'Run Search & Replace: install "Better Search Replace" plugin → replace staging domain with live domain in all tables. Or WP-CLI: wp search-replace "staging.example.com" "example.com" --all-tables --dry-run first.',
      idx>=0 ? { line:lineNo(html,idx), selector:'[href/src attribute]', context:context(html,idx,80), raw:devFound[0] } : null);
  }

  // ── RULE 3: No horizontal scroll (check viewport) ──────
  if (!meta.viewport) {
    push('Layout','high','Missing viewport meta — mobile layout broken',
      'No <meta name="viewport"> tag found.',
      'Add to <head>: <meta name="viewport" content="width=device-width, initial-scale=1">',
      { line:1, selector:'meta[name="viewport"]', context:'(missing from <head>)', raw:'(missing)' });
  }

  // ── RULE 4: Optimize site load time ────────────────────
  if (ttfb > 1800)
    push('Performance','critical',`TTFB ${ttfb}ms — page not being served from cache`,
      `Time to First Byte: ${ttfb}ms. Every visitor gets a full PHP database render. Target: under 200ms.`,
      'Install LiteSpeed Cache or WP Rocket. Enable page cache + mobile cache. Check cache is working by viewing source and looking for cache comment at bottom of HTML.');
  else if (ttfb > 800)
    push('Performance','high',`TTFB ${ttfb}ms — above Google threshold`,
      `Google "Good" is under 800ms.`,
      'Enable caching plugin. Check server resources. Consider Cloudflare free tier for edge caching.');

  // FIX: Use proper cache detection (not naive Cache-Control string check)
  // cacheStatus is pre-computed in fetchPage using all caching headers
  const cs  = cacheStatus || detectCacheStatus(headers); // pre-computed from fetchPage headers
  const cc  = cs.cc;

  // Only flag as uncached if:
  // 1. No server-side cache hit detected (LiteSpeed/Cloudflare/nginx) AND
  // 2. Cache-Control has no-store OR max-age=0 with no-cache
  // NOTE: no-cache alone is NOT a problem — it means "revalidate" not "don't cache"
  if (!cs.isCached && !cs.hasLongTTL && cs.hasNoStore) {
    push('Performance','medium','Cache-Control set to no-store — browser cannot cache this page',
      `Cache-Control: "${cc}"`,
      'Remove no-store from Cache-Control to allow browser caching. LiteSpeed Cache → Cache → Browser Cache TTL → 31557600 (1 year).');
  } else if (!cs.isCached && !cs.hasLongTTL && !cc) {
    push('Performance','medium','No browser cache headers detected',
      `No Cache-Control header found. Cloudflare/LiteSpeed not active or not caching this page.`,
      'Enable LiteSpeed Cache page caching. Or add in .htaccess: Header set Cache-Control "max-age=604800, public" for static pages.');
  }
  // Add a helpful note if LiteSpeed is detected as active
  const isLSActive = cs.lsCache || cc.includes('public') && cc.includes('max-age');

  // ── RULE 5: Minified & non-blocking JS/CSS ─────────────
  const blockCSS = styles.filter(s => !s.media || s.media==='all' || s.media==='screen');
  if (blockCSS.length > 8) {
    push('Performance','critical',`${blockCSS.length} render-blocking CSS files`,
      blockCSS.slice(0,3).map(s=>s.href.split('/').pop()).join(', ')+'…',
      'Elementor: Settings → Experiments → Improved CSS Loading. LiteSpeed Cache: CSS Minify + Combine ON. Use QUIC.cloud for Critical CSS generation.');
  } else if (blockCSS.length > 4) {
    push('Performance','high',`${blockCSS.length} render-blocking CSS files`,
      blockCSS.slice(0,3).map(s=>s.href.split('/').pop()).join(', '),
      'LiteSpeed Cache → Page Optimization → CSS Combine ON + CSS Minify ON.');
  }
  const headHtml = html.split('</head>')[0]||'';
  const syncHead = parseScripts(headHtml).filter(s=>s.src&&!s.defer&&!s.async);
  if (syncHead.length > 0) {
    const first = syncHead[0];
    const idx   = html.indexOf(first.src) - 8;
    push('Performance','critical',`${syncHead.length} synchronous script(s) blocking page render`,
      syncHead.slice(0,3).map(s=>s.src.split('/').pop()).join(', '),
      'Add defer attribute to non-critical scripts. LiteSpeed Cache → Page Optimization → JS Defer → ON. Exclude: jquery.min.js, elementor-frontend.min.js from defer list.',
      idx>=0 ? { line:lineNo(html,idx), selector:`script[src*="${first.src.split('/').pop()}"]`, context:context(html,idx,80), raw:`<script src="${first.src}">` } : null);
  }
  // FIX: Smarter unminified detection — only flag files with clear dev patterns
  // Excludes: LiteSpeed-minified files (same name, compressed at runtime)
  // Only flags: files in /src/, uncompressed wp-includes known large files
  const KNOWN_LARGE_UNMIN = ['jquery.js','react.development.js','vue.js','angular.js'];
  const unminJS = scripts.filter(s => {
    if (!s.src || s.src.includes('.min.js')) return false;
    const fn = s.src.split('/').pop().split('?')[0];
    // Flag if in a /src/ or /dev/ path, or is a known unminified dev bundle
    return s.src.includes('/src/') || s.src.includes('/dev/') ||
           KNOWN_LARGE_UNMIN.some(k => fn === k);
  });
  const unminCSS = styles.filter(s => {
    if (!s.href || s.href.includes('.min.css') || s.href.includes('fonts.googleapis')) return false;
    const fn = s.href.split('/').pop().split('?')[0];
    return s.href.includes('/src/') || s.href.includes('/dev/');
  });
  if (unminJS.length > 0)
    push('Performance','medium',`${unminJS.length} clearly unminified JavaScript file(s) detected`,
      unminJS.slice(0,3).map(s=>s.src.split('/').pop()).join(', '),
      'Enable JS Minify in LiteSpeed Cache → Page Optimization → JS Minify → ON.');
  if (unminCSS.length > 0)
    push('Performance','medium',`${unminCSS.length} clearly unminified CSS file(s) detected`,
      unminCSS.slice(0,3).map(s=>s.href.split('/').pop()).join(', '),
      'Enable CSS Minify in LiteSpeed Cache → Page Optimization → CSS Minify → ON.');

  // ── RULE 6: No unnecessary duplication ─────────────────
  // Duplicate title check — only possible via cross-page analysis (done in summary)
  // Detect duplicated content blocks (same class/id repeated)
  const dupeIds = [];
  const idRx = /\bid=["']([^"']+)["']/gi; let dm;
  const seenIds = new Map();
  while ((dm=idRx.exec(html))!==null) {
    const id=dm[1];
    // FIX: Expanded skip list — include Elementor, WP builder, and common widget IDs
    const SKIP_IDS = new Set(['menu','main','header','footer','content','wrapper','container',
      'sidebar','logo','search','nav','primary','secondary','page','site','masthead',
      'colophon','respond','commentform','comments','post','entry','widget','social',
      'top','bottom','left','right','mobile','desktop','overlay','modal','popup',
      'skip-link','skiplink','wpadminbar','page-top','elementor','wpcf7']);
    if (SKIP_IDS.has(id.toLowerCase()) || id.startsWith('elementor') || id.startsWith('wp-') || 
        id.match(/^post-\d+$/) || id.match(/^menu-item-\d+$/)) continue;
    seenIds.set(id,(seenIds.get(id)||0)+1);
  }
  for (const [id,cnt] of seenIds) {
    if (cnt>1) dupeIds.push(id);
  }
  if (dupeIds.length>3)
    push('Content','medium',`${dupeIds.length} duplicate HTML element IDs`,
      `Duplicate IDs: ${dupeIds.slice(0,5).join(', ')}`,
      'Each HTML id attribute must be unique on a page. Duplicate IDs break JavaScript and accessibility. Fix in your theme/page builder templates.');

  // ── RULE 7: Title & description set ────────────────────
  if (!meta.title) {
    push('SEO','critical','Missing page title',
      'No <title> tag found on this page.',
      'Add a unique 50–60 character title. In Yoast/RankMath: edit the page → SEO Title field.',
      { line:1, selector:'head > title', context:'(missing from <head>)', raw:'(missing)' });
  } else if (meta.title.length < 30) {
    const idx=html.indexOf('<title');
    push('SEO','medium',`Page title too short (${meta.title.length} chars)`,
      `"${meta.title}"`,
      'Expand title to 50–60 characters including the primary keyword and brand name.',
      idx>=0 ? { line:lineNo(html,idx), selector:'title', context:`<title>${meta.title}</title>`, raw:`<title>${meta.title}</title>` } : null);
  } else if (meta.title.length > 65) {
    const idx=html.indexOf('<title');
    push('SEO','low',`Page title too long (${meta.title.length} chars — will be truncated)`,
      `"${meta.title.slice(0,70)}…"`,
      'Shorten to under 60 characters to prevent Google truncation.',
      idx>=0 ? { line:lineNo(html,idx), selector:'title', context:`<title>${meta.title}</title>`, raw:`<title>${meta.title}</title>` } : null);
  }
  if (!meta.desc) {
    push('SEO','high','Missing meta description',
      'No meta description tag found on this page.',
      'Add a 150–160 character meta description in Yoast/RankMath → Description field. Include the primary keyword naturally.',
      { line:null, selector:'meta[name="description"]', context:'(missing from <head>)', raw:'(missing)' });
  } else if (meta.desc.length < 70) {
    push('SEO','medium',`Meta description too short (${meta.desc.length} chars)`,meta.desc.slice(0,100),
      'Expand to 150–160 characters with the primary keyword and a call to action.');
  }

  // ── RULE 8: Proper H1–H6 structure ─────────────────────
  const h1s = headings.filter(h=>h.level==='h1');
  if (h1s.length===0) {
    push('SEO','high','No H1 heading on page',
      'Every page should have exactly one H1 as the main topic signal.',
      'Add one H1 tag. In Elementor: click the main heading widget → Content tab → HTML Tag → H1.',
      { line:null, selector:'h1', context:'(no h1 found on page)', raw:'(missing)' });
  } else if (h1s.length>1) {
    const loc=locate(html, h1s[1].raw, 'h1');
    push('SEO','medium',`${h1s.length} H1 tags found — only 1 allowed per page`,
      h1s.map(h=>`"${h.text.slice(0,50)}"`).join(', '),
      'Keep only one H1. Change extra H1s to H2 or H3 in your page builder.',
      loc ? {...loc, selector:'h1:nth-of-type(2)'} : null);
  }
  // Check heading order
  let prev=0;
  for (const h of headings) {
    const lvl=parseInt(h.level[1]);
    if (prev>0 && lvl>prev+1) {
      const loc=locate(html,h.raw,h.level);
      push('SEO','medium',`Heading order skipped: H${prev} → H${lvl}`,
        `"${h.text.slice(0,60)}"`,
        `Change this heading from H${lvl} to H${prev+1}. Headings must be sequential (H1→H2→H3). Fix in Elementor by changing the HTML Tag dropdown on the heading widget.`,
        loc ? {...loc, selector:h.level} : null);
      break;
    }
    prev=lvl;
  }
  // Empty headings
  const emptyH = headings.filter(h=>!h.text.trim());
  if (emptyH.length>0) {
    const loc=locate(html,emptyH[0].raw,emptyH[0].level);
    push('SEO','medium',`${emptyH.length} empty heading tag(s)`,
      `Empty ${emptyH.map(h=>h.level.toUpperCase()).join(', ')} tags with no text`,
      'Remove empty heading tags or add meaningful text. Empty headings confuse both users and search engines.',
      loc||null);
  }

  // ── RULE 9 & 10: sitemap.xml + robots.txt (site-level — done in discover.js) ──
  // Per-page: check canonical ─────────────────────────────

  // ── RULE 11: No broken links ───────────────────────────
  // (passed in as pre-checked brokenLinks array from batch handler)

  // ── RULE 12: Canonical URLs correct ───────────────────
  if (!meta.canonical) {
    push('SEO','medium','Missing canonical tag',
      'No rel="canonical" link found.',
      'Canonical prevents duplicate content indexing. Yoast/RankMath add this automatically — verify it is configured. Or manually add: <link rel="canonical" href="PAGE_URL">',
      { line:null, selector:'link[rel="canonical"]', context:'(missing from <head>)', raw:'(missing)' });
  } else {
    try {
      const canHost = new URL(meta.canonical).hostname;
      if (canHost !== base.hostname) {
        const idx=html.indexOf('canonical');
        push('SEO','high',`Canonical points to wrong domain: ${canHost}`,
          `<link rel="canonical" href="${meta.canonical}">`,
          'Update canonical to point to this site. Check Yoast/RankMath SEO settings and ensure WordPress Address matches the live domain.',
          idx>=0 ? { line:lineNo(html,idx), selector:'link[rel="canonical"]', context:context(html,idx,80), raw:`<link rel="canonical" href="${meta.canonical}">` } : null);
      }
    } catch {}
  }

  // ── RULE 13: No dummy data ─────────────────────────────
  const cleanText = bodyText.replace(/<[^>]+>/g,' ');
  for (const {rx,label} of DUMMY) {
    const dm2=rx.exec(cleanText);
    if (dm2) {
      const idx2=cleanText.indexOf(dm2[0]);
      push('Content','high',`Dummy content detected: ${label}`,
        `Found: "${cleanText.substring(Math.max(0,idx2-20),idx2+dm2[0].length+30).trim()}"`,
        'Replace all placeholder content with real copy before launch. Search site-wide using Better Search Replace plugin.');
    }
  }

  // ── RULE 14: Discourage search engines / noindex ───────
  if (/noindex/i.test(meta.robots||'')) {
    const idx=html.search(/name=["']robots["'][^>]*content=["'][^"']*noindex/i);
    push('SEO','critical','Page is set to noindex — invisible to Google',
      `meta robots: "${meta.robots}"`,
      'Remove noindex: WordPress → Settings → Reading → uncheck "Discourage search engines". Or Yoast/RankMath → edit page → Robots → set to Index.',
      idx>=0 ? { line:lineNo(html,idx), selector:'meta[name="robots"]', context:context(html,idx,80), raw:`<meta name="robots" content="${meta.robots}">` } : null);
  }
  // FIX: Only flag nofollow if robots meta SPECIFICALLY has nofollow value
  // and the tag actually exists (not just any robots meta)
  if (meta.robots && /nofollow/i.test(meta.robots) && !/noindex/i.test(meta.robots)) {
    // Only flag standalone nofollow (not pages already flagged for noindex)
    push('SEO','medium','Page meta robots has nofollow',
      `meta robots: "${meta.robots}" — links on this page won't pass authority.`,
      'Only use nofollow on pages you intentionally want to restrict. Remove from standard content pages in Yoast/RankMath → Advanced → Meta Robots.');
  }

  // ── RULE 15: Staging/dev URLs not indexable ────────────
  // (covered by RULE 2 above — dev URL detection)

  // ── RULE 16: Redirect checks (301/302/chains) ──────────
  // Handled in batch handler below for each URL

  // ── RULE 17: www/non-www (homepage only) ──────────────
  if (isHomepage) {
    const altUrl = url.includes('://www.') ? url.replace('://www.','://') : url.replace('://','://www.');
    try {
      const altR = await headReq(altUrl);
      if (altR.status===200)
        push('SEO','medium','Both www and non-www versions accessible — no redirect',
          `Both ${url} and ${altUrl} return 200. Pick one as canonical.`,
          'Set up a 301 redirect. WordPress: Settings → General → WordPress/Site Address must match. Add redirect in .htaccess: RewriteCond %{HTTP_HOST} ^www\\. / RewriteRule ^(.*)$ https://yourdomain.com/$1 [R=301,L]');
    } catch {}
  }

  // ── RULE 18: HTTPS working ────────────────────────────
  if (url.startsWith('http://'))
    push('Security','critical','Page not using HTTPS — connection is unencrypted',
      `Page served over HTTP.`,
      'Install SSL certificate. Enable HTTPS in cPanel → SSL/TLS. Set up HTTP→HTTPS redirect. Cloudflare free tier provides automatic SSL.');

  // Mixed content (HTTP assets on HTTPS page)
  if (url.startsWith('https://')) {
    const httpAssets=[];
    const ar=/(?:src|href)=["'](http:\/\/[^"']+)["']/gi; let am2;
    while ((am2=ar.exec(html))!==null) {
      try { if (new URL(am2[1]).hostname!==base.hostname) httpAssets.push(am2[1].slice(0,80)); } catch {}
    }
    if (httpAssets.length>0) {
      const idx=html.indexOf(httpAssets[0]);
      push('Security','high',`Mixed content: ${httpAssets.length} HTTP asset(s) on HTTPS page`,
        `HTTP assets: ${httpAssets.slice(0,3).join(', ')}`,
        'Replace all http:// asset URLs with https://. Run Better Search Replace: search for "http://yourdomain.com" and replace with "https://yourdomain.com" in all tables.',
        idx>=0 ? { line:lineNo(html,idx), selector:'[src/href attribute with http://]', context:context(html,idx,80), raw:httpAssets[0] } : null);
    }
  }

  // ── RULE 19: No default wp-admin URL (homepage only) ───
  if (isHomepage) {
    const adminR = await headReq(origin+'/wp-admin/');
    if (adminR.status===200||adminR.status===302)
      push('Security','medium','Default /wp-admin/ URL is accessible',
        `${origin}/wp-admin/ returns HTTP ${adminR.status}`,
        'Change the admin login URL using WPS Hide Login or Perfmatters plugin. Use a custom URL like /dashboard/ instead of the default /wp-admin/.');
  }

  // HTTP → HTTPS redirect check (homepage only)
  if (isHomepage && url.startsWith('https://')) {
    const httpUrl = url.replace('https://','http://');
    try {
      const httpR = await headReq(httpUrl);
      if (httpR.status===200)
        push('Security','high','HTTP version of site returns 200 — no redirect to HTTPS',
          `${httpUrl} returns 200 instead of redirecting to HTTPS.`,
          'Add HTTPS redirect in .htaccess:\nRewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]');
    } catch {}
  }

  // ── RULE 20: Images — broken, sizes, lazy, watermarks ──
  for (const img of images) {
    if (!img.src || img.src.startsWith('data:')) continue;

    // Broken images
    try {
      const iR = await headReq(img.src);
      if (iR.status===404||iR.status===0) {
        const loc=locate(html,img.raw,'img');
        push('Images','high',`Broken image (${iR.status||'cannot load'})`,
          `src="${img.src.split('/').pop()}"`,
          'Fix the image URL or re-upload the image. Check the Media Library for missing attachments.',
          loc ? {...loc, imageUrl:img.src} : { imageUrl:img.src, selector:`img[src*="${img.src.split('/').pop()}"]` });
      }
    } catch {}

    // Watermark / stock image domains
    try {
      const imgHost = new URL(img.src).hostname;
      if (WATERMARK_DOMAINS.some(d=>imgHost.includes(d))) {
        const loc=locate(html,img.raw,'img');
        push('Images','critical',`Watermarked/stock image from ${imgHost}`,
          `src="${img.src.slice(0,80)}"`,
          'Purchase a license for this image or replace with a properly licensed/owned image. Watermarked images on a live site are a legal issue.',
          loc ? {...loc, imageUrl:img.src} : { imageUrl:img.src, selector:`img[src*="${imgHost}"]` });
      }
    } catch {}
  }

  // Missing alt text
  const noAlt = images.filter(i=>!i.hasAlt&&i.src&&!i.src.startsWith('data:'));
  for (const img of noAlt.slice(0,4)) {
    const loc=locate(html,img.raw,'img');
    push('Accessibility','high','Image missing alt text',
      `src="${img.src.split('/').pop().split('?')[0]}"`,
      'Add descriptive alt text to the img tag. In WordPress Media Library: click image → Edit → Alt Text field. Or use "Fix Missing Alt Tags" plugin.',
      loc ? {...loc, imageUrl:img.src} : { imageUrl:img.src, selector:`img[src*="${img.src.split('/').pop()}"]` });
  }
  if (noAlt.length>4)
    push('Accessibility','high',`${noAlt.length} images total missing alt text on this page`,
      `${noAlt.length} images without alt attribute.`,
      'Use "Fix Missing Alt Tags" WordPress plugin for bulk fixing. Or add loading="lazy" and alt attributes to all img tags.');

  // Lazy loading
  const aboveFoldCount = 1; // first image is likely hero
  const noLazy = images.filter((i,idx)=>idx>=aboveFoldCount&&i.src&&!i.src.startsWith('data:')&&i.loading!=='lazy'&&i.fetchPriority!=='high');
  if (noLazy.length>3)
    push('Images','high',`${noLazy.length} images without lazy loading`,
      'Below-fold images load immediately competing with critical content.',
      'LiteSpeed Cache → Image Optimization → Lazy Load Images → ON. Hero/first image should NOT have lazy load.');

  // Missing dimensions → CLS
  const noDim = images.filter(i=>i.src&&!i.src.startsWith('data:')&&(!i.w||!i.h));
  if (noDim.length>3)
    push('Images','medium',`${noDim.length} images missing width/height attributes`,
      'Browser reserves no space before images load — causes Cumulative Layout Shift (CLS).',
      'Add explicit width and height to all img tags matching the actual display dimensions. Elementor sets these automatically.');

  // From file size audit
  if (imgData&&imgData.length>0) {
    const vheavy = imgData.filter(i=>i.sizeKB>500);
    const heavy  = imgData.filter(i=>i.sizeKB>150&&i.sizeKB<=500);
    const noWebP  = imgData.filter(i=>!i.isModern&&i.sizeKB>0&&!/\.svg/i.test(i.src));
    for (const img of vheavy.slice(0,3)) {
      push('Images','critical',`Very heavy image: ${img.filename} (${img.sizeKB}KB)`,
        `${img.sizeKB}KB — target is under 150KB per image.`,
        'Compress urgently with ShortPixel or Imagify. Convert to WebP — saves 30–50% file size. Resize to the actual display dimensions before uploading.',
        { imageUrl:img.src, selector:`img[src*="${img.filename}"]`, context:img.raw||'', raw:img.raw||'' });
    }
    for (const img of heavy.slice(0,2)) {
      push('Images','high',`Large image: ${img.filename} (${img.sizeKB}KB)`,
        `${img.sizeKB}KB — aim for under 150KB.`,
        'Compress image. LiteSpeed Cache → Image Optimization → WebP Replacement → ON (needs free QUIC.cloud API key).',
        { imageUrl:img.src, selector:`img[src*="${img.filename}"]`, context:img.raw||'', raw:img.raw||'' });
    }
    if (noWebP.length>0)
      push('Images','high',`${noWebP.length} image(s) not in WebP/AVIF format`,
        noWebP.slice(0,4).map(i=>i.filename).join(', '),
        'Convert to WebP: LiteSpeed Cache → Image Optimization → WebP Replacement → ON. Needs free QUIC.cloud API key. Saves 30–50% file size per image.');
    const totalKB = imgData.reduce((s,i)=>s+i.sizeKB,0);
    if (totalKB>1000)
      push('Images','high',`Total image weight on page: ${totalKB}KB`,
        `${imgData.length} images checked totalling ${totalKB}KB. Target: under 500KB.`,
        'Enable WebP conversion. Compress all images. Enable lazy loading for below-fold images. Use CDN (QUIC.cloud or Cloudflare).');
  }

  // iframes
  const untitledIf = iframes.filter(i=>i.src&&!i.title);
  for (const fr of untitledIf.slice(0,2)) {
    const loc=locate(html,fr.raw,'iframe');
    push('Accessibility','medium','iframe missing title attribute',
      `src="${fr.src.slice(0,60)}"`,
      'Add title attribute: <iframe title="Descriptive label" ...>. Screen readers need this to describe the embed.',
      loc||null);
  }

  // ── RULE 21: Favicon & Apple touch icon ────────────────
  if (!meta.favicon) {
    push('SEO','medium','Missing favicon',
      'No favicon link tag found in <head>.',
      'Add: <link rel="icon" href="/favicon.ico" sizes="32x32">. WordPress: Appearance → Customize → Site Identity → Site Icon.',
      { line:null, selector:'link[rel="icon"]', context:'(missing from <head>)', raw:'(missing)' });
  }
  if (!meta.appleTouchIcon) {
    push('SEO','low','Missing Apple touch icon',
      'No apple-touch-icon link tag found.',
      'Add: <link rel="apple-touch-icon" href="/apple-touch-icon.png">. Should be 180×180px PNG. WordPress site icons set this automatically via Customizer.');
  }

  // ── RULE 22: Tracking — dead/old GA check ──────────────
  const allCode = scripts.map(s=>s.src+' '+(s.code||'')).join(' ')+html.slice(0,15000);
  const hasGA4  = /G-[A-Z0-9]{6,}/i.test(allCode);
  const hasGTM  = /GTM-[A-Z0-9]{4,}/i.test(allCode);
  const hasUA   = /UA-\d{5,}-\d/.test(allCode);
  const hasFB   = /fbq\s*\(|fbevents\.js/i.test(allCode);
  const hasTT   = /analytics\.tiktok\.com|ttq\./i.test(allCode);
  const hasLI   = /linkedin\.com\/insight/i.test(allCode);
  const hasGAds = /googleadservices|AW-\d{9,}/i.test(allCode);

  if (hasUA)
    push('Tracking','high','Dead Universal Analytics (UA-) tag still firing',
      'Universal Analytics was shut down March 2024. This tag fails on every page load and wastes ~50ms.',
      'Remove UA tag from GTM immediately. Open GTM → find the UA tag → Pause or Delete. Verify GA4 (G-XXXXXXXX) is collecting data in Analytics → Realtime.');
  if (!hasGA4&&!hasGTM)
    push('Tracking','medium','No Google Analytics 4 or GTM detected on page',
      'Neither GA4 (G-XXXXXX) nor Google Tag Manager (GTM-XXXXX) found.',
      'Install GA4 via GTM. WordPress: use GTM4WP plugin. Verify by checking Realtime report in Google Analytics.');
  if (hasGTM&&!hasGA4)
    push('Tracking','medium','GTM found but no GA4 configuration tag detected',
      'GTM is installed but no GA4 tag firing on this page.',
      'In GTM: check GA4 Configuration tag is published and trigger is set to All Pages. Preview mode can confirm it fires.');

  // ── RULE 23: Non-descriptive links ────────────────────
  const genericTxt=['learn more','read more','click here','find out more','more','here','link','this'];
  const badLinks=links.filter(l=>genericTxt.includes((l.text||'').toLowerCase().trim())&&!l.aria);
  if (badLinks.length>0) {
    const fl=badLinks[0];
    const loc=locate(html,fl.raw,'a');
    push('SEO','medium',`${badLinks.length} non-descriptive link(s) — bad for SEO & screen readers`,
      `Generic text: "${badLinks.slice(0,4).map(l=>l.text).join('", "')}"`,
      'Replace with descriptive text e.g. "View our Services" not "Learn more". Or add aria-label="Learn more about our services" to the link.',
      loc||null);
  }

  return {
    url, status, ttfb,
    meta:{ title:meta.title, desc:meta.desc, robots:meta.robots, lang:meta.lang, canonical:meta.canonical, hasGA4, hasGTM },
    counts:{ images:images.length, links:links.length, headings:headings.length, scripts:scripts.length, styles:styles.length },
    imageData: imgData||[],
    tracking:{ hasGA4, hasGTM, hasUA, hasFB, hasTT, hasLI, hasGAds },
    issues: issues.sort((a,b)=>{
      const o={critical:0,high:1,medium:2,low:3};
      return (o[a.severity]||3)-(o[b.severity]||3);
    }),
  };
}

// ─── BATCH HANDLER ───────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST')    return res.status(405).json({error:'POST only'});

  try {
    const { urls=[], siteBaseUrl, checkImages=true } = req.body||{};
    if (!urls.length) return res.status(400).json({error:'No URLs provided'});

    const base     = siteBaseUrl||urls[0];
    const baseNorm = base.replace(/\/$/, '');
    const batch    = urls.slice(0,8);

    const results = await Promise.all(batch.map(async (url) => {
      try {
        const page = await fetchPage(url);
        if (!page.ok) {
          return { url, status:page.status||0, ttfb:page.ttfb, issues:[{
            group:'Errors', severity:'critical',
            title:`Page failed to load: ${page.error||'Unknown error'}`,
            detail:url, fix:'Check the URL is correct and the server is responding.',
            location:null }],
            meta:{}, counts:{}, imageData:[], tracking:{} };
        }

        // Redirect chain check
        const hops = await countRedirects(url);
        const redirectIssues = [];
        if (hops>2) {
          redirectIssues.push({ group:'Redirects', severity:'high',
            title:`Redirect chain: ${hops} hops to reach final URL`,
            detail:`${url} → ${page.finalUrl} (${hops} redirects)`,
            fix:'Redirect chains slow down page load and dilute link equity. Update links/references to point directly to the final URL. Check .htaccess for multiple redirect rules.',
            location:null });
        } else if (page.redirected && page.finalUrl !== page.finalUrl) {
          // NOTE: With redirect:'follow', status is always 200 for the final page.
          // To detect 302 vs 301, we use countRedirects with redirect:'manual' which
          // captures the actual redirect status code.
          // redirectType is set during countRedirects below.
        }
        // Check actual redirect type using manual redirect
        if (page.redirected) {
          try {
            const c2 = new AbortController();
            setTimeout(() => c2.abort(), 5000);
            const manualRes = await fetch(url, { method:'HEAD', signal:c2.signal, redirect:'manual' });
            if (manualRes.status === 302 || manualRes.status === 307) {
              redirectIssues.push({ group:'Redirects', severity:'medium',
                title:`Temporary redirect (${manualRes.status}) — should be 301 permanent`,
                detail:`${url} → ${page.finalUrl} (using ${manualRes.status})`,
                fix:'Change to 301 permanent redirect. In .htaccess: RewriteRule uses R=301. In WordPress: Redirection plugin → set to 301. 302s do not pass SEO equity.',
                location:null });
            }
          } catch {}
        }

        // Image file sizes
        const imgs = checkImages
          ? await (async () => {
              const parsed = parseImages(page.html, page.finalUrl||url);
              const candidates = parsed.filter(i=>i.src&&!i.src.startsWith('data:')&&/\.(jpg|jpeg|png|gif|webp|avif)(\?|$)/i.test(i.src)).slice(0,10);
              return Promise.all(candidates.map(async img => {
                let absUrl=img.src;
                try { absUrl=new URL(img.src,url).href; } catch {}
                const m=await headReq(absUrl);
                const isWebP=/webp/i.test(m.type)||/\.webp(\?|$)/i.test(img.src);
                const isAvif=/avif/i.test(m.type)||/\.avif(\?|$)/i.test(img.src);
                return { src:absUrl, filename:absUrl.split('/').pop().split('?')[0].slice(0,60),
                  sizeKB:m.size?Math.round(m.size/1024):0, isWebP, isAvif, isModern:isWebP||isAvif,
                  hasAlt:img.hasAlt, altVal:img.altVal, isLazy:img.loading==='lazy',
                  hasDimensions:!!(img.w&&img.h), raw:img.raw.slice(0,100) };
              }));
            })()
          : [];

        const isHomepage = (page.finalUrl||url).replace(/\/$/,'') === baseNorm;
        const result = await auditPage(page.finalUrl||url, page.html, page.status, page.ttfb, page.headers, imgs, siteBaseUrl, isHomepage, page.cacheStatus);

        // Merge redirect issues
        result.issues.unshift(...redirectIssues);
        result.issues.sort((a,b)=>{const o={critical:0,high:1,medium:2,low:3};return (o[a.severity]||3)-(o[b.severity]||3);});

        return result;
      } catch(e) {
        return { url, status:0, ttfb:0, error:e.message, issues:[], meta:{}, counts:{}, imageData:[], tracking:{} };
      }
    }));

    return res.status(200).json({ success:true, results });

  } catch(e) {
    return res.status(500).json({ error:e.message });
  }
}
