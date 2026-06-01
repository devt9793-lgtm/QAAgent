import { list } from '@vercel/blob';
export const config = { maxDuration: 10 };
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.method!=='GET') return res.status(405).json({error:'GET only'});
  try {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(500).json({error:'BLOB_READ_WRITE_TOKEN not configured.'});
    const id = (req.query.id||'').trim().slice(0,24);
    if (!id||!/^[a-f0-9]+$/.test(id)) return res.status(400).json({error:'Invalid report ID'});
    const {blobs} = await list({prefix:`audit-reports/${id}`,token});
    if (!blobs||!blobs.length) return res.status(404).json({error:'Report not found or expired.'});
    const r = await fetch(blobs[0].downloadUrl||blobs[0].url);
    if (!r.ok) return res.status(404).json({error:'Could not load report data.'});
    const report = await r.json();
    if (report._meta?.expiresAt && new Date(report._meta.expiresAt)<new Date())
      return res.status(410).json({error:'Report expired (kept 30 days).'});
    return res.status(200).json({success:true,report});
  } catch(e) { return res.status(500).json({error:e.message}); }
}
