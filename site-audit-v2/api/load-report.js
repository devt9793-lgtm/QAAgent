// api/load-report.js
// Fetches a previously saved audit report from Vercel Blob

import { list } from '@vercel/blob';

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set.' });

    const id = (req.query.id || '').trim().slice(0, 24);
    if (!id || !/^[a-f0-9]+$/.test(id)) {
      return res.status(400).json({ error: 'Invalid report ID' });
    }

    // Find blob by prefix
    const { blobs } = await list({
      prefix: `audit-reports/${id}`,
      token,
    });

    if (!blobs || blobs.length === 0) {
      return res.status(404).json({ error: 'Report not found. It may have expired or the ID is incorrect.' });
    }

    // Fetch the actual JSON from the blob URL
    const blobUrl = blobs[0].downloadUrl || blobs[0].url;
    const r = await fetch(blobUrl + '?t=' + Date.now());
    if (!r.ok) return res.status(404).json({ error: 'Could not load report data.' });

    const report = await r.json();

    // Check expiry
    if (report._meta?.expiresAt && new Date(report._meta.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'This report has expired (reports are kept for 30 days).' });
    }

    return res.status(200).json({ success: true, report });

  } catch (e) {
    console.error('[load-report]', e);
    return res.status(500).json({ error: e.message });
  }
}
