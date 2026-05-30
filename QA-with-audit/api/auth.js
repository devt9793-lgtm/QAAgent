// ============================================================
// Vercel Serverless Function — /api/auth
// PUBLIC blob store (qa-auth-blob)
// ============================================================
const { put, list } = require('@vercel/blob');
const crypto = require('crypto');

const BLOB_KEY  = 'users.json';
const TOKEN_TTL = 8 * 60 * 60 * 1000;
const SALT      = process.env.AUTH_SALT || 'qa_salt_v1_2026';

function hashPwd(p) { return crypto.createHash('sha256').update(p + SALT).digest('hex'); }
function mkToken()  { return crypto.randomBytes(32).toString('hex'); }

async function readUsers() {
  try {
    // List blobs to find users.json URL (works reliably with public store)
    const { blobs } = await list({ token: process.env.qaauth_READ_WRITE_TOKEN, prefix: BLOB_KEY });
    if (!blobs || blobs.length === 0) return [];
    // Fetch the latest blob by URL (public — no auth header needed)
    const url = blobs[0].downloadUrl || blobs[0].url;
    const r   = await fetch(url + '?t=' + Date.now()); // cache bust
    if (!r.ok) return [];
    return await r.json();
  } catch (e) {
    console.error('[readUsers]', e.message);
    return [];
  }
}

async function writeUsers(users) {
  await put(BLOB_KEY, JSON.stringify(users, null, 2), {
    access:           'public',
    contentType:      'application/json',
    addRandomSuffix:  false,
    token:            process.env.qaauth_READ_WRITE_TOKEN,
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-auth-token');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Debug — log token presence (never log the actual token)
  console.log('[auth] BLOB token present:', !!process.env.qaauth_READ_WRITE_TOKEN);

  const action = req.query.action || (req.body && req.body.action) || '';
  const body   = req.body || {};

  try {
    if (action === 'register') return await doRegister(body, res);
    if (action === 'login')    return await doLogin(body, res);
    if (action === 'verify')   return await doVerify(req, res);
    if (action === 'logout')   return await doLogout(req, body, res);
    if (action === 'list')     return await doList(req, res);
    if (action === 'ping')     return res.status(200).json({ ok: true, token: !!process.env.qaauth_READ_WRITE_TOKEN });
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (e) {
    console.error('[auth]', e);
    return res.status(500).json({ error: 'Server error: ' + e.message });
  }
};

async function doRegister({ name, email, password }, res) {
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email address' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const users   = await readUsers();
  const emailLC = email.toLowerCase().trim();
  if (users.find(u => u.email === emailLC))
    return res.status(409).json({ error: 'Email already registered' });

  const tok     = mkToken();
  const isFirst = users.length === 0;
  users.push({
    id:          crypto.randomUUID(),
    name:        name.trim(),
    email:       emailLC,
    password:    hashPwd(password),
    role:        isFirst ? 'admin' : 'member',
    createdAt:   new Date().toISOString(),
    lastLogin:   new Date().toISOString(),
    token:       tok,
    tokenExpiry: Date.now() + TOKEN_TTL,
    active:      true,
  });
  await writeUsers(users);
  return res.status(201).json({
    ok: true, token: tok,
    name: name.trim(), email: emailLC,
    role: isFirst ? 'admin' : 'member',
  });
}

async function doLogin({ email, password }, res) {
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required' });

  const users   = await readUsers();
  const emailLC = email.toLowerCase().trim();
  const idx     = users.findIndex(u => u.email === emailLC);

  if (idx === -1)         return res.status(401).json({ error: 'Email not found' });
  if (!users[idx].active) return res.status(403).json({ error: 'Account is deactivated' });
  if (users[idx].password !== hashPwd(password))
    return res.status(401).json({ error: 'Incorrect password' });

  users[idx].token       = mkToken();
  users[idx].tokenExpiry = Date.now() + TOKEN_TTL;
  users[idx].lastLogin   = new Date().toISOString();
  await writeUsers(users);

  return res.status(200).json({
    ok: true, token: users[idx].token,
    name: users[idx].name, email: emailLC,
    role: users[idx].role,
  });
}

async function doVerify(req, res) {
  const tok = req.headers['x-auth-token'] || req.query.token || '';
  if (!tok) return res.status(200).json({ valid: false });

  const users = await readUsers();
  const idx   = users.findIndex(u => u.token === tok);

  if (idx === -1)                          return res.status(200).json({ valid: false, reason: 'invalid' });
  if (Date.now() > users[idx].tokenExpiry) return res.status(200).json({ valid: false, reason: 'expired' });

  users[idx].tokenExpiry = Date.now() + TOKEN_TTL;
  await writeUsers(users);

  return res.status(200).json({
    valid: true,
    name:  users[idx].name,
    email: users[idx].email,
    role:  users[idx].role,
  });
}

async function doLogout(req, body, res) {
  const tok = req.headers['x-auth-token'] || body.token || '';
  if (!tok) return res.status(200).json({ ok: true });

  const users = await readUsers();
  const idx   = users.findIndex(u => u.token === tok);
  if (idx !== -1) {
    users[idx].token       = '';
    users[idx].tokenExpiry = 0;
    await writeUsers(users);
  }
  return res.status(200).json({ ok: true });
}

async function doList(req, res) {
  const tok    = req.headers['x-auth-token'] || req.query.token || '';
  const users  = await readUsers();
  const caller = users.find(u => u.token === tok && Date.now() < u.tokenExpiry);
  if (!caller || caller.role !== 'admin')
    return res.status(403).json({ error: 'Admin only' });

  return res.status(200).json({
    users: users.map(u => ({
      id: u.id, name: u.name, email: u.email,
      role: u.role, active: u.active,
      createdAt: u.createdAt, lastLogin: u.lastLogin,
    }))
  });
}
