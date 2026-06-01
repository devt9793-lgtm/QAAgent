// api/audit.js — Vercel Serverless Function
// Site Audit Agent v2 — full checks including PSI, image sizes, WebP, robots.txt, sitemap
export const config = { maxDuration: 60 };

// ─────────────────────────────────────────────────────────────
// FETCH HELPERS
// ─────────────────────────────────────────────────────────────
async function safeFetch(url, opts = {}, timeoutMs = 12000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(url, {
      ...opts,
      signal: c.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditBot/2.0)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
        ...(opts.headers || {}),
      },
    });
    clearTimeout(t);
    return res;
  } catch (e) {
    return null;
  }
}

async function fetchHtml(url) {
  const start = Date.now();
  const res = await safeFetch(url, { redirect: 'follow' });
  if (!res) return { ok: false, error: 'Timeout or connection refused', ttfb: Date.now() - start };
  const ttfb = Date.now() - start;
  try {
    const html = await res.text();
    return { ok: true, html, status: res.status, ttfb, finalUrl: res.url, headers: Object.fromEntries(res.headers) };
  } catch (e) {
    return { ok: false, error: e.message, ttfb };
  }
}

// HEAD request to get image file size
async function getImageMeta(url) {
  try {
    const res = await safeFetch(url, { method: 'HEAD' }, 6000);
    if (!res) return { size: 0, type: '' };
    const size = parseInt(res.headers.get('content-length') || '0');
    const type = res.headers.get('content-type') || '';
    return { size, type };
  } catch {
    return { size: 0, type: '' };
  }
}

// ─────────────────────────────────────────────────────────────
// ROBOTS.TXT + SITEMAP
// ─────────────────────────────────────────────────────────────
async function checkRobotsTxt(baseUrl) {
  const url = new URL(baseUrl).origin + '/robots.txt';
  const res = await safeFetch(url, {}, 8000);
  if (!res || res.status !== 200) return { found: false, url, issues: ['robots.txt not found or returns non-200'] };

  const text = await res.text();
  const issues = [];
  const info   = [];

  // Check if blocking all crawlers
  if (/User-agent:\s*\*/i.test(text) && /Disallow:\s*\/\s*$/im.test(text)) {
    issues.push('robots.txt is blocking ALL crawlers (Disallow: /) — site may not be indexed');
  }
  // Check if blocking Googlebot specifically
  if (/User-agent:\s*Googlebot/i.test(text) && /Disallow:\s*\/\s*$/im.test(text)) {
    issues.push('robots.txt is blocking Googlebot specifically');
  }
  // Find sitemap references
  const sitemaps = [];
  const sitemapRx = /Sitemap:\s*(.+)/gi;
  let m;
  while ((m = sitemapRx.exec(text)) !== null) sitemaps.push(m[1].trim());

  if (sitemaps.length === 0) info.push('No Sitemap directive found in robots.txt');

  return { found: true, url, issues, info, sitemaps, raw: text.slice(0, 500) };
}

async function checkSitemap(baseUrl, knownSitemaps = []) {
  const tryUrls = [
    ...knownSitemaps,
    new URL(baseUrl).origin + '/sitemap.xml',
    new URL(baseUrl).origin + '/sitemap_index.xml',
    new URL(baseUrl).origin + '/wp-sitemap.xml',
  ];

  for (const url of [...new Set(tryUrls)]) {
    const res = await safeFetch(url, {}, 8000);
    if (!res || res.status !== 200) continue;
    const text = await res.text();
    if (!text.includes('<urlset') && !text.includes('<sitemapindex')) continue;

    const issues = [];
    const info   = [];

    // Count URLs
    const urlMatches = text.match(/<loc>/g) || [];
    const urlCount   = urlMatches.length;
    info.push(`${urlCount} URLs found in sitemap`);

    // Check for lastmod
    if (!text.includes('<lastmod>')) info.push('No <lastmod> dates in sitemap — add them for better crawl prioritisation');

    // Check for images in sitemap
    if (text.includes('<image:loc>')) info.push('Image sitemap detected ✓');

    // Very large sitemap
    if (urlCount > 50000) issues.push(`Sitemap has ${urlCount} URLs — Google recommends splitting at 50,000`);

    return { found: true, url, urlCount, issues, info };
  }

  return { found: false, issues: ['No sitemap.xml found at standard locations'], info: [], urlCount: 0 };
}

