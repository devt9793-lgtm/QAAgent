// api/audit.js — Vercel Serverless Function
// Site Audit Agent — crawls a URL and runs all checks

export const config = { maxDuration: 60 };

// ── Fetch a page ─────────────────────────────────────────
async function fetchPage(url) {
  const start = Date.now();
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 14000);
    const res = await fetch(url, {
      signal: c.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QASiteAuditBot/1.0; +https://qa-lime-nine.vercel.app)', 'Accept': 'text/html' },
      redirect: 'follow',
    });
    clearTimeout(t);
    const html = await res.text();
    return { ok: true, html, status: res.status, ttfb: Date.now() - start, finalUrl: res.url, headers: Object.fromEntries(res.headers) };
  } catch(e) {
    return { ok: false, error: e.message, ttfb: Date.now() - start };
  }
}

// ── Extract internal links ────────────────────────────────
function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const found = new Set();
  const re = /href=["']([^"'#?][^"']*?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.hostname === base.hostname) {
        const clean = abs.origin + abs.pathname.replace(/\/$/, '');
        if (clean !== base.origin && !clean.includes('/wp-') && !clean.includes('/feed') && !clean.match(/\.(jpg|png|gif|pdf|zip|css|js|xml|ico|svg|webp)$/i)) {
          found.add(clean);
        }
      }
    } catch {}
  }
  return [...found].slice(0, 28);
}

// ── Regex helpers ─────────────────────────────────────────
const rxAttr   = (tag, attr) => new RegExp(`<${tag}[^>]*\\b${attr}=["\']([^"\']*)["\'][^>]*>`, 'gi');
const rxFirst  = (html, rx)  => { const m = rx.exec(html); return m ? m[1] : ''; };

