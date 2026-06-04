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

  // FIX BUG1: Record true TTFB from the FIRST server response only
  // Before following any redirects — this is the actual server response time
  const ttfb = Date.now() - start;

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

  try {
    const html = await current.text();
    return {
      ok: true, html,
      status: current.status,
      ttfb,  // True TTFB from first server response
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
    const _ht = setTimeout(() => c.abort(), 4000);
    const res = await safeFetch(url, { method: 'HEAD', redirect: 'follow' }, 4000);
    clearTimeout(_ht);
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
  // Detect the site builder from HTML patterns
  const builderInfo = detectBuilder(html, get(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i));

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
    builder:     builderInfo,
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

// Known stock/watermark image CDN domains
const WATERMARK_DOMAINS = [
  'shutterstock.com', 'gettyimages.com', 'istockphoto.com', 'dreamstime.com',
  'depositphotos.com', '123rf.com', 'alamy.com', 'bigstockphoto.com',
  'stock.adobe.com', 'vectorstock.com', 'pond5.com', 'canstockphoto.com',
];

// Check for watermark/stock images in the page HTML

// ─────────────────────────────────────────────────────────────
// BUILDER DETECTION
// Identifies the site technology so fixes can be tailored
// ─────────────────────────────────────────────────────────────
function detectBuilder(html, generator) {
  const h = html.toLowerCase();
  const g = (generator || '').toLowerCase();

  // ── Page Builders ──────────────────────────────────────
  if (g.includes('elementor') || h.includes('wp-content/plugins/elementor') || h.includes('elementor-frontend'))
    return { id: 'elementor', name: 'Elementor', icon: '🔷', type: 'wordpress-builder' };

  if (h.includes('et-pb-section') || h.includes('et-pb-row') || h.includes('/themes/divi') || h.includes('/plugins/divi-builder'))
    return { id: 'divi', name: 'Divi', icon: '🟣', type: 'wordpress-builder' };

  if (h.includes('fl-builder') || h.includes('/plugins/bb-plugin') || h.includes('fl-row fl-row'))
    return { id: 'beaver', name: 'Beaver Builder', icon: '🦫', type: 'wordpress-builder' };

  if (h.includes('vc_row') || h.includes('vc_column') || h.includes('wpb-js-composer') || h.includes('/plugins/js_composer'))
    return { id: 'wpbakery', name: 'WPBakery', icon: '🟤', type: 'wordpress-builder' };

  if (h.includes('ct-section') || h.includes('ct-div-block') || h.includes('/plugins/oxygen'))
    return { id: 'oxygen', name: 'Oxygen Builder', icon: '🔵', type: 'wordpress-builder' };

  if (h.includes('brxe-container') || h.includes('brxe-block') || h.includes('/plugins/bricks'))
    return { id: 'bricks', name: 'Bricks Builder', icon: '🧱', type: 'wordpress-builder' };

  if (h.includes('/plugins/breakdance') || h.includes('breakdance-'))
    return { id: 'breakdance', name: 'Breakdance', icon: '🕺', type: 'wordpress-builder' };

  if (h.includes('siteorigin-css') || h.includes('/plugins/siteorigin-panels'))
    return { id: 'siteorigin', name: 'SiteOrigin', icon: '🌐', type: 'wordpress-builder' };

  if (h.includes('fusion-builder') || h.includes('/themes/avada') || h.includes('fusion_builder_row'))
    return { id: 'avada', name: 'Avada / Fusion Builder', icon: '🔴', type: 'wordpress-builder' };

  // ── Block / Gutenberg ───────────────────────────────────
  if (h.includes('wp-block-') && !h.includes('plugins/elementor') && !h.includes('et-pb-'))
    return { id: 'gutenberg', name: 'WordPress Block Editor (Gutenberg)', icon: '🧩', type: 'wordpress-blocks' };

  // ── Non-WordPress CMS ───────────────────────────────────
  if (h.includes('cdn.shopify.com') || h.includes('shopify.theme') || h.includes('myshopify.com'))
    return { id: 'shopify', name: 'Shopify', icon: '🛍️', type: 'shopify' };

  if (h.includes('static.squarespace.com') || h.includes('squarespace-cdn.com'))
    return { id: 'squarespace', name: 'Squarespace', icon: '⬛', type: 'squarespace' };

  if (h.includes('static.wixstatic.com') || h.includes('wix.com/_api') || h.includes('x-wix-'))
    return { id: 'wix', name: 'Wix', icon: '⬜', type: 'wix' };

  if (h.includes('webflow.com') || h.includes('webflow.io'))
    return { id: 'webflow', name: 'Webflow', icon: '🌊', type: 'webflow' };

  if (h.includes('wp-content') || h.includes('wp-includes') || h.includes('wp-json'))
    return { id: 'wordpress', name: 'WordPress (Custom Theme)', icon: '🔵', type: 'wordpress-custom' };

  // ── Custom / Framework ──────────────────────────────────
  if (h.includes('next.js') || h.includes('__next') || h.includes('_next/static'))
    return { id: 'nextjs', name: 'Next.js', icon: '▲', type: 'custom' };

  if (h.includes('nuxt') || h.includes('__nuxt'))
    return { id: 'nuxtjs', name: 'Nuxt.js', icon: '💚', type: 'custom' };

  if (h.includes('gatsby') || h.includes('/gatsby-'))
    return { id: 'gatsby', name: 'Gatsby', icon: '💜', type: 'custom' };

  if (h.includes('angular') || h.includes('ng-version'))
    return { id: 'angular', name: 'Angular', icon: '🔴', type: 'custom' };

  if (h.includes('react') || h.includes('data-reactroot') || h.includes('__react'))
    return { id: 'react', name: 'React', icon: '⚛️', type: 'custom' };

  return { id: 'custom', name: 'Custom HTML/Unknown', icon: '⚙️', type: 'custom' };
}

// ─────────────────────────────────────────────────────────────
// BUILDER-SPECIFIC FIX GENERATOR
// Returns the right solution path based on detected builder
// ─────────────────────────────────────────────────────────────
function builderFix(builder, fixType) {
  const b = (builder && builder.id) ? builder.id : 'custom';

  const fixes = {
    // ── CSS render-blocking fix ────────────────────────────
    css_render_blocking: {
      elementor:   'Elementor → Settings → Experiments → Enable "Improved CSS Loading" → Save → Tools → Regenerate CSS & Data → Flush cache.',
      divi:        'Divi → Theme Options → Performance → Enable "Dynamic CSS" → Enable "Critical CSS" → Save. Also: Divi → Theme Options → Performance → Static CSS File Generation → ON.',
      beaver:      'Beaver Builder CSS is already generated per-page. Enable "CSS/JS Version" in Settings → Advanced → CSS/JS Version to bust cache. Use WP Rocket → Minify/Combine CSS.',
      wpbakery:    'WPBakery: Disable "Use frontend stylesheet" in WPBakery → Settings → General → Front-end editor. Use a caching plugin to combine CSS.',
      oxygen:      'Oxygen automatically outputs only used CSS. Enable cache plugin (WP Rocket/LiteSpeed) → Enable CSS combine.',
      bricks:      'Bricks → Settings → Performance → Enable "CSS Loading Method" → External Files. Enable WP Rocket or LiteSpeed → CSS Combine.',
      gutenberg:   'WordPress → Appearance → Editor → reduce block usage. Install Asset CleanUp or Perfmatters to disable unused block CSS. Use WP Rocket → Remove Unused CSS.',
      shopify:     'Shopify: Edit theme liquid → move non-critical CSS to bottom of body. Use Shopify Speed Optimizer app or PageSpeed Monkey.',
      wordpress:   'Enable caching plugin: WP Rocket → File Optimization → Optimize CSS Delivery → Load CSS Asynchronously. Or use Autoptimize.',
      custom:      'Move non-critical CSS below the fold. Use <link rel="preload" as="style"> for critical CSS. Defer remaining with media="print" onload="this.media='all'".',
      default:     'Enable CSS Combine and Minify in your cache plugin. Move non-critical CSS to load asynchronously.',
    },

    // ── JavaScript defer/async ─────────────────────────────
    js_defer: {
      elementor:   'Elementor → Settings → Performance → Load JS Deferred → ON. Also in LiteSpeed/WP Rocket: JS Defer ON. Exclude: elementor-frontend.min.js, jquery.min.js from defer.',
      divi:        'Divi → Theme Options → Performance → Defer jQuery & Theme Scripts → ON. Also enable JS Deferral in WP Rocket or LiteSpeed Cache.',
      beaver:      'Beaver Builder: Use WP Rocket → File Optimization → Delay JavaScript Execution. Exclude: fl-builder.min.js from defer.',
      wpbakery:    'WPBakery: Use WP Rocket or LiteSpeed → JS Defer ON. Exclude: wpb_composer_front_js from defer to prevent layout issues.',
      oxygen:      'Oxygen: Scripts are already minimal. Use WP Rocket → Delay JS Execution → Delay All. Exclude: oxygen-vsb-frontend.js.',
      bricks:      'Bricks → Settings → Performance → Script Loading → Defer. Or use WP Rocket → File Optimization → Delay JS.',
      gutenberg:   'WordPress: Add defer to non-critical scripts in functions.php: add_filter("script_loader_tag", function($tag, $handle){ ... }). Or use Asset CleanUp plugin.',
      shopify:     'Shopify: Move <script> tags to bottom of theme.liquid. Use async/defer attributes. Remove unused Shopify apps that inject scripts.',
      wordpress:   'Add to functions.php: wp_script_add_data("your-script-handle", "defer", true); Or use WP Rocket → Delay JavaScript.',
      custom:      'Add defer attribute to all non-critical <script> tags. Move scripts to end of <body>. Use async for independent scripts (analytics, chat widgets).',
      default:     'Add defer to non-critical scripts. Move JS to end of body tag.',
    },

    // ── Image lazy loading ─────────────────────────────────
    image_lazy: {
      elementor:   'Elementor → Settings → Performance → Lazy Load Images → ON. Also: each Image widget → Advanced → Lazy Load → ON. Hero/banner images should use "Eager" loading.',
      divi:        'Divi → Theme Options → Performance → Enable "Dynamic Images Loading" (lazy load) → ON. Alternatively enable in LiteSpeed/WP Rocket.',
      beaver:      'Beaver Builder: Add loading="lazy" via custom HTML module. Or enable lazy loading in WP Rocket → Media → LazyLoad.',
      wpbakery:    'WPBakery: Use native WordPress lazy loading (available since WP 5.5 automatically). Or add via LiteSpeed Cache → Image Optimization → Lazy Load.',
      oxygen:      'Oxygen: Use native HTML loading="lazy" attribute in image elements. Or enable via WP Rocket → Media → Lazy Load.',
      bricks:      'Bricks → Settings → Performance → Lazy Load Images → ON. Also edit individual Image elements → Lazy Load option.',
      gutenberg:   'WordPress automatically adds loading="lazy" to most images since v5.5. For Gallery blocks: regenerate thumbnails. Check via: wp media regenerate --yes.',
      shopify:     'Shopify: Edit theme liquid → add loading="lazy" to <img> tags. Or use a Shopify lazy loading app. Modern themes include this by default.',
      wordpress:   'Add to functions.php: add_filter("wp_lazy_loading_enabled", "__return_true"); Or enable in your cache plugin.',
      custom:      'Add loading="lazy" to all below-fold <img> tags. First/hero image should use loading="eager" or fetchpriority="high".',
      default:     'Add loading="lazy" to below-fold images. Use fetchpriority="high" on the LCP/hero image.',
    },

    // ── Page speed / caching ───────────────────────────────
    page_cache: {
      elementor:   'Install LiteSpeed Cache or WP Rocket. Enable Page Cache + Mobile Cache + Crawler. In Elementor: clear cache after saving pages.',
      divi:        'WP Rocket → Cache → Mobile Cache ON + Cache for Logged-in Users OFF. Or LiteSpeed Cache if on LiteSpeed server. Clear Divi static CSS after cache changes.',
      beaver:      'WP Rocket or LiteSpeed Cache. Beaver Builder compatible with both. Enable crawler to pre-warm all pages.',
      wpbakery:    'WP Rocket with WPBakery Compatibility Mode. Or W3 Total Cache. Note: WPBakery shortcodes can conflict with some cache plugins.',
      oxygen:      'Any caching plugin works well with Oxygen. LiteSpeed Cache (free) or WP Rocket. Oxygen generates clean HTML so caching is very effective.',
      bricks:      'Bricks works well with LiteSpeed Cache and WP Rocket. Enable Object Cache and Page Cache.',
      gutenberg:   'WP Rocket → Cache tab → Enable caching for mobile + Enable page cache. Or use WP Super Cache (free). Ensure cache clears on post publish.',
      shopify:     'Shopify handles server-side caching automatically. Focus on: removing unused apps, optimising images, using a CDN via Shopify's built-in Fastly CDN.',
      squarespace: 'Squarespace handles caching server-side. Optimise by: reducing custom code blocks, compressing images before upload, removing unused blocks.',
      wix:         'Wix handles caching automatically. Focus on: reducing installed apps, compressing images, using Wix's built-in image optimisation.',
      wordpress:   'Install LiteSpeed Cache (free) or WP Rocket ($59/yr). Enable: Page Cache + Mobile Cache + Browser Cache (1 year TTL) + Crawler.',
      custom:      'Add server-side caching (Redis/Memcached for dynamic content). Add Cache-Control headers for static assets. Consider a CDN (Cloudflare free tier).',
      default:     'Enable a page caching solution. Set Cache-Control headers for static assets.',
    },

    // ── Font display swap ──────────────────────────────────
    font_display: {
      elementor:   'Elementor → Settings → Performance → Font Display → change from "Auto" to "Swap". This fixes FOIT (Flash of Invisible Text) that hurts FCP.',
      divi:        'Divi → Theme Options → General → Font Subsetting → Enable. For font-display: install Divi Speed plugin or add to child theme CSS: @font-face { font-display: swap; }',
      beaver:      'Add to child theme style.css or Customizer → Additional CSS: @font-face { font-display: swap; } Or use OMGF plugin (Optimize My Google Fonts) to self-host fonts.',
      wpbakery:    'Edit child theme functions.php to modify font loading: add_filter("style_loader_tag", function($tag){ return str_replace("rel='stylesheet'", "rel='stylesheet' font-display='swap'", $tag); });',
      gutenberg:   'Add to theme.json → "settings" → "typography" → "fontFamilies" with fontDisplay: "swap". Or add via Customizer → Additional CSS.',
      shopify:     'Edit theme.liquid → find @font-face declarations → add font-display: swap; Or use Google Fonts with &display=swap parameter.',
      wordpress:   'Add to functions.php: add_filter("script_loader_tag", ...). Or use OMGF (Optimize My Google Fonts) plugin for automatic fix.',
      custom:      'Add font-display: swap; to all @font-face declarations in your CSS. For Google Fonts: append &display=swap to the font URL.',
      default:     'Add font-display: swap to @font-face declarations. For Google Fonts: add &display=swap to URL.',
    },

    // ── WebP image conversion ──────────────────────────────
    image_webp: {
      elementor:   'Install ShortPixel or Imagify plugin → bulk convert to WebP. In LiteSpeed Cache → Image Optimization → WebP Replacement → ON (needs free QUIC.cloud key). Elementor regenerates srcsets automatically.',
      divi:        'Divi includes basic image optimisation. Add ShortPixel plugin for WebP conversion. Divi's lazy loading respects WebP format automatically.',
      beaver:      'Install Imagify or ShortPixel for WebP. Beaver Builder uses WordPress core images so WebP conversion applies site-wide automatically.',
      wpbakery:    'Install ShortPixel or Smush → Convert to WebP. WPBakery uses standard WordPress images so bulk conversion via plugin covers all images.',
      oxygen:      'Oxygen uses standard WordPress media. Install ShortPixel → Settings → WebP Delivery → ON. Works immediately for all Oxygen image elements.',
      bricks:      'Bricks uses WordPress media library. Install Imagify or ShortPixel → Enable WebP Delivery → Regenerate thumbnails to create WebP versions.',
      gutenberg:   'WordPress 5.8+ supports WebP natively. Enable in LiteSpeed Cache → Image Optimization → WebP, OR install Imagify/ShortPixel plugin. Upload WebP directly to Media Library.',
      shopify:     'Shopify CDN (Fastly) automatically serves WebP to browsers that support it. Use Shopify's image CDN URL format: image.jpg?format=webp. No plugin needed.',
      squarespace: 'Squarespace automatically converts images to WebP. Ensure you upload high-quality originals and let Squarespace handle conversion.',
      wordpress:   'Install ShortPixel (free 100 images/month) or Imagify. Enable WebP Delivery mode. All existing and new images convert automatically.',
      custom:      'Convert images to WebP: cwebp -q 80 image.jpg -o image.webp. Serve via <picture> element with WebP as first source, JPG as fallback.',
      default:     'Convert images to WebP format. Use a compression plugin or convert manually with cwebp tool.',
    },

    // ── Hero preload ───────────────────────────────────────
    hero_preload: {
      elementor:   'Elementor → Site Settings → Custom Code → Add to <head>: <link rel="preload" as="image" fetchpriority="high" href="YOUR-HERO-URL">. Find the hero URL by inspecting the first above-fold image.',
      divi:        'Divi → Theme Options → Integration → Add to <head>: <link rel="preload" as="image" fetchpriority="high" href="YOUR-HERO-URL">. Or edit child theme header.php.',
      beaver:      'Beaver Builder: Go to Appearance → Customize → Additional CSS/Code → or edit header.php in child theme. Add preload tag for first visible image.',
      wpbakery:    'Edit child theme header.php → add inside <head>: <link rel="preload" as="image" fetchpriority="high" href="HERO-URL">. Or use a custom code plugin like Code Snippets.',
      oxygen:      'Oxygen → Manage → Settings → Global Site Code → Head Code → add preload tag. Or use a custom code plugin.',
      bricks:      'Bricks → Settings → Custom Code → Header Scripts → add <link rel="preload" as="image" fetchpriority="high" href="HERO-URL">.',
      gutenberg:   'Add to theme functions.php: function add_hero_preload(){ echo '<link rel="preload" as="image" fetchpriority="high" href="HERO-URL">'; } add_action("wp_head", "add_hero_preload", 1);',
      shopify:     'Shopify: Edit theme.liquid → add inside <head> section: <link rel="preload" as="image" fetchpriority="high" href="{{ section.settings.hero_image | img_url: '1920x' }}">',
      wordpress:   'Add to functions.php: add_action("wp_head", function(){ echo '<link rel="preload" as="image" fetchpriority="high" href="HERO-URL">'; }, 1);',
      custom:      'Add to <head>: <link rel="preload" as="image" fetchpriority="high" href="HERO-IMAGE-URL">. Only preload the first visible (LCP) image. Do not preload below-fold images.',
      default:     'Add <link rel="preload" as="image" fetchpriority="high" href="HERO-URL"> to <head>.',
    },

    // ── DOM size reduction ─────────────────────────────────
    dom_size: {
      elementor:   'DOM size with Elementor is naturally high (3-5x vs custom code). Reduce by: (1) Elementor → Edit page → collapse unused sections, (2) delete hidden/empty widgets, (3) Settings → Experiments → Enable "Optimised DOM Output" (reduces wrapper divs ~50%).',
      divi:        'Divi generates heavy DOM by default. Fix: (1) Divi → Theme Options → Performance → Enable "Dynamic CSS" (removes per-module CSS), (2) avoid nested rows, (3) use Divi Speed plugin to remove unused modules.',
      beaver:      'Beaver Builder DOM is lighter than Elementor/Divi. Reduce by: (1) use Row → Column layouts instead of nested modules, (2) remove empty padding spacers, (3) consolidate similar sections.',
      wpbakery:    'WPBakery generates heavy nested markup. Fix: (1) enable WPBakery → Settings → "Disable Frontend Editor" to reduce scripts, (2) replace nested rows with simpler structures, (3) consider migrating complex sections to Gutenberg blocks.',
      oxygen:      'Oxygen produces the cleanest DOM of any builder. If DOM is still large: remove unused classes, consolidate containers, use Oxygen's Code Block for complex layouts instead of nested elements.',
      bricks:      'Bricks → Settings → Performance → Enable "Nestable Elements" and "Query Loops" optimisation. Remove unused elements. Use CSS Grid instead of nested Bricks containers.',
      gutenberg:   'Gutenberg blocks add minimal DOM. Reduce by: (1) remove unused block plugins, (2) use core blocks instead of plugin blocks where possible, (3) disable block.json enqueuing for unused blocks via Asset CleanUp.',
      shopify:     'Reduce Shopify DOM by: (1) remove unused section/block files from theme, (2) disable unnecessary Shopify apps that inject DOM elements, (3) simplify liquid template nesting.',
      wordpress:   'Reduce WordPress DOM: (1) remove unused widgets from sidebars, (2) simplify template hierarchy, (3) use Transients API to cache complex HTML fragments.',
      custom:      'Reduce DOM by: (1) flatten nested divs (max 3-4 levels deep), (2) use CSS Grid/Flexbox instead of wrapper divs, (3) remove empty/spacer elements, (4) avoid inline style wrappers.',
      default:     'Simplify HTML structure. Remove unnecessary wrapper elements. Target under 1500 DOM nodes for optimal performance.',
    },

    // ── Missing alt text ───────────────────────────────────
    image_alt: {
      elementor:   'Click each Image widget → Content → Image → Alt Text field. Or bulk fix: WordPress Media Library → select image → Edit → Alt Text. Or install "Fix Missing Alt Tags" plugin for bulk AI-generated alt text.',
      divi:        'Divi Image module → Content → Image → Alt Text field. For background images: these cannot have alt text (decorative). For gallery images: Images → Alt Text per image.',
      beaver:      'Beaver Builder → Photo module → Alt Text field. For WordPress core images: Media Library → click image → Alt Text field on the right.',
      wpbakery:    'WPBakery → Single Image element → Image Settings → Alt Text. Bulk fix via WordPress Media Library or the Alt Text AI plugin.',
      oxygen:      'Oxygen Image element → Properties → Alt field. Or set in WordPress Media Library → Edit attachment → Alt Text field.',
      bricks:      'Bricks Image element → Content → Alternative Text field. Or bulk fix in WordPress Media Library.',
      gutenberg:   'Gutenberg Image block → Block settings (right sidebar) → Alt Text field. Bulk fix: Media Library → list view → edit each image.',
      shopify:     'Shopify: Products → click product → click image → Edit alt text. For theme images: Assets → edit image in code → add alt="{{ image.alt }}".',
      wordpress:   'WordPress Media Library → click image → Alt Text field. Bulk fix with Alt Text AI or SEO plugins (Yoast, RankMath) which flag missing alt text.',
      custom:      'Add alt="" attribute to all <img> tags. Descriptive alt for informative images, empty alt="" for decorative images (not alt="image" or filename).',
      default:     'Add descriptive alt text to all images. Use the Media Library to set alt text site-wide.',
    },

    // ── Broken links ───────────────────────────────────────
    broken_links: {
      elementor:   'Elementor: click the link element → Content → Link field → update URL. For buttons: Button widget → Link field. Run Broken Link Checker plugin for site-wide scan.',
      divi:        'Divi: click the module → Content → URL or Link field → update. Use Broken Link Checker plugin or Screaming Frog to scan all Divi links.',
      wordpress:   'Install Broken Link Checker plugin (free) → Links → 404 Not Found → bulk edit or unlink. Or use WP Links Page plugin.',
      shopify:     'Shopify Admin → Navigation → fix broken menu links. For product links: use Shopify's built-in redirect manager. Apps: Easy Redirects for bulk management.',
      custom:      'Use a link checking tool (Screaming Frog, Ahrefs). Fix or redirect broken URLs. Set up 301 redirects for changed URLs.',
      default:     'Update the broken link to the correct URL. If the page was moved, set up a 301 redirect.',
    },

    // ── Canonical URL ──────────────────────────────────────
    canonical: {
      elementor:   'Install Yoast SEO or RankMath → edit the page → Advanced tab → Canonical URL field. These plugins add canonical automatically based on the page URL.',
      divi:        'Install Yoast SEO or RankMath alongside Divi. Both are fully compatible. Edit each page → SEO meta box → Advanced → Canonical URL.',
      wordpress:   'Yoast SEO: Dashboard → SEO → Search Appearance → confirm canonical settings. RankMath: Dashboard → Rank Math → Titles & Meta → ensure canonical is enabled.',
      shopify:     'Shopify automatically adds canonical tags in most themes. Check theme.liquid for: {{ canonical_url }} or <link rel="canonical" href="{{ canonical_url }}">. Add if missing.',
      squarespace: 'Squarespace adds canonical tags automatically. If missing, check Settings → Advanced → Code Injection → Header for any overriding code.',
      custom:      'Add <link rel="canonical" href="FULL-URL"> to <head> on every page. Use the absolute URL of the preferred version of the page.',
      default:     'Add canonical tag via your SEO plugin or manually in <head>.',
    },

    // ── noindex removal ────────────────────────────────────
    noindex: {
      elementor:   'Check: (1) WordPress → Settings → Reading → "Discourage search engines" must be UNCHECKED, (2) Yoast/RankMath → edit page → Advanced → Robots → set to Index, (3) Elementor does not add noindex directly.',
      divi:        'Check: (1) WordPress → Settings → Reading → ensure not blocking search engines, (2) Divi → Page Settings → no SEO noindex setting exists — use Yoast/RankMath alongside Divi.',
      wordpress:   'WordPress Admin → Settings → Reading → uncheck "Discourage search engines". Then check each page: Yoast/RankMath → Advanced → Robots Meta → should be Index.',
      shopify:     'Shopify: Settings → Search engine listing → ensure "Active" pages are not hidden. Check robots.txt in Online Store → Themes → Edit Code → config/robots.txt.liquid.',
      custom:      'Remove <meta name="robots" content="noindex"> from <head>. Check your CMS/framework for global noindex settings.',
      default:     'Remove noindex from page meta robots. Check Settings → Reading in WordPress or your CMS equivalent.',
    },
  };

  const fixMap = fixes[fixType];
  if (!fixMap) return null;
  return fixMap[b] || fixMap.default || fixMap.wordpress || null;
}


function findWatermarkImages(images, baseUrl) {
  const found = [];
  for (const img of images) {
    if (!img.src || img.src.startsWith('data:')) continue;
    try {
      const host = new URL(img.src, baseUrl).hostname.toLowerCase();
      const match = WATERMARK_DOMAINS.find(d => host.includes(d));
      if (match) {
        found.push({
          src: img.src,
          domain: match,
          filename: img.src.split('/').pop().split('?')[0].slice(0, 60),
          raw: img.raw.slice(0, 100),
        });
      }
    } catch {}
    // Also check filename patterns common in stock photos
    const fn = img.src.toLowerCase();
    if (/depositphotos_|shutterstock_|gettyimages-|istock-|dreamstime_/.test(fn)) {
      found.push({
        src: img.src,
        domain: 'filename pattern',
        filename: img.src.split('/').pop().split('?')[0].slice(0, 60),
        raw: img.raw.slice(0, 100),
      });
    }
  }
  // Deduplicate by src
  return found.filter((v, i, a) => a.findIndex(t => t.src === v.src) === i);
}

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
async function auditImageFiles(images, baseUrl, maxCheck = 8) {
  const candidates = images.filter(i => i.src && !i.src.startsWith('data:') && /\.(jpg|jpeg|png|gif|webp|avif)(\?|$)/i.test(i.src)).slice(0, maxCheck);
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
async function checkBrokenLinks(links, baseUrl, max = 8) {
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
async function auditPage(url, html, status, ttfb, headers, redirectChain, imgData, brokenLinks, wpSecurity, siteBaseUrl, siteChecks = {}, builder = null) {
  const issues  = [];
  const meta    = parseMeta(html);
  const b     = meta.builder; // detected builder
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

  // wp-admin URL — only check on homepage (pre-computed in handler)
  if (siteChecks && siteChecks.wpAdminExposed)
    push('Security', 'medium', 'Default /wp-admin/ URL is accessible',
      `${base.origin}/wp-admin/ is publicly accessible`,
      'Hide admin URL using WPS Hide Login or Perfmatters plugin. Change to something unique like /manage/ or /portal/.');

  // HTTP→HTTPS redirect — only check on homepage (pre-computed in handler)
  if (siteChecks && siteChecks.httpExposed)
    push('Security', 'high', 'HTTP version returns 200 — no HTTPS redirect',
      `The HTTP version of this site is accessible without redirecting to HTTPS`,
      'Add redirect in .htaccess: RewriteEngine On / RewriteCond %{HTTPS} off / RewriteRule ^(.*)$ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]');

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
  // FIX BUG8: Update prev for empty headings too, prevents false "skipped" issues
  // Also deduplicate: only report ONE heading skip per page
  let prev = 0;
  let headingSkipReported = false;
  for (const h of headings) {
    const lvl = parseInt(h.level[1]);
    if (h.text.length === 0) {
      const loc = locate(html, h.raw, h.level);
      push('SEO', 'medium', `Empty ${h.level.toUpperCase()} heading tag`,
        `An empty <${h.level}></${h.level}> tag adds no SEO value and confuses screen readers.`,
        'Remove the empty heading tag or add meaningful content. In Elementor: find and delete empty heading widgets.',
        loc || null);
    }
    if (!headingSkipReported && prev > 0 && lvl > prev + 1) {
      const loc = locate(html, h.raw, h.level);
      push('Accessibility', 'medium', `Heading level skipped: H${prev} → H${lvl}`,
        `"${h.text.slice(0, 60)}"`,
        `Use sequential heading levels (H1→H2→H3). Change this heading from H${lvl} to H${prev + 1} in your page builder.`,
        loc ? { ...loc, selector: h.level } : null);
      headingSkipReported = true; // Only report first skip per page
    }
    prev = lvl; // Update prev ALWAYS, including for empty headings
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
  // FIX BUG5: External noopener — skip known social/trusted domains, reduce to low
  const SOCIAL_DOMAINS = ['facebook.com','instagram.com','twitter.com','x.com',
    'linkedin.com','youtube.com','tiktok.com','pinterest.com','google.com'];
  const extNoOpener = links.filter(l => {
    try {
      const host = new URL(l.href).hostname;
      return host !== base.hostname &&
             l.target === '_blank' &&
             !l.rel.includes('noopener') &&
             !SOCIAL_DOMAINS.some(d => host.includes(d)); // skip social media
    } catch { return false; }
  });
  const allExtBlank = links.filter(l => {
    try { return new URL(l.href).hostname !== base.hostname && l.target === '_blank' && !l.rel.includes('noopener'); }
    catch { return false; }
  });
  // Flag social links at low severity separately
  const socialNoOpener = allExtBlank.filter(l => {
    try { return SOCIAL_DOMAINS.some(d => new URL(l.href).hostname.includes(d)); } catch { return false; }
  });
  if (extNoOpener.length > 0) {
    const loc = locate(html, extNoOpener[0].raw, 'a');
    push('Security', 'medium', `${extNoOpener.length} external link(s) missing rel="noopener noreferrer"`,
      extNoOpener.slice(0, 3).map(l => l.href.slice(0, 60)).join(', '),
      'Add rel="noopener noreferrer" to all target="_blank" links. This prevents the opened page from accessing window.opener and is a security best practice.',
      loc || null);
  }
  if (socialNoOpener.length > 0) {
    push('Security', 'low', `${socialNoOpener.length} social media link(s) missing rel="noopener"`,
      socialNoOpener.slice(0, 3).map(l => l.href.slice(0, 60)).join(', '),
      'Add rel="noopener noreferrer" to social media links with target="_blank". Low risk but good practice.');
  }

  // www/non-www — only check on homepage (first page) to avoid duplicate issues per page
  // FIX BUG4: www/non-www — use the homepage (base.origin) not current page URL
  // Only run on homepage to avoid redundant checks
  if (url === siteBaseUrl || url.replace(/\/$/, '') === siteBaseUrl.replace(/\/$/, '')) {
    try {
      // Build the alternate version using the origin, not the full URL path
      const homeUrl = base.origin + '/';
      const altHome = homeUrl.includes('://www.')
        ? homeUrl.replace('://www.', '://')
        : homeUrl.replace('://', '://www.');
      const altR = await headReq(altHome);
      if (altR.status === 200)
        push('SEO', 'medium', 'Both www and non-www versions accessible — no redirect',
          `Both ${base.origin} and ${altHome.replace(/\/$/,'')} return 200. Choose one as canonical.`,
          'Set up a 301 redirect: pick either www or non-www as your canonical version and redirect the other. In .htaccess: RewriteCond %{HTTP_HOST} ^www\. and RewriteRule to non-www (or vice versa). Ensure WordPress Address settings match.');
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

  // FIX BUG2: Smart cache detection — check all caching headers before flagging
  const cc     = headers['cache-control'] || headers['Cache-Control'] || '';
  const lsHit  = (headers['x-litespeed-cache'] || '').toLowerCase().includes('hit');
  const cfHit  = (headers['cf-cache-status'] || '').toLowerCase() === 'hit';
  const xcHit  = (headers['x-cache'] || '').toLowerCase().includes('hit');
  const ageHdr = parseInt(headers['age'] || '0') > 0;
  const isActivelyCached = lsHit || cfHit || xcHit || ageHdr;
  const maxAgeMatch = cc.match(/max-age=(\d+)/i);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) : 0;
  const hasBrowserCache = maxAge > 3600; // >1 hour = good browser caching

  if (!isActivelyCached && !hasBrowserCache) {
    if (cc.includes('no-store')) {
      push('Performance', 'medium', 'Cache-Control: no-store — browsers cannot cache this page',
        `Cache-Control: "${cc}"`,
        'Remove no-store directive. Enable caching plugin. Add to .htaccess: Header set Cache-Control "public, max-age=604800"');
    } else if (!cc) {
      push('Performance', 'medium', 'No browser cache headers detected',
        'No Cache-Control header on this page. Caching plugin may not be active or not warmed.',
        'Enable page caching in your cache plugin (WP Rocket, W3 Total Cache, LiteSpeed Cache). Verify cache is working by re-loading the page and checking for cache comment in HTML source.');
    }
  }

  // Render-blocking CSS
  const blockCSS = styles.filter(s => !s.media || s.media === 'all' || s.media === 'screen');
  if (blockCSS.length > 8)
    push('Performance', 'critical', `${blockCSS.length} render-blocking CSS files`,
      blockCSS.slice(0, 3).map(s => s.href.split('/').pop()).join(', ') + '…',
      builderFix(b,'css_render_blocking') || 'Enable CSS Combine in your cache plugin. Use Critical CSS generation to inline above-fold styles.');
  else if (blockCSS.length > 4)
    push('Performance', 'high', `${blockCSS.length} render-blocking CSS files`, '', 'LiteSpeed Cache → CSS Combine + Minify.');

  // FIX BUG3: Smarter unminified detection
  // Exclude: cache plugin outputs, builder runtime files, CDN files
  const SKIP_UNMIN = [
    'googleapis', 'googletagmanager', 'google-analytics', 'facebook',
    '/cache/', '/wp-content/cache/', 'wpspeed', 'litespeed',
    '/elementor/', '/elementor-pro/', '/page-builder/',
    '/revslider/', '/siteorigin-', '/divi/', '/beaver-builder/',
    'jquery.js', 'jquery-', // jQuery unversioned is always fine
  ];
  const isSkipped = (src) => SKIP_UNMIN.some(s => src.includes(s));

  const unminJS = scripts.filter(s =>
    s.src &&
    !s.src.includes('.min.') &&
    !s.src.includes('min.js') &&
    s.src.includes('.js') &&
    !isSkipped(s.src)
  );
  if (unminJS.length > 3)
    push('Performance', 'medium', `${unminJS.length} potentially unminified JavaScript file(s)`,
      unminJS.slice(0, 3).map(s => s.src.split('/').pop()).join(', '),
      'Enable JS Minify in your cache plugin (WP Rocket → File Optimization → Minify JS, W3TC → Minify → JS). Threshold: flag only if 4+ clearly unminified files found.');

  const unminCSS = styles.filter(s =>
    s.href &&
    !s.href.includes('.min.') &&
    !s.href.includes('min.css') &&
    s.href.includes('.css') &&
    !isSkipped(s.href)
  );
  if (unminCSS.length > 3)
    push('Performance', 'medium', `${unminCSS.length} potentially unminified CSS file(s)`,
      unminCSS.slice(0, 3).map(s => s.href.split('/').pop()).join(', '),
      'Enable CSS Minify in your cache plugin settings. WP Rocket → File Optimization → Minify CSS.');

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
      builderFix(b,'js_defer') || 'Add defer to non-critical scripts. Exclude jquery.min.js and builder core scripts from defer.',
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
      builderFix(b,'font_display') || 'Set font-display: swap on @font-face declarations.');

  // Hero preload
  if (!/<link[^>]*rel=["']preload["'][^>]*as=["']image["']/i.test(html) && images.length > 0)
    push('Performance', 'high', 'No hero image preload tag in <head>',
      'LCP hero image discovered late after CSS is parsed.',
      builderFix(b,'hero_preload') || 'Add <link rel="preload" as="image" fetchpriority="high" href="HERO-URL"> to <head>.',
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
  // Watermark / stock images — check img tags in HTML (no network needed)
  const watermarkImgs = findWatermarkImages(images, url);
  for (const wm of watermarkImgs.slice(0, 5)) {
    const loc = locate(html, wm.raw, 'img');
    push('Content', 'critical',
      `Watermarked/stock image detected: ${wm.filename}`,
      `Image from ${wm.domain} — may be unlicensed or display a watermark on the live site.`,
      'Replace with a properly licensed or self-owned image. Purchase a license from the stock site, use a royalty-free alternative (Unsplash, Pexels), or upload your own photo.',
      loc ? { ...loc, imageUrl: wm.src } : { imageUrl: wm.src, selector: `img[src*="${wm.filename}"]`, context: wm.raw, raw: wm.raw });
  }

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
  // FIX BUG7: Skip first image (hero/LCP) — it should NOT be lazy loaded
  // Also skip images with fetchpriority=high or data-no-lazy attribute
  const noLazy = images.filter((i, idx) =>
    i.src &&
    !i.src.startsWith('data:') &&
    i.loading !== 'lazy' &&
    i.fetchPriority !== 'high' &&
    !/logo|icon|sprite/i.test(i.src) &&
    idx > 0 // Skip first image — likely the hero/LCP element
  );
  if (noLazy.length > 4)
    push('Performance', 'high', `${noLazy.length} below-fold image(s) without lazy loading`,
      `${noLazy.length} images load immediately on page load without loading="lazy". First/hero image is excluded.`,
      builderFix(b,'image_lazy') || 'Enable lazy loading in your cache plugin or add loading="lazy" to below-fold images.');

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
    meta: { title: meta.title, desc: meta.desc, robots: meta.robots, lang: meta.lang, canonical: meta.canonical, generator: meta.generator, builder: b, wordCount: words, domElements: meta.domElements, htmlSizeKB: meta.htmlSizeKB, schemaTypes: checkSchemas(meta.jsonLd).map(s => s.type) },
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
    const baseOrigin = siteBaseUrl ? new URL(siteBaseUrl).origin : '';

    // ── SITE-LEVEL CHECKS (run once per batch, not per page) ──────────
    // These used to run inside auditPage() causing 8x timeout overhead.
    // Now they run once and results are passed to every page audit.
    const [wpSecurity, siteChecks] = await Promise.all([
      // WP security file checks — 4 HEAD requests, run once
      siteBaseUrl ? checkWPSecurity(baseOrigin) : Promise.resolve(null),
      // Homepage-only security checks
      (async () => {
        if (!baseOrigin) return {};
        const checks = {};
        try {
          // Check wp-admin accessibility
          const waR = await headReq(baseOrigin + '/wp-admin/');
          checks.wpAdminExposed = (waR.status === 200 || waR.status === 302);
        } catch { checks.wpAdminExposed = false; }
        try {
          // Check HTTP→HTTPS redirect (only on homepage URL)
          const firstUrl = urls[0] || '';
          if (firstUrl.startsWith('https://')) {
            const httpR = await headReq(firstUrl.replace('https://', 'http://'));
            checks.httpExposed = (httpR.status === 200);
          } else {
            checks.httpExposed = false;
          }
        } catch { checks.httpExposed = false; }
        return checks;
      })(),
    ]);

    // ── PAGE AUDITS (run in parallel, but with controlled network usage) ─
    const results = await Promise.all(batch.map(async (url) => {
      // FIX: wrap entire page audit in try/catch — never return undefined/null
      // FIX: removed 'pageResult' (undefined variable) — builder is detected inside auditPage via parseMeta()
      try {
        // Step 1: Fetch the page HTML
        const page = await fetchPage(url);
        if (!page.ok) {
          return {
            url, status: page.status || 0, ttfb: page.ttfb || 0,
            meta: { title: '', desc: '', robots: 'index,follow', wordCount: 0, domElements: 0, htmlSizeKB: 0, schemaTypes: [], builder: { id: 'custom', name: 'Unknown', icon: '⚙️' } },
            counts: {}, imageData: [], tracking: {}, devUrls: 0, dummyContent: 0, redirectChain: [],
            issues: [{
              category: 'Performance', severity: 'critical',
              title: `Page failed to load (${page.status || 'timeout'})`,
              detail: `URL: ${url} — ${page.error || 'No response from server'}`,
              fix: 'Check the URL is correct and the server is responding. Verify the site is accessible from external networks.',
              location: null
            }]
          };
        }

        const pageUrl = page.finalUrl || url;
        const parsedImages = parseImages(page.html);
        const parsedLinks  = parseLinks(page.html);

        // Step 2: Image + link checks — max 8 per page to avoid timeout
        const [imgData, brokenLinks] = await Promise.all([
          checkImages
            ? auditImageFiles(parsedImages, pageUrl, 8)
            : Promise.resolve([]),
          checkLinks
            ? checkBrokenLinks(parsedLinks, pageUrl, 8)
            : Promise.resolve([]),
        ]);

        // Step 3: Run all HTML-based checks (no network, instant)
        // NOTE: builder=null is correct — auditPage detects builder via parseMeta() internally
        return await auditPage(
          pageUrl, page.html, page.status, page.ttfb,
          page.headers, page.redirectChain,
          imgData, brokenLinks, wpSecurity,
          siteBaseUrl || url, siteChecks, null
        );

      } catch(e) {
        // Surface the real error message as a visible issue in the UI
        console.error('[audit-pages] Page error for', url, ':', e.message);
        return {
          url, status: 0, ttfb: 0,
          meta: { title: '', desc: '', robots: 'index,follow', wordCount: 0, domElements: 0, htmlSizeKB: 0, schemaTypes: [], builder: { id: 'custom', name: 'Unknown', icon: '⚙️' } },
          counts: {}, imageData: [], tracking: {}, devUrls: 0, dummyContent: 0, redirectChain: [],
          issues: [{
            category: 'Performance', severity: 'critical',
            title: `Audit exception: ${e.message}`,
            detail: `Page: ${url}\nError: ${e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : e.message}`,
            fix: 'This is a server-side audit error. Check Vercel function logs for the full stack trace.',
            location: null
          }]
        };
      }
    }));

    // Filter out any undefined/null results (extra safety)
    const validResults = results.filter(Boolean);
    return res.status(200).json({ success: true, results: validResults });

  } catch(e) {
    console.error('[audit-pages] Handler error:', e);
    return res.status(500).json({ error: e.message });
  }
}
