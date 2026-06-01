// api/discover.js — Site Audit Agent v3.2
// SITEMAP-FIRST: only audits URLs confirmed in sitemap.xml
// Homepage links used ONLY as fallback if sitemap returns 0 results

export const config = { maxDuration: 30 };

async function safeFetch(url, timeoutMs = 10000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: c.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditBot/3.2)', 'Accept': 'text/html,application/xml,text/xml,*/*' },
    });
    clearTimeout(t);
    return res;
  } catch { return null; }
}

// Parse sitemap XML — returns page URLs and child sitemap refs
function parseSitemap(xml, hostname) {
  const pageUrls = [], sitemapRefs = [];
  const indexRx = /<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = indexRx.exec(xml)) !== null) {
    try { if (new URL(m[1].trim()).hostname === hostname) sitemapRefs.push(m[1].trim()); } catch {}
  }
  const locRx = /<url>[\s\S]*?<loc>([\s\S]*?)<\/loc>/gi;
  while ((m = locRx.exec(xml)) !== null) {
    const u = m[1].trim();
    try {
      const p = new URL(u);
      if (p.hostname === hostname
        && !u.match(/\.(jpg|jpeg|png|gif|webp|pdf|zip|css|js|xml|ico|svg|mp4|mp3|woff|woff2|php|txt)(\?|$)/i)
        && !u.includes('/wp-admin') && !u.includes('/wp-login') && !u.includes('/wp-json')
        && !u.includes('/xmlrpc') && !u.includes('/feed') && !u.includes('/trackback')
        && !u.includes('/comment-page') && !u.includes('/embed') && !u.endsWith('.php')
      ) {
        pageUrls.push(p.origin + p.pathname.replace(/\/$/, ''));
      }
    } catch {}
  }
  return { pageUrls: [...new Set(pageUrls)], sitemapRefs };
}

// Fetch sitemaps recursively — follow sitemap index files
async function crawlSitemaps(startUrls, hostname) {
  const visited = new Set(), allUrls = new Set(), found = [], queue = [...startUrls];
  while (queue.length > 0 && visited.size < 15) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const res = await safeFetch(url, 8000);
    if (!res || res.status !== 200) continue;
    const xml = await res.text();
    if (!xml.includes('<loc>')) continue;
    found.push(url);
    const { pageUrls, sitemapRefs } = parseSitemap(xml, hostname);
    pageUrls.forEach(u => allUrls.add(u));
    sitemapRefs.forEach(r => { if (!visited.has(r)) queue.push(r); });
  }
  return { urls: [...allUrls], sitemapsFound: found };
}

async function checkRobots(origin) {
  const url = origin + '/robots.txt';
  const res = await safeFetch(url, 6000);
  if (!res || res.status !== 200) return { found: false, url, issues: ['robots.txt not found — create one at ' + url], info: [], sitemaps: [] };
  const text = await res.text();
  const issues = [], info = [], sitemaps = [];
  const srx = /^Sitemap:\s*(.+)/gim;
  let m;
  while ((m = srx.exec(text)) !== null) sitemaps.push(m[1].trim());
  if (sitemaps.length === 0) info.push('No Sitemap: directive in robots.txt — add one');
  if (/User-agent:\s*\*/i.test(text) && /Disallow:\s*\/\s*$/im.test(text))
    issues.push('robots.txt blocks ALL crawlers with Disallow: / — Google cannot index this site');
  if (!issues.length) info.push('robots.txt found and looks correct ✓');
  return { found: true, url, issues, info, sitemaps, raw: text.slice(0, 600) };
}

