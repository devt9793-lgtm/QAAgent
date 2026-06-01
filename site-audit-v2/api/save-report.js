// api/save-report.js
// Saves an audit report to Vercel Blob and returns a shareable ID

import { put } from '@vercel/blob';
import crypto from 'crypto';

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not set. Add it in Vercel → Project Settings → Environment Variables.' });

    const { report } = req.body || {};
    if (!report) return res.status(400).json({ error: 'No report data provided' });

    // Generate a unique 12-char ID
    const id = crypto.randomBytes(8).toString('hex').slice(0, 12);

    // Add metadata to the report
    const reportWithMeta = {
      ...report,
      _meta: {
        id,
        savedAt:  new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      },
    };

    // Store in Vercel Blob as public JSON
    const blob = await put(
      `audit-reports/${id}.json`,
      JSON.stringify(reportWithMeta),
      {
        access: 'public',
        token,
        contentType: 'application/json',
        addRandomSuffix: false,
      }
    );

    return res.status(200).json({
      success: true,
      id,
      blobUrl: blob.url,
    });

  } catch (e) {
    console.error('[save-report]', e);
    return res.status(500).json({ error: e.message });
  }
}