function parseImages(html) {
  const imgs = []; const re = /<img([^>]*)>/gi; let m;
  while ((m = re.exec(html)) !== null) {
    const a=m[1];
    imgs.push({
      src:     (a.match(/\bsrc=["']([^"']+)["']/) ||[])[1]||'',
      hasAlt:  /\balt=/.test(a),
      altVal:  (a.match(/\balt=["']([^"']*)["']/) ||[,null])[1],
      w:       (a.match(/\bwidth=["']?(\d+)/) ||[])[1],
      h:       (a.match(/\bheight=["']?(\d+)/) ||[])[1],
      loading: (a.match(/\bloading=["']([^"']+)["']/) ||[])[1]||'',
    });
  }
  return imgs;
}
function parseLinks(html) {
  const links=[]; const re=/<a([^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m=re.exec(html))!==null) {
    const attrs=m[1], inner=m[2].replace(/<[^>]+>/g,'').trim();
    links.push({ href:(attrs.match(/\bhref=["']([^"']+)["']/) ||[])[1]||'', text:inner, aria:(attrs.match(/\baria-label=["']([^"']+)["']/) ||[])[1]||'' });
  }
  return links;
}
function parseHeadings(html) {
  const h=[]; const re=/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi; let m;
  while ((m=re.exec(html))!==null) h.push({ level:m[1], text:m[2].replace(/<[^>]+>/g,'').trim() });
  return h;
}
function parseScripts(html) {
  const s=[]; const re=/<script([^>]*)>/gi; let m;
  while ((m=re.exec(html))!==null) {
    const a=m[1], src=(a.match(/\bsrc=["']([^"']+)["']/) ||[])[1]||'';
    if (src) s.push({ src, defer:/\bdefer\b/i.test(a), async:/\basync\b/i.test(a), type:(a.match(/\btype=["']([^"']+)["']/) ||[])[1]||'' });
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
    const a=m[1];
    f.push({ src:(a.match(/\bsrc=["']([^"']+)["']/) ||[])[1]||'', title:(a.match(/\btitle=["']([^"']+)["']/) ||[])[1]||'', loading:(a.match(/\bloading=["']([^"']+)["']/) ||[])[1]||'' });
  }
  return f;
}
function parseMeta(html) {
  const get = (pattern) => { const m=html.match(pattern); return m?m[1]:''; };
  return {
    title:       get(/<title[^>]*>([\s\S]*?)<\/title>/i),
    desc:        get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) || get(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i),
    robots:      get(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']+)["']/i) || 'index,follow',
    canonical:   get(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i),
    ogImage:     get(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
    ogImgW:  parseInt(get(/<meta[^>]*property=["']og:image:width["'][^>]*content=["']([^"']+)["']/i)||'0'),
    viewport:    get(/<meta[^>]*name=["']viewport["'][^>]*content=["']([^"']+)["']/i),
    generator:   get(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i),
  };
}

// ── Main audit function ───────────────────────────────────
function auditPage(url, html, status, ttfb, headers) {
  const issues = [];
  const meta     = parseMeta(html);
  const images   = parseImages(html);
  const links    = parseLinks(html);
  const headings = parseHeadings(html);
  const scripts  = parseScripts(html);
  const styles   = parseStyles(html);
  const iframes  = parseIframes(html);

  const push = (category, severity, title, detail, fix) => issues.push({ category, severity, title, detail, fix });

  // ── SEO ─────────────────────────────────────────────────
  if (/noindex/i.test(meta.robots))
    push('SEO','critical','Page is set to noindex',`meta robots: "${meta.robots}"`, 'WordPress → Settings → Reading → uncheck "Discourage search engines". Yoast/RankMath → set to index.');
  if (!meta.title)
    push('SEO','critical','Missing page title','No <title> tag found.','Add a unique 50–60 character title tag to every page.');
  else if (meta.title.length < 30)
    push('SEO','medium',`Title too short (${meta.title.length} chars)`,`"${meta.title.slice(0,60)}"`, 'Expand title to 50–60 characters with keywords and brand name.');
  else if (meta.title.length > 65)
    push('SEO','low',`Title too long (${meta.title.length} chars)`,`"${meta.title.slice(0,60)}…"`, 'Shorten title to under 60 characters to avoid Google truncation.');
  if (!meta.desc)
    push('SEO','high','Missing meta description','No meta description tag found.','Add 150–160 char meta description in Yoast/RankMath SEO → Edit page → Description.');
  else if (meta.desc.length < 70)
    push('SEO','medium',`Meta description too short (${meta.desc.length} chars)`, meta.desc.slice(0,80), 'Expand to 150–160 characters.');
  if (!meta.canonical)
    push('SEO','medium','Missing canonical tag','No rel="canonical" found.','Add canonical tag to prevent duplicate content issues.');
  if (!meta.ogImage)
    push('SEO','medium','Missing og:image','No Open Graph image — social shares show no preview.','Add 1200×630px og:image in Yoast/RankMath → Social tab.');
  else if (meta.ogImgW > 1600)
    push('SEO','medium',`og:image oversized (${meta.ogImgW}px wide)`,`Should be 1200×630px. Currently ${meta.ogImgW}px wide.`,'Resize og:image to exactly 1200×630px to reduce bandwidth and fix social previews.');
  if (!meta.viewport)
    push('SEO','high','Missing viewport meta tag','Page will not render correctly on mobile.','Add <meta name="viewport" content="width=device-width, initial-scale=1">.');
  const h1s = headings.filter(h=>h.level==='h1');
  if (h1s.length===0)
    push('SEO','high','No H1 heading on page','No H1 found.','Add exactly one H1 tag as the main page heading.');
  else if (h1s.length>1)
    push('SEO','medium',`Multiple H1 tags (${h1s.length})`, h1s.map(h=>'"'+h.text.slice(0,40)+'"').join(', '),'Keep only one H1 per page. Change extras to H2 or H3.');
  const generic = ['learn more','read more','click here','find out more','more','here'];
  const badLinks = links.filter(l=>generic.includes((l.text||'').toLowerCase().trim())&&!l.aria);
  if (badLinks.length>0)
    push('SEO','high',`${badLinks.length} non-descriptive link(s)`,`"${badLinks.slice(0,4).map(l=>l.text).join('", "')}"`, 'Replace generic link text with the destination page title. Add aria-label if text cannot change.');
  let prevLvl=0;
  for (const h of headings) {
    const lvl=parseInt(h.level[1]);
    if (prevLvl>0 && lvl>prevLvl+1) { push('Accessibility','medium','Heading level skipped',`H${prevLvl} → H${lvl}: "${h.text.slice(0,50)}"`, 'Use sequential heading levels (H1→H2→H3). Never skip a level.'); break; }
    prevLvl=lvl;
  }

  // ── Performance ──────────────────────────────────────────
  if (ttfb>1800) push('Performance','critical',`TTFB: ${ttfb}ms (too slow)`, 'Page not served from cache — every visitor gets full PHP render.', 'Enable page caching (LiteSpeed Cache/WP Rocket). Enable "Cache Mobile". TTFB should be <200ms with cache.');
  else if (ttfb>800) push('Performance','high',`TTFB: ${ttfb}ms`, 'Over 800ms. Google "Good" threshold is <800ms.', 'Check server response time. Enable caching plugin. Consider faster hosting.');
  const cc = headers['cache-control']||headers['Cache-Control']||'';
  if (!cc||cc.includes('no-cache')||cc.includes('no-store'))
    push('Performance','high','No browser cache headers',`Cache-Control: "${cc||'missing'}"`, 'Set Cache-Control for static assets. LiteSpeed Cache → Browser Cache TTL → 31557600 (1 year).');
  const blockCSS = styles.filter(s=>!s.media||s.media==='all'||s.media==='screen');
  if (blockCSS.length>8) push('Performance','critical',`${blockCSS.length} render-blocking CSS files`, blockCSS.slice(0,3).map(s=>s.href.split('/').pop()).join(', '), 'Enable Elementor Improved CSS Loading. LiteSpeed: CSS Minify + Combine. QUIC.cloud for Critical CSS.');
  else if (blockCSS.length>4) push('Performance','high',`${blockCSS.length} render-blocking CSS files`, 'Multiple external CSS files blocking first paint.', 'Enable CSS Combine + Minify in LiteSpeed Cache.');
  const headHtml = html.split('</head>')[0]||'';
  const syncHead = parseScripts(headHtml).filter(s=>!s.defer&&!s.async&&s.src&&!s.type);
  if (syncHead.length>0) push('Performance','critical',`${syncHead.length} sync script(s) in <head>`, syncHead.slice(0,3).map(s=>s.src.split('/').pop()).join(', '), 'Add defer to all non-critical scripts. LiteSpeed Cache → JS Defer → ON.');
  const videoIf = iframes.filter(i=>/vimeo|youtube|youtu\.be/i.test(i.src));
  if (videoIf.length>0) push('Performance','critical',`${videoIf.length} video embed(s) on page load`, videoIf.map(i=>i.src.split('/')[2]||'embed').join(', '), 'Lazy-load video iframes. LiteSpeed → Lazy Load Iframes → ON. Or show thumbnail + play button instead.');
  const base = new URL(url);
  const tp = scripts.filter(s=>{ try { return new URL(s.src).hostname!==base.hostname; } catch { return false; }});
  const slowTp = tp.filter(s=>/facebook|fbevents|pixel|gtm|analytics|hotjar|intercom|drift|hubspot/i.test(s.src));
  if (slowTp.length>2) push('Performance','high',`${slowTp.length} third-party tracking scripts`, slowTp.slice(0,4).map(s=>{ try{return new URL(s.src).hostname;}catch{return s.src.slice(0,30);} }).join(', '), 'Consolidate tracking via GTM. Remove standalone GA/FB Pixel plugins and fire from GTM instead.');
  if (/UA-\d{6,}-\d/.test(html.slice(0,8000))) push('Performance','high','Dead Universal Analytics (UA-) still firing','UA shut down March 2024. Still loads every page — wasting ~50KB.','Remove UA tag from GTM. Verify GA4 is collecting data.');
  if (/css_print_method-external/i.test(meta.generator)) push('Performance','high','Elementor: css_print_method-external','Elementor loading CSS as separate blocking files.','Elementor → Settings → Experiments → Improved CSS Loading → ON → Regenerate Files & Data.');
  if (/font_display-auto/i.test(meta.generator)) push('Performance','medium','Elementor: font_display-auto','Text invisible while Google Fonts load — hurts FCP.','Elementor → Settings → Performance → Font Display → Swap.');

  // ── Images ───────────────────────────────────────────────
  const noAlt = images.filter(i=>!i.hasAlt&&i.src&&!i.src.startsWith('data:'));
  if (noAlt.length>0) push('Accessibility','high',`${noAlt.length} image(s) missing alt text`, noAlt.slice(0,4).map(i=>i.src.split('/').pop()).join(', '), 'Add alt text to all images. Use "Fix Missing Alt Tags" plugin or wp_get_attachment_image_attributes filter.');
  const noLazy = images.filter(i=>i.src&&!i.src.startsWith('data:')&&i.loading!=='lazy'&&!/hero|header|banner|logo/i.test(i.src));
  if (noLazy.length>5) push('Performance','high',`${noLazy.length} images without lazy loading`,'All below-fold images should have loading="lazy".','LiteSpeed Cache → Lazy Load Images → ON. Add loading="lazy" to content img tags.');
  const noDim = images.filter(i=>i.src&&!i.src.startsWith('data:')&&(!i.w||!i.h));
  if (noDim.length>3) push('Performance','medium',`${noDim.length} images missing width/height`,'Browser cannot reserve space — causes CLS (layout shift).','Add explicit width and height to all img tags. LiteSpeed → Add Missing Image Dimensions.');
  const untitledIf = iframes.filter(i=>i.src&&!i.title);
  if (untitledIf.length>0) push('Accessibility','medium',`${untitledIf.length} iframe(s) missing title`, untitledIf.map(i=>i.src.split('/')[2]||'embed').join(', '), 'Add title attribute to iframes: <iframe title="Newsletter signup">.');

  // ── Security ─────────────────────────────────────────────
  if (url.startsWith('http://')) push('Security','critical','Site not using HTTPS','Served over HTTP — insecure.','Install SSL and redirect all HTTP to HTTPS. Cloudflare free tier provides automatic SSL.');
  if (status>=400) push('SEO','critical',`Page returned HTTP ${status}`, `Status ${status}`, status===404?'Fix URL or set up a redirect.':'Investigate server error.');

  return {
    url, status, ttfb,
    counts: { images:images.length, links:links.length, headings:headings.length, scripts:scripts.length, styles:styles.length, iframes:iframes.length },
    issues: issues.sort((a,b)=>{ const o={critical:0,high:1,medium:2,low:3}; return (o[a.severity]||3)-(o[b.severity]||3); }),
  };
}

// ── Main handler ─────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url, maxPages = 10 } = req.body || {};
    if (!url) return res.status(400).json({ error: 'URL required' });

    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

    const home = await fetchPage(targetUrl);
    if (!home.ok) return res.status(400).json({ error: `Cannot fetch ${targetUrl}: ${home.error}` });

    const finalBase = home.finalUrl || targetUrl;
    const results = [auditPage(finalBase, home.html, home.status, home.ttfb, home.headers)];

    const links = extractLinks(home.html, finalBase);
    const toCrawl = [...new Set(links)].slice(0, Math.min(maxPages - 1, 19));

    for (const pageUrl of toCrawl) {
      try {
        const p = await fetchPage(pageUrl);
        if (p.ok) results.push(auditPage(pageUrl, p.html, p.status, p.ttfb, p.headers));
      } catch {}
      await new Promise(r => setTimeout(r, 350));
    }

    const all = results.flatMap(r => r.issues);
    const summary = {
      totalPages:  results.length,
      totalIssues: all.length,
      critical:    all.filter(i=>i.severity==='critical').length,
      high:        all.filter(i=>i.severity==='high').length,
      medium:      all.filter(i=>i.severity==='medium').length,
      low:         all.filter(i=>i.severity==='low').length,
      categories:  { SEO: all.filter(i=>i.category==='SEO').length, Performance: all.filter(i=>i.category==='Performance').length, Accessibility: all.filter(i=>i.category==='Accessibility').length, Security: all.filter(i=>i.category==='Security').length },
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.status(200).json({ success: true, url: finalBase, summary, pages: results });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