// ─────────────────────────────────────────────────────────────
// PAGESPEED INSIGHTS API
// ─────────────────────────────────────────────────────────────
async function fetchPSI(pageUrl, apiKey, strategy = 'mobile') {
  if (!apiKey) return null;
  try {
    const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(pageUrl)}&strategy=${strategy}&key=${apiKey}&category=performance&category=accessibility&category=seo&category=best-practices`;
    const res = await safeFetch(api, {}, 30000);
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (!data.lighthouseResult) return null;

    const cats = data.lighthouseResult.categories || {};
    const audits = data.lighthouseResult.audits || {};

    return {
      scores: {
        performance:  Math.round((cats.performance?.score || 0) * 100),
        accessibility:Math.round((cats.accessibility?.score || 0) * 100),
        seo:          Math.round((cats.seo?.score || 0) * 100),
        bestPractices:Math.round((cats['best-practices']?.score || 0) * 100),
      },
      metrics: {
        fcp:  audits['first-contentful-paint']?.displayValue || '',
        lcp:  audits['largest-contentful-paint']?.displayValue || '',
        tbt:  audits['total-blocking-time']?.displayValue || '',
        cls:  audits['cumulative-layout-shift']?.displayValue || '',
        si:   audits['speed-index']?.displayValue || '',
        ttfb: audits['server-response-time']?.displayValue || '',
      },
      fcpMs:  audits['first-contentful-paint']?.numericValue || 0,
      lcpMs:  audits['largest-contentful-paint']?.numericValue || 0,
      tbtMs:  audits['total-blocking-time']?.numericValue || 0,
      clsVal: parseFloat(audits['cumulative-layout-shift']?.displayValue || '0'),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// HTML PARSERS
// ─────────────────────────────────────────────────────────────
function parseImages(html, baseUrl) {
  const imgs = [];
  const re = /<img([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1];
    let src = (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '';
    // Resolve relative URLs
    try { if (src && !src.startsWith('data:')) src = new URL(src, baseUrl).href; } catch {}
    const dataSrc = (a.match(/\bdata-src=["']([^"']+)["']/) || [])[1] || '';
    const lazySrc = dataSrc || (a.match(/\bdata-lazy-src=["']([^"']+)["']/) || [])[1] || '';
    const effectiveSrc = src || lazySrc;

    imgs.push({
      src: effectiveSrc,
      hasAlt:  /\balt=/.test(a),
      altVal:  (a.match(/\balt=["']([^"']*)["']/) || [, null])[1],
      w:       (a.match(/\bwidth=["']?(\d+)/) || [])[1] || '',
      h:       (a.match(/\bheight=["']?(\d+)/) || [])[1] || '',
      loading: (a.match(/\bloading=["']([^"']+)["']/) || [])[1] || '',
      fetchPriority: (a.match(/\bfetchpriority=["']([^"']+)["']/) || [])[1] || '',
      classes: (a.match(/\bclass=["']([^"']+)["']/) || [])[1] || '',
    });
  }
  return imgs;
}

function parseLinks(html) {
  const links = [];
  const re = /<a([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2].replace(/<[^>]+>/g, '').trim();
    links.push({
      href:  (attrs.match(/\bhref=["']([^"']+)["']/) || [])[1] || '',
      text:  inner,
      aria:  (attrs.match(/\baria-label=["']([^"']+)["']/) || [])[1] || '',
      rel:   (attrs.match(/\brel=["']([^"']+)["']/) || [])[1] || '',
      target:(attrs.match(/\btarget=["']([^"']+)["']/) || [])[1] || '',
    });
  }
  return links;
}

function parseHeadings(html) {
  const h = [];
  const re = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) h.push({ level: m[1], text: m[2].replace(/<[^>]+>/g, '').trim() });
  return h;
}

function parseScripts(html) {
  const s = [];
  const re = /<script([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1];
    const src = (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '';
    if (src) s.push({ src, defer: /\bdefer\b/i.test(a), async: /\basync\b/i.test(a), type: (a.match(/\btype=["']([^"']+)["']/) || [])[1] || '' });
  }
  return s;
}

function parseStyles(html) {
  const s = [];
  const re = /<link([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1];
    if (!/rel=["']stylesheet["']/i.test(a)) continue;
    s.push({ href: (a.match(/\bhref=["']([^"']+)["']/) || [])[1] || '', media: (a.match(/\bmedia=["']([^"']+)["']/) || [])[1] || 'all' });
  }
  return s;
}

function parseIframes(html) {
  const f = [];
  const re = /<iframe([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1];
    f.push({
      src:     (a.match(/\bsrc=["']([^"']+)["']/) || [])[1] || '',
      title:   (a.match(/\btitle=["']([^"']+)["']/) || [])[1] || '',
      loading: (a.match(/\bloading=["']([^"']+)["']/) || [])[1] || '',
    });
  }
  return f;
}

function parseMeta(html) {
  const get = (rx) => { const m = html.match(rx); return m ? m[1].trim() : ''; };
  return {
    title:      get(/<title[^>]*>([\s\S]*?)<\/title>/i),
    desc:       get(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                get(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i),
    robots:     get(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']+)["']/i) || 'index,follow',
    canonical:  get(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i),
    ogTitle:    get(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i),
    ogDesc:     get(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i),
    ogImage:    get(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
    ogImgW:     parseInt(get(/<meta[^>]*property=["']og:image:width["'][^>]*content=["']([^"']+)["']/i) || '0'),
    twitterCard:get(/<meta[^>]*name=["']twitter:card["'][^>]*content=["']([^"']+)["']/i),
    viewport:   get(/<meta[^>]*name=["']viewport["'][^>]*content=["']([^"']+)["']/i),
    generator:  get(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i),
    lang:       get(/<html[^>]*lang=["']([^"']+)["']/i),
    charset:    get(/<meta[^>]*charset=["']([^"']+)["']/i) || (/<meta charset/i.test(html) ? 'utf-8' : ''),
  };
}

function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const found = new Set();
  const re = /href=["']([^"'#?][^"']*?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.hostname === base.hostname) {
        const p = abs.pathname.replace(/\/$/, '');
        if (!p.match(/\.(jpg|jpeg|png|gif|webp|pdf|zip|css|js|xml|ico|svg|mp4|mp3)$/i) &&
            !abs.pathname.includes('/wp-admin') &&
            !abs.pathname.includes('/wp-login') &&
            !abs.pathname.includes('/feed') &&
            !abs.pathname.includes('/trackback')) {
          found.add(abs.origin + (p || '/'));
        }
      }
    } catch {}
  }
  return [...found];
}

// ─────────────────────────────────────────────────────────────
// DETECT HEAVY / NON-WEBP IMAGES (sample top images per page)
// ─────────────────────────────────────────────────────────────
async function auditImageFiles(images, baseUrl) {
  const results = [];
  // Only check up to 12 images per page to stay within timeout
  const candidates = images
    .filter(i => i.src && !i.src.startsWith('data:') && /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(i.src))
    .slice(0, 12);

  await Promise.all(candidates.map(async (img) => {
    const meta = await getImageMeta(img.src);
    const isWebP  = /webp/i.test(meta.type) || /\.webp(\?|$)/i.test(img.src);
    const isAvif  = /avif/i.test(meta.type) || /\.avif(\?|$)/i.test(img.src);
    const isModern = isWebP || isAvif;
    const sizeKB  = meta.size ? Math.round(meta.size / 1024) : 0;
    const filename = img.src.split('/').pop().split('?')[0].slice(0, 50);

    results.push({
      src: img.src,
      filename,
      sizeKB,
      isWebP,
      isAvif,
      isModern,
      alt: img.altVal || '',
      hasAlt: img.hasAlt,
      hasDimensions: !!(img.w && img.h),
      isLazy: img.loading === 'lazy',
    });
  }));

  return results;
}

// ─────────────────────────────────────────────────────────────
// MAIN PAGE AUDIT
// ─────────────────────────────────────────────────────────────
async function auditPage(url, html, status, ttfb, headers, imgData, psi) {
  const issues  = [];
  const meta    = parseMeta(html);
  const images  = parseImages(html, url);
  const links   = parseLinks(html);
  const headings= parseHeadings(html);
  const scripts = parseScripts(html);
  const styles  = parseStyles(html);
  const iframes = parseIframes(html);

  const push = (cat, sev, title, detail, fix) => issues.push({ category: cat, severity: sev, title, detail, fix });

  // ── SEO ────────────────────────────────────────────────────
  if (/noindex/i.test(meta.robots))
    push('SEO', 'critical', 'Page set to noindex — not indexable',
      `meta robots: "${meta.robots}"`,
      'WordPress → Settings → Reading → uncheck "Discourage search engines". Verify in Yoast/RankMath → SEO → Robots.');

  if (!meta.title)
    push('SEO', 'critical', 'Missing <title> tag', 'No title tag found on this page.',
      'Add a unique 50–60 character title. In Yoast/RankMath → edit page → SEO Title field.');
  else if (meta.title.length < 30)
    push('SEO', 'medium', `Title too short — ${meta.title.length} chars`, `"${meta.title.slice(0,70)}"`,
      'Expand the title to 50–60 characters with primary keyword + brand name.');
  else if (meta.title.length > 65)
    push('SEO', 'low', `Title too long — ${meta.title.length} chars (truncated by Google)`, `"${meta.title.slice(0,70)}…"`,
      'Shorten the title to under 60 characters.');

  if (!meta.desc)
    push('SEO', 'high', 'Missing meta description',
      'No meta description found — Google auto-generates one (often badly).',
      'Add a 150–160 character meta description in Yoast/RankMath → Description field.');
  else if (meta.desc.length < 70)
    push('SEO', 'medium', `Meta description too short — ${meta.desc.length} chars`, meta.desc.slice(0, 80),
      'Expand meta description to 150–160 characters. Include the primary keyword naturally.');
  else if (meta.desc.length > 165)
    push('SEO', 'low', `Meta description too long — ${meta.desc.length} chars`, meta.desc.slice(0, 80) + '…',
      'Shorten to 155 characters to prevent truncation in search results.');

  if (!meta.canonical)
    push('SEO', 'medium', 'Missing canonical tag',
      'No rel="canonical" link found.',
      'Add canonical tag to prevent duplicate content. Yoast/RankMath adds this automatically when configured.');

  if (!meta.ogImage)
    push('SEO', 'medium', 'Missing og:image — no social preview',
      'When this page is shared on LinkedIn, Twitter, Facebook — no image will show.',
      'Add a 1200×630px og:image in Yoast/RankMath → Social tab → Facebook Image.');
  else if (meta.ogImgW > 1600)
    push('SEO', 'medium', `og:image oversized — ${meta.ogImgW}px wide`,
      `Current: ${meta.ogImgW}px. Social platforms display at 1200×630px max. Wastes bandwidth.`,
      'Resize og:image to exactly 1200×630px and re-upload via your SEO plugin social settings.');

  if (!meta.ogTitle)
    push('SEO', 'low', 'Missing og:title', 'No Open Graph title tag.',
      'Add og:title in Yoast/RankMath → Social tab. Falls back to page title if missing.');

  if (!meta.twitterCard)
    push('SEO', 'low', 'Missing twitter:card meta tag',
      'Twitter/X will not show a card preview when this page is shared.',
      'Add twitter:card meta tag. Yoast SEO adds this automatically — check Yoast → Social → Twitter settings.');

  if (!meta.viewport)
    push('SEO', 'high', 'Missing viewport meta tag',
      'Without viewport, the page will not render correctly on mobile — Google penalises this.',
      'Add: <meta name="viewport" content="width=device-width, initial-scale=1">');

  if (!meta.lang)
    push('SEO', 'medium', 'Missing lang attribute on <html>',
      'Screen readers and search engines cannot determine the page language.',
      'Add lang attribute: <html lang="en">. In WordPress → Settings → General → Site Language.');

  if (!meta.charset)
    push('SEO', 'low', 'Missing charset meta tag',
      'No charset declaration found.',
      'Add <meta charset="UTF-8"> as the first tag inside <head>.');

  const h1s = headings.filter(h => h.level === 'h1');
  if (h1s.length === 0)
    push('SEO', 'high', 'No H1 heading on page',
      'Every page should have exactly one H1 as the main topic signal for Google.',
      'Add one H1 tag. In Elementor: click the main heading widget → Content → HTML Tag → H1.');
  else if (h1s.length > 1)
    push('SEO', 'medium', `${h1s.length} H1 tags found (should be exactly 1)`,
      h1s.map(h => `"${h.text.slice(0, 50)}"`).join(', '),
      'Keep only one H1. Change extra H1s to H2 or H3 in your page builder.');

  let prevLvl = 0;
  for (const h of headings) {
    const lvl = parseInt(h.level[1]);
    if (prevLvl > 0 && lvl > prevLvl + 1) {
      push('Accessibility', 'medium', `Heading level skipped: H${prevLvl} → H${lvl}`,
        `"${h.text.slice(0, 60)}"`,
        'Use sequential heading levels (H1 → H2 → H3). Never skip. Fix in page builder by changing heading tag.');
      break;
    }
    prevLvl = lvl;
  }

  const genericTexts = ['learn more', 'read more', 'click here', 'find out more', 'more', 'here', 'link', 'this'];
  const badLinks = links.filter(l => genericTexts.includes((l.text || '').toLowerCase().trim()) && !l.aria);
  if (badLinks.length > 0)
    push('SEO', 'high', `${badLinks.length} non-descriptive link(s) — hurts SEO and accessibility`,
      `Links with generic text: "${badLinks.slice(0, 5).map(l => l.text).join('", "')}"`,
      'Replace with descriptive text (e.g. "Learn more about Verdant Hill"). Or add aria-label="Descriptive text" to the link.');

  // External links without nofollow/noopener
  const extLinks = links.filter(l => { try { return new URL(l.href).hostname !== new URL(url).hostname && !l.rel.includes('nofollow'); } catch { return false; } });
  if (extLinks.length > 5)
    push('SEO', 'low', `${extLinks.length} external links without nofollow`,
      'External links pass PageRank. Consider nofollow for non-editorial links.',
      'Add rel="nofollow noopener" to external links that you do not want to pass authority to.');

  // ── PERFORMANCE ───────────────────────────────────────────

  if (ttfb > 1800)
    push('Performance', 'critical', `Slow TTFB: ${ttfb}ms — page not cached`,
      'Time to First Byte over 1800ms. Every visitor gets a full PHP render. No caching active.',
      'Install LiteSpeed Cache or WP Rocket. Enable page cache + mobile cache. TTFB should be under 200ms.');
  else if (ttfb > 800)
    push('Performance', 'high', `TTFB: ${ttfb}ms — above Google "Good" threshold`,
      'Google "Good" TTFB is under 800ms.',
      'Enable caching plugin. Check server plan. Consider Cloudflare free tier for edge caching.');

  const cc = headers['cache-control'] || headers['Cache-Control'] || '';
  if (!cc || cc.includes('no-cache') || cc.includes('no-store'))
    push('Performance', 'high', 'No browser cache headers on page',
      `Cache-Control: "${cc || 'missing'}"`,
      'Enable browser caching. LiteSpeed Cache → Cache → Browser Cache TTL → set to 31557600 (1 year for static assets).');

  const blockCSS = styles.filter(s => !s.media || s.media === 'all' || s.media === 'screen');
  if (blockCSS.length > 8)
    push('Performance', 'critical', `${blockCSS.length} render-blocking CSS files`,
      blockCSS.slice(0, 3).map(s => s.href.split('/').pop()).join(', ') + '…',
      'Elementor: Settings → Experiments → Improved CSS Loading. LiteSpeed: CSS Minify + Combine. Use QUIC.cloud for Critical CSS inline.');
  else if (blockCSS.length > 4)
    push('Performance', 'high', `${blockCSS.length} render-blocking CSS files`,
      'Multiple external CSS blocking first paint.',
      'Enable CSS Combine + Minify in LiteSpeed Cache page optimization settings.');

  const headHtml = html.split('</head>')[0] || '';
  const syncHead = parseScripts(headHtml).filter(s => !s.defer && !s.async && s.src && !s.type);
  if (syncHead.length > 0)
    push('Performance', 'critical', `${syncHead.length} synchronous script(s) in <head>`,
      syncHead.slice(0, 3).map(s => s.src.split('/').pop()).join(', '),
      'Add defer attribute to all non-critical scripts. LiteSpeed Cache → Page Optimization → JS Defer → ON. Exclude: jquery.min.js, elementor-frontend.min.js.');

  const videoIf = iframes.filter(i => /vimeo|youtube|youtu\.be/i.test(i.src));
  if (videoIf.length > 0)
    push('Performance', 'critical', `${videoIf.length} video embed(s) loading on every page visit`,
      videoIf.map(i => { try { return new URL(i.src).hostname; } catch { return 'video embed'; } }).join(', '),
      'Lazy-load video iframes. LiteSpeed Cache → Media → Lazy Load Iframes → ON. Or show a thumbnail with a play button and load the iframe only on click.');

  const base = new URL(url);
  const thirdPartyScripts = scripts.filter(s => { try { return new URL(s.src).hostname !== base.hostname; } catch { return false; } });
  const slowTracking = thirdPartyScripts.filter(s => /facebook|fbevents|pixel|analytics|gtm|hotjar|intercom|drift|hubspot|talkfurther|panoskin|tourbuilder/i.test(s.src));
  if (slowTracking.length > 2)
    push('Performance', 'high', `${slowTracking.length} third-party tracking scripts on page`,
      slowTracking.slice(0, 4).map(s => { try { return new URL(s.src).hostname; } catch { return s.src.slice(0, 40); } }).join(', '),
      'Consolidate all tracking via Google Tag Manager. Remove standalone GA, FB Pixel, and analytics plugins. Fire them from GTM only.');

  if (/UA-\d{6,}-\d/.test(html.slice(0, 10000)))
    push('Performance', 'high', 'Dead Universal Analytics (UA-) tag still firing',
      'Google shut down Universal Analytics in March 2024. This tag fires on every page load, fails, and wastes ~50ms.',
      'Remove UA tag from GTM. Confirm your GA4 property (G-XXXXXXXX) is collecting data in Google Analytics → Reports → Realtime.');

  if (/css_print_method-external/i.test(meta.generator))
    push('Performance', 'high', 'Elementor: css_print_method-external (render-blocking)',
      'Elementor loading CSS as separate external files — blocks rendering.',
      'Elementor → Settings → Experiments → Enable "Improved CSS Loading" → Save → Tools → Regenerate Files & Data → Flush cache.');

  if (/font_display-auto/i.test(meta.generator))
    push('Performance', 'medium', 'Elementor: font_display-auto — text invisible while fonts load',
      'Text is hidden until Google Fonts download. Hurts FCP metric.',
      'Elementor → Settings → Performance → Font Display → change from Auto to Swap.');

  // PSI-based issues
  if (psi) {
    if (psi.lcpMs > 4000)
      push('Performance', 'critical', `LCP too slow: ${psi.metrics.lcp}`,
        'Largest Contentful Paint over 4s. Google "Good" is under 2.5s.',
        'Add preload tag for hero image in <head>. Lazy-load below-fold images. Enable WebP. Fix render-blocking resources.');
    else if (psi.lcpMs > 2500)
      push('Performance', 'high', `LCP needs improvement: ${psi.metrics.lcp}`,
        'LCP between 2.5s and 4s. Google "Needs Improvement" range.',
        'Add hero image preload tag. Check for render-blocking CSS. Enable caching and WebP.');

    if (psi.tbtMs > 300)
      push('Performance', 'critical', `TBT too high: ${psi.metrics.tbt}`,
        'Total Blocking Time over 300ms. Main thread is blocked — user cannot interact.',
        'Enable JS Defer in LiteSpeed Cache. Remove unused JavaScript. Consolidate tracking scripts into GTM.');
    else if (psi.tbtMs > 100)
      push('Performance', 'high', `TBT elevated: ${psi.metrics.tbt}`,
        'TBT between 100ms and 300ms.',
        'Defer non-critical JavaScript. Remove unused JS. Check for heavy third-party scripts.');

    if (psi.fcpMs > 3000)
      push('Performance', 'critical', `FCP too slow: ${psi.metrics.fcp}`,
        'First Contentful Paint over 3s. Page appears blank too long.',
        'Enable CSS inline critical. Fix render-blocking resources. Enable caching. Use CDN.');
    else if (psi.fcpMs > 1800)
      push('Performance', 'high', `FCP needs improvement: ${psi.metrics.fcp}`,
        'FCP between 1.8s and 3s.',
        'Enable font-display:swap. Inline critical CSS. Enable caching plugin.');

    if (psi.clsVal > 0.25)
      push('Performance', 'critical', `CLS too high: ${psi.metrics.cls}`,
        'Cumulative Layout Shift over 0.25. Content is jumping on page load.',
        'Add width and height to all images. Disable CSS Async in LiteSpeed if enabled. Avoid inserting content above existing content.');
    else if (psi.clsVal > 0.1)
      push('Performance', 'medium', `CLS elevated: ${psi.metrics.cls}`,
        'CLS between 0.1 and 0.25.',
        'Add explicit width/height to images. Enable Responsive Placeholder in LiteSpeed Cache.');

    if (psi.scores.performance < 50)
      push('Performance', 'critical', `PageSpeed score: ${psi.scores.performance}/100 (Mobile)`,
        'Score below 50 — major performance issues.',
        'Follow all performance fixes above. Run PSI at pagespeed.web.dev to see specific opportunities.');
    else if (psi.scores.performance < 70)
      push('Performance', 'high', `PageSpeed score: ${psi.scores.performance}/100 (Mobile)`,
        'Score between 50–70. Significant room to improve.',
        'Fix render-blocking resources, image delivery, and LCP issues above.');

    if (psi.scores.accessibility < 80)
      push('Accessibility', 'high', `Accessibility score: ${psi.scores.accessibility}/100`,
        'Score below 80 — multiple accessibility barriers for users with disabilities.',
        'Run WAVE audit at wave.webaim.org. Fix contrast, missing labels, ARIA roles, and alt text issues.');

    if (psi.scores.seo < 90)
      push('SEO', 'medium', `PSI SEO score: ${psi.scores.seo}/100`,
        'PageSpeed Insights SEO score below 90.',
        'Fix any SEO issues listed above. Check for crawlability issues, mobile-friendliness, and structured data.');
  }

  // ── IMAGES (from HTML) ────────────────────────────────────
  const noAlt = images.filter(i => !i.hasAlt && i.src && !i.src.startsWith('data:'));
  if (noAlt.length > 0)
    push('Accessibility', 'high', `${noAlt.length} image(s) missing alt text`,
      noAlt.slice(0, 4).map(i => i.src.split('/').pop().split('?')[0]).join(', '),
      'Add alt text to all images. Use Fix Missing Alt Tags plugin or the wp_get_attachment_image_attributes filter in functions.php.');

  const noLazy = images.filter(i => i.src && !i.src.startsWith('data:') && i.loading !== 'lazy' && !/hero|header|banner|logo/i.test(i.src) && !/fetchpriority["']?\s*[:=]\s*["']?high/i.test(i.classes));
  if (noLazy.length > 5)
    push('Performance', 'high', `${noLazy.length} images without lazy loading`,
      'All below-fold images should have loading="lazy".',
      'LiteSpeed Cache → Image Optimization → Lazy Load Images → ON. First hero image should NOT have lazy load.');

  const noDim = images.filter(i => i.src && !i.src.startsWith('data:') && (!i.w || !i.h));
  if (noDim.length > 3)
    push('Performance', 'medium', `${noDim.length} images missing width/height attributes`,
      'Browser cannot reserve space before images load — causes Cumulative Layout Shift.',
      'Add explicit width and height to all img tags. LiteSpeed Cache → Add Missing Image Dimensions (if available).');

  // Hero image preload check
  const hasPreload = /<link[^>]*rel=["']preload["'][^>]*as=["']image["']/i.test(html);
  if (!hasPreload && images.length > 0)
    push('Performance', 'high', 'No hero image preload tag in <head>',
      'The LCP hero image is not preloaded — browser discovers it late after CSS files are parsed.',
      'Add <link rel="preload" as="image" fetchpriority="high" href="HERO-IMAGE-URL"> to <head>. In Elementor: Site Settings → Custom Code → Head.');

  // ── IMAGES (from file audit) ──────────────────────────────
  if (imgData && imgData.length > 0) {
    const heavyImages = imgData.filter(i => i.sizeKB > 200);
    if (heavyImages.length > 0)
      push('Performance', 'high', `${heavyImages.length} heavy image(s) over 200KB`,
        heavyImages.slice(0, 4).map(i => `${i.filename} (${i.sizeKB}KB)`).join(', '),
        'Compress images to under 150KB each. Use ShortPixel, Imagify, or Smush plugin. Convert to WebP for 30–50% extra saving.');

    const veryHeavy = imgData.filter(i => i.sizeKB > 500);
    if (veryHeavy.length > 0)
      push('Performance', 'critical', `${veryHeavy.length} very heavy image(s) over 500KB`,
        veryHeavy.slice(0, 4).map(i => `${i.filename} (${i.sizeKB}KB)`).join(', '),
        'URGENT: These images are severely impacting load time. Compress immediately. Target under 150KB per image. Consider lazy loading for below-fold images.');

    const nonWebP = imgData.filter(i => !i.isModern && i.sizeKB > 0 && !/\.svg(\?|$)/i.test(i.src));
    if (nonWebP.length > 0)
      push('Performance', 'high', `${nonWebP.length} image(s) not in WebP/AVIF format`,
        nonWebP.slice(0, 4).map(i => `${i.filename}`).join(', '),
        'Convert JPG/PNG to WebP format — saves 30–50% file size with same quality. LiteSpeed Cache → Image Optimization → WebP Replacement → ON. Needs free QUIC.cloud API key.');

    const totalKB = imgData.reduce((sum, i) => sum + i.sizeKB, 0);
    if (totalKB > 1500)
      push('Performance', 'high', `Total image weight on page: ${totalKB}KB`,
        `${imgData.length} images sampled totalling ${totalKB}KB. Recommended: under 500KB total.`,
        'Compress all images. Enable WebP. Enable lazy loading for below-fold images. Consider serving responsive image sizes with srcset.');
  }

  // ── IFRAMES ───────────────────────────────────────────────
  const untitledIf = iframes.filter(i => i.src && !i.title);
  if (untitledIf.length > 0)
    push('Accessibility', 'medium', `${untitledIf.length} iframe(s) missing title attribute`,
      untitledIf.map(i => { try { return new URL(i.src).hostname; } catch { return 'iframe'; } }).slice(0, 3).join(', '),
      'Add title attribute to all iframes: <iframe title="Subscribe to Newsletter" ...>');

  // ── BEST PRACTICES ─────────────────────────────────────────
  if (url.startsWith('http://'))
    push('Security', 'critical', 'Site not using HTTPS',
      'Page served over HTTP — connection is not encrypted.',
      'Install SSL certificate. Cloudflare free tier provides automatic SSL. Set up HTTP → HTTPS redirect in .htaccess or server config.');

  if (status >= 400)
    push('SEO', 'critical', `Page returned HTTP ${status} error`,
      `HTTP status ${status} — page cannot be indexed.`,
      status === 404 ? 'Fix the URL or set up a 301 redirect to the correct page.' : 'Investigate server error. Check error logs.');

  if (status >= 300 && status < 400)
    push('SEO', 'medium', `Page redirects (HTTP ${status})`,
      'Page is a redirect — this should be the final destination URL.',
      'Update all internal links to point directly to the final URL. Avoid redirect chains.');

  return {
    url, status, ttfb,
    meta: { title: meta.title, desc: meta.desc, robots: meta.robots, lang: meta.lang },
    psi: psi ? { scores: psi.scores, metrics: psi.metrics } : null,
    counts: { images: images.length, links: links.length, headings: headings.length, scripts: scripts.length, styles: styles.length, iframes: iframes.length },
    imageData: imgData || [],
    issues: issues.sort((a, b) => {
      const o = { critical: 0, high: 1, medium: 2, low: 3 };
      return (o[a.severity] || 3) - (o[b.severity] || 3);
    }),
  };
}

// ─────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers for cross-origin requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { url, maxPages = 10, psiApiKey = '', checkImages = true } = req.body || {};
    if (!url) return res.status(400).json({ error: 'URL is required' });

    let targetUrl = url.trim();
    if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

    const startTime = Date.now();

    // 1. Fetch homepage
    const home = await fetchHtml(targetUrl);
    if (!home.ok) return res.status(400).json({ error: `Cannot fetch ${targetUrl}: ${home.error}` });

    const finalBase = home.finalUrl || targetUrl;

    // 2. robots.txt + sitemap (run in parallel with crawl)
    const [robotsData, sitemapData] = await Promise.all([
      checkRobotsTxt(finalBase),
      (async () => {
        const robots = await checkRobotsTxt(finalBase);
        return checkSitemap(finalBase, robots.sitemaps || []);
      })(),
    ]);

    // 3. Discover all internal pages
    const allLinks = extractLinks(home.html, finalBase);
    const cap = Math.min(maxPages - 1, 99); // cap at 99 inner pages + homepage = 100 total
    const toCrawl = [...new Set(allLinks)].slice(0, cap);

    // 4. Crawl all pages (parallel batches of 5 to respect timeout)
    const pageResults = [];
    const batchSize = 5;

    // Crawl homepage images and PSI first
    const homeImages = checkImages ? await auditImageFiles(parseImages(home.html, finalBase), finalBase) : [];
    // PSI only on homepage to save time
    const homePSI = psiApiKey ? await fetchPSI(finalBase, psiApiKey, 'mobile') : null;
    pageResults.push(await auditPage(finalBase, home.html, home.status, home.ttfb, home.headers, homeImages, homePSI));

    // Crawl inner pages in batches
    for (let i = 0; i < toCrawl.length; i += batchSize) {
      // Check we're not running out of time (leave 8s buffer for response)
      if (Date.now() - startTime > 50000) break;

      const batch = toCrawl.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(async (pageUrl) => {
        try {
          const page = await fetchHtml(pageUrl);
          if (!page.ok) return null;
          const imgs = checkImages ? await auditImageFiles(parseImages(page.html, pageUrl), pageUrl) : [];
          return await auditPage(pageUrl, page.html, page.status, page.ttfb, page.headers, imgs, null);
        } catch { return null; }
      }));
      pageResults.push(...batchResults.filter(Boolean));
    }

    // 5. Build summary
    const allIssues = pageResults.flatMap(p => p.issues);
    const summary = {
      totalPages:     pageResults.length,
      totalIssues:    allIssues.length,
      critical:       allIssues.filter(i => i.severity === 'critical').length,
      high:           allIssues.filter(i => i.severity === 'high').length,
      medium:         allIssues.filter(i => i.severity === 'medium').length,
      low:            allIssues.filter(i => i.severity === 'low').length,
      hasPSI:         !!psiApiKey,
      crawlTime:      Math.round((Date.now() - startTime) / 1000),
      categories: {
        SEO:           allIssues.filter(i => i.category === 'SEO').length,
        Performance:   allIssues.filter(i => i.category === 'Performance').length,
        Accessibility: allIssues.filter(i => i.category === 'Accessibility').length,
        Security:      allIssues.filter(i => i.category === 'Security').length,
      },
    };

    return res.status(200).json({
      success:  true,
      url:      finalBase,
      summary,
      robots:   robotsData,
      sitemap:  sitemapData,
      pages:    pageResults,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
