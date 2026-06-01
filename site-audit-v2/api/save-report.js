import { put } from '@vercel/blob';
import crypto from 'crypto';
export const config = { maxDuration: 15 };
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') return res.status(200).end();
  if (req.method!=='POST') return res.status(405).json({error:'POST only'});
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({error:'BLOB_READ_WRITE_TOKEN not set in Vercel Environment Variables.'});
    const { report } = req.body||{};
    if (!report) return res.status(400).json({error:'No report'});
    const id = crypto.randomBytes(8).toString('hex').slice(0,12);
    const data = { ...report, _meta:{ id, savedAt: new Date().toISOString(), expiresAt: new Date(Date.now()+30*24*60*60*1000).toISOString() }};
    const blob = await put(`audit-reports/${id}.json`, JSON.stringify(data), { access:'public', token, contentType:'application/json', addRandomSuffix:false });
    return res.status(200).json({ success:true, id, blobUrl: blob.url });
  } catch(e) { return res.status(500).json({error:e.message}); }
}
