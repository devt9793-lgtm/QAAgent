// api/discover.js
// Step 1: Discovers ALL URLs from sitemap.xml + homepage links
// Returns full URL list so client can queue batches

export const config = { maxDuration: 30 };

async function safeFetch(url, timeoutMs = 10000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: c.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteAuditBot/3.0)' },
      redirect: 'follow',
    });
    clearTimeout(t);
    return res;
  } catch { return null; }
}

// Parse all <loc> URLs from a sitemap XML string
function parseSitemapUrls(xml, baseHostname) {
  const urls = [];
  // Handle sitemap index (points to other sitemaps)
  const indexRx = /<sitemap>[\s\S]*?<loc>([\s\S]*?)<\/loc>/gi;
  let m;
  const sitemapRefs = [];
  while ((m = indexRx.exec(xml)) !== null) sitemapRefs.push(m[1].trim());

  // Handle regular sitemap
  const locRx = /<loc>([\s\S]*?)<\/loc>/gi;
  while ((m = locRx.exec(xml)) !== null) {
    const u = m[1].trim();
    try {
      const parsed = new URL(u);
      // Only include pages from same hostname, skip media files
      if (parsed.hostname === baseHostname &&
          !u.match(/\.(jpg|jpeg|png|gif|webp|pdf|zip|css|js|xml|ico|svg|mp4|mp3|woff|woff2)(\?|$)/i)) {
        urls.push(u.replace(/\/$/, '') || '/');
      }
    } catch {}
  }

  return { urls: [...new Set(urls)], sitemapRefs };
}

// Extract internal links from HTML
function extractLinksFromHtml(html, baseUrl) {
  const base = new URL(baseUrl);
  const found = new Set();
  const re = /href=["']([^"'#?][^"']*?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.hostname === base.hostname) {
        const p = abs.pathname.replace(/\/$/, '');
        if (!p.match(/\.(jpg|jpeg|png|gif|webp|pdf|zip|css|js|xml|ico|svg|mp4|mp3|woff|woff2)$/i) &&
            !abs.pathname.includes('/wp-admin') &&
            !abs.pathname.includes('/wp-login') &&
            !abs.pathname.includes('/feed') &&
            !abs.pathname.includes('/wp-json') &&
            !abs.pathname.includes('/trackback') &&
            !abs.pathname.includes('/comment-page')) {
          found.add(abs.origin + (p || '/'));
        }
      }
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
    url = url.trim();

    const base = new URL(url);
    const origin = base.origin;
    const allUrls = new Set();

    // 1. Fetch homepage
    const homeRes = await safeFetch(url);
    if (!homeRes || !homeRes.ok) return res.status(400).json({ error: `Cannot reach ${url}` });
    const finalUrl = homeRes.url;
    const finalBase = new URL(finalUrl);
    allUrls.add(finalBase.origin + finalBase.pathname.replace(/\/$/, ''));
    const homeHtml = await homeRes.text();

    // 2. Crawl homepage links
    const homeLinks = extractLinksFromHtml(homeHtml, finalUrl);
    homeLinks.forEach(l => allUrls.add(l));

    // 3. Try all common sitemap locations
    const sitemapLocations = [
      origin + '/sitemap.xml',
      origin + '/sitemap_index.xml',
      origin + '/wp-sitemap.xml',
      origin + '/post-sitemap.xml',
      origin + '/page-sitemap.xml',
      origin + '/category-sitemap.xml',
    ];

    // Also check robots.txt for sitemap references
    const robotsRes = await safeFetch(origin + '/robots.txt', 6000);
    if (robotsRes && robotsRes.ok) {
      const robotsTxt = await robotsRes.text();
      const sitemapRx = /Sitemap:\s*(.+)/gi;
      let m;
      while ((m = sitemapRx.exec(robotsTxt)) !== null) {
        sitemapLocations.unshift(m[1].trim()); // prioritise robots.txt sitemaps
      }
    }

    // Fetch sitemaps
    const fetchedSitemaps = new Set();
    const sitemapQueue = [...new Set(sitemapLocations)];

    while (sitemapQueue.length > 0 && fetchedSitemaps.size < 10) {
      const sitemapUrl = sitemapQueue.shift();
      if (fetchedSitemaps.has(sitemapUrl)) continue;
      fetchedSitemaps.add(sitemapUrl);

      const sr = await safeFetch(sitemapUrl, 8000);
      if (!sr || !sr.ok) continue;
      const xml = await sr.text();
      if (!xml.includes('<loc>')) continue;

      const { urls, sitemapRefs } = parseSitemapUrls(xml, finalBase.hostname);
      urls.forEach(u => allUrls.add(u));

      // Add sub-sitemaps to queue (for sitemap index files)
      sitemapRefs.forEach(ref => {
        if (!fetchedSitemaps.has(ref)) sitemapQueue.push(ref);
      });
    }

    // 4. For WordPress sites, also try paginated archives
    if (homeHtml.includes('wp-content') || homeHtml.includes('wp-includes')) {
      const wpUrls = [
        origin + '/blog/', origin + '/news/', origin + '/resources/',
        origin + '/portfolio/', origin + '/services/', origin + '/about/',
        origin + '/contact/', origin + '/privacy-policy/', origin + '/terms/',
      ];
      for (const wu of wpUrls) {
        try {
          const r = await safeFetch(wu, 4000);
          if (r && r.ok) allUrls.add(wu.replace(/\/$/, ''));
        } catch {}
      }
    }

    // 5. Deduplicate and limit
    const urlList = [...allUrls]
      .filter(u => {
        try { return new URL(u).hostname === finalBase.hostname; } catch { return false; }
      })
      .slice(0, Math.min(maxPages, 500));

    return res.status(200).json({
      success: true,
      baseUrl: finalUrl,
      totalFound: allUrls.size,
      urls: urlList,
      sitemapsChecked: [...fetchedSitemaps],
      isWordPress: homeHtml.includes('wp-content'),
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
