// Image upload to IPFS via Filebase. POST raw image bytes (Content-Type image/*) with a session.
// Send Content-Type application/octet-stream so Vercel hands us a Buffer. Returns {url}. Max 3MB, png/jpg/gif/webp checked by magic bytes.
import crypto from 'node:crypto';
import { run, fail, cmd, readRaw, IPFS_PREFIX, LOCAL_IMG_PREFIX } from './_lib.js';

const LOCAL_MAX = 700 * 1024; // images kept in the database when no IPFS token is set (client shrinks them first)

function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ['image/png', 'png'];
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (b.length > 6 && b.slice(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return ['image/gif', 'gif'];
  if (b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return ['image/webp', 'webp'];
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const id = String((req.query && req.query.id) || new URL(req.url, 'http://x').searchParams.get('id') || '');
    if (!/^[a-f0-9]{24}$/.test(id)) { res.statusCode = 404; return res.end('Not found'); }
    try {
      const v = await cmd('GET', 'img:' + id);
      if (!v) { res.statusCode = 404; return res.end('Not found'); }
      const [type, b64] = String(v).split(',', 2);
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.end(Buffer.from(b64, 'base64'));
    } catch { res.statusCode = 503; return res.end('Unavailable'); }
  }
  return run(req, res, async (ctx) => {
    if (ctx.method !== 'POST') fail(405, 'Method not allowed');
    const w = ctx.auth();
    const token = process.env.FILEBASE_IPFS_TOKEN;
    const k = `rl:up:${w}:${Math.floor(Date.now() / 3.6e6)}`;
    const n = await cmd('INCR', k); if (n === 1) await cmd('EXPIRE', k, 3700);
    if (n > 40) fail(429, 'Upload limit reached for this hour');
    const buf = await readRaw(req, 3 * 1024 * 1024 + 1);
    if (!buf.length) fail(400, 'No image received');
    if (buf.length > 3 * 1024 * 1024) fail(413, 'Images must be 3MB or smaller');
    const t = sniff(buf);
    if (!t) fail(415, 'Use a PNG, JPG, GIF or WEBP image');
    if (!token) {
      if (buf.length > LOCAL_MAX) fail(413, 'Image is too large. Try a smaller one.');
      const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
      await cmd('SET', 'img:' + id, t[0] + ',' + buf.toString('base64'));
      return { url: LOCAL_IMG_PREFIX + id };
    }
    const form = new FormData();
    form.append('file', new Blob([buf], { type: t[0] }), `y.${t[1]}`);
    const r = await fetch('https://rpc.filebase.io/api/v0/add?cid-version=1', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt.trim().split('\n').pop()); } catch {}
    if (!r.ok || !j?.Hash) fail(502, 'Image host rejected the upload. Try again.');
    return { url: IPFS_PREFIX + j.Hash, cid: j.Hash };
  });
}
