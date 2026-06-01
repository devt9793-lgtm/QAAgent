# Site Audit Agent v2 — with Shareable Reports

A full-site audit tool that checks SEO, Performance, Images, Accessibility, robots.txt, Sitemap and more.
After every audit you can generate a shareable link to send to your client or dev team.

---

## What it checks (40+ checks)

### SEO (13 checks)
- noindex/nofollow detection
- Title tag (missing, too short, too long)
- Meta description (missing, too short, too long)
- Canonical tag missing
- og:image (missing, oversized)
- og:title missing
- twitter:card missing
- Viewport meta missing
- lang attribute missing
- charset missing
- H1 (missing, multiple)
- Generic link text ("Learn more", "Click here")
- External links without nofollow

### Performance (14 checks)
- Slow TTFB (no caching)
- Missing browser cache headers
- Render-blocking CSS count
- Synchronous scripts in <head>
- Video embeds loading on page load
- 3+ third-party tracking scripts
- Dead Universal Analytics (UA-)
- Elementor css_print_method-external
- Elementor font_display-auto
- Missing hero image preload tag
- LCP (via PSI API — optional)
- TBT (via PSI API — optional)
- FCP (via PSI API — optional)
- CLS (via PSI API — optional)

### Images (7 checks per page)
- **File size in KB** (over 200KB = warning, over 500KB = critical)
- **WebP/AVIF detection** (non-modern format flagged)
- Total image weight on page
- Missing alt text
- Missing lazy loading
- Missing width/height attributes (CLS risk)
- Image count per page

### robots.txt (5 checks)
- File exists
- Blocking all crawlers
- Blocking Googlebot specifically
- Missing Sitemap directive
- Raw content preview

### Sitemap (5 checks)
- Sitemap found at standard locations
- URL count declared
- Missing lastmod dates
- Image sitemap present
- Oversized sitemap (>50,000 URLs)

### Accessibility (4 checks)
- Images missing alt text
- Iframes missing title attribute
- Heading levels skipped
- PSI Accessibility score below 80

### Security (2 checks)
- HTTP instead of HTTPS
- HTTP 400/500 status codes

---

## Deploy to Vercel

### Step 1 — Deploy
```bash
unzip site-audit-agent-v2.zip
cd site-audit-v2
npm install
npx vercel --prod
```

### Step 2 — Set environment variables for shareable reports

Go to your Vercel project → Settings → Environment Variables → Add:

```
BLOB_READ_WRITE_TOKEN = your_vercel_blob_token
```

**How to get the Vercel Blob token:**
1. Go to vercel.com → your project → Storage tab
2. Create a Blob store (free — 100MB included)
3. Copy the `BLOB_READ_WRITE_TOKEN` value
4. Paste it into Environment Variables
5. Redeploy (or wait for next deployment)

Without this token, audits still work — but the "Generate Share Link" button will show an error.

### Step 3 (Optional) — PSI API key for LCP/FCP/TBT metrics

1. Go to console.cloud.google.com
2. Create or select a project
3. Enable "PageSpeed Insights API"
4. Credentials → Create API Key
5. Paste the key into the PSI API Key field in the UI

---

## How sharing works

1. Run an audit on any site
2. Click **"🔗 Generate Share Link"** — saves the full report to Vercel Blob
3. A unique URL is generated: `https://your-app.vercel.app/?report=abc123def456`
4. Share that URL with your client or dev team
5. They see the full read-only report with all issues, filters, and CSV export
6. Reports expire after **30 days** automatically

---

## Run locally

```bash
npm install
npx vercel dev  # runs API routes locally at localhost:3000
```

For local testing without Vercel dev, the share feature requires `BLOB_READ_WRITE_TOKEN` in `.env.local`:
```
BLOB_READ_WRITE_TOKEN=your_token_here
```

---

## File structure

```
site-audit-v2/
├── index.html             Main UI (no login required)
├── api/
│   ├── audit.js           Crawl + audit engine (all 40+ checks)
│   ├── save-report.js     Save report to Vercel Blob → returns share ID
│   └── load-report.js     Load report from Vercel Blob by ID
├── package.json           @vercel/blob dependency
├── vercel.json            Function timeouts + routing
└── README.md
```