async function getSitemapStatus(origin, robotsSitemaps) {
  const candidates = [...new Set([
    ...robotsSitemaps, origin+'/sitemap_index.xml', origin+'/sitemap.xml',
    origin+'/wp-sitemap.xml', origin+'/post-sitemap.xml', origin+'/page-sitemap.xml',
    origin+'/category-sitemap.xml', origin+'/tag-sitemap.xml', origin+'/news-sitemap.xml',
    origin+'/product-sitemap.xml',
  ])];
  for (const url of candidates) {
    const res = await safeFetch(url, 6000);
    if (!res || res.status !== 200) continue;
    const xml = await res.text();
    if (!xml.includes('<loc>')) continue;
    const urlCount = (xml.match(/<loc>/g) || []).length;
    const issues = [], info = [];
    if (!xml.includes('<lastmod>')) info.push('No <lastmod> dates — add for better crawl prioritisation');
    if (xml.includes('<image:loc>')) info.push('Image sitemap entries found ✓');
    if (urlCount > 50000) issues.push('Sitemap exceeds 50,000 URLs — split it');
    if (!issues.length) info.push('Sitemap valid ✓');
    return { found: true, url, urlCount, issues, info };
  }
  return { found: false, issues: ['No sitemap.xml found — create one via Yoast SEO or RankMath'], info: [], urlCount: 0 };
}

// Fallback only — used when sitemap has 0 results
function htmlLinks(html, baseUrl) {
  const base = new URL(baseUrl), found = new Set();
  const re = /href=["']([^"'#?][^"']*?)["']/gi; let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.hostname !== base.hostname) continue;
      const p = abs.pathname.replace(/\/$/, '');
      if (!p.match(/\.(jpg|png|pdf|zip|css|js|php|xml|svg|mp4|woff2?)$/i)
        && !abs.pathname.includes('/wp-admin') && !abs.pathname.includes('/wp-json')
        && !abs.pathname.includes('/xmlrpc') && !abs.pathname.includes('/feed')
        && !abs.pathname.includes('/embed') && !abs.pathname.endsWith('.php')
      ) found.add(abs.origin + (p || '/'));
    } catch {}
  }
  return [...found];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let { url, maxPages = 100 } = req.body || {};
    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const origin = new URL(url).origin;
    const homeRes = await safeFetch(url);
    if (!homeRes || !homeRes.ok) return res.status(400).json({ error: `Cannot reach ${url}` });
    const finalUrl  = homeRes.url;
    const finalHost = new URL(finalUrl).hostname;
    const homeHtml  = await homeRes.text();
    const isWP      = homeHtml.includes('wp-content');

    const robotsData = await checkRobots(origin);

    // Build sitemap candidates — robots.txt refs first (highest priority)
    const sitemapCandidates = [...new Set([
      ...robotsData.sitemaps,
      origin+'/sitemap_index.xml', origin+'/sitemap.xml', origin+'/wp-sitemap.xml',
      origin+'/post-sitemap.xml', origin+'/page-sitemap.xml', origin+'/category-sitemap.xml',
      origin+'/tag-sitemap.xml',
    ])];

    const { urls: sitemapUrls, sitemapsFound } = await crawlSitemaps(sitemapCandidates, finalHost);

    // SITEMAP-FIRST: use only sitemap URLs — homepage link crawl only as fallback
    let rawUrls, discoveryMethod;
    if (sitemapUrls.length > 0) {
      rawUrls = sitemapUrls;
      discoveryMethod = 'sitemap';
    } else {
      rawUrls = htmlLinks(homeHtml, finalUrl);
      discoveryMethod = 'homepage-fallback';
    }

    // Always include homepage, deduplicate, normalise, cap
    const homeNorm = new URL(finalUrl).origin + new URL(finalUrl).pathname.replace(/\/$/, '');
    const seen = new Set();
    const urlList = [];

    for (const u of [homeNorm, ...rawUrls]) {
      try {
        const norm = new URL(u).origin + new URL(u).pathname.replace(/\/$/, '');
        if (!seen.has(norm) && new URL(norm).hostname === finalHost) {
          seen.add(norm);
          urlList.push(norm);
        }
      } catch {}
      if (urlList.length >= Math.min(maxPages, 500)) break;
    }

    const sitemapStatus = await getSitemapStatus(origin, robotsData.sitemaps);

    return res.status(200).json({
      success: true, baseUrl: finalUrl,
      totalFound: sitemapUrls.length,
      urls: urlList,
      sitemapsFound, discoveryMethod, isWordPress: isWP,
      robots: robotsData, sitemap: sitemapStatus,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
