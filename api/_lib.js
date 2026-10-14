// Shared helpers for Y serverless functions. Underscore prefix: not a route on Vercel.
// Zero npm dependencies: Node 20 built-ins + global fetch only.
import crypto from 'node:crypto';

/* ---------------- errors / http ---------------- */
export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export function send(res, status, obj) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export function getQuery(req) {
  const u = new URL(req.url || '/', 'http://x');
  const q = {};
  for (const [k, v] of u.searchParams) q[k] = v;
  return q;
}

function bodyOf(req) {
  // Vercel exposes a lazily parsed req.body that throws on malformed JSON
  try { return req.body; } catch { fail(400, 'Invalid request body'); }
}

export async function readRaw(req, limit = 4 * 1024 * 1024) {
  const b = bodyOf(req);
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b);
  if (b && typeof b === 'object') fail(415, 'Send the file as raw bytes');
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) fail(413, 'Upload too large');
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

export async function readJson(req) {
  const b = bodyOf(req);
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  let s;
  if (typeof b === 'string') s = b;
  else if (Buffer.isBuffer(b)) s = b.toString('utf8');
  else s = (await readRaw(req, 256 * 1024)).toString('utf8');
  if (!s) return {};
  try { const j = JSON.parse(s); return j && typeof j === 'object' ? j : {}; } catch { fail(400, 'Invalid JSON body'); }
}

// Wraps a route: parses query, viewer session, catches errors into JSON.
const EDGE_TTL = { coin: 30, posts: 5, users: 15, verify: 60 };
function edgeTtl(req) {
  const m = /^\/(?:api\/)?([a-z]+)/.exec(String(req.url || ''));
  return (m && EDGE_TTL[m[1]]) || 0;
}
export async function run(req, res, fn) {
  try {
    const query = getQuery(req);
    const viewer = viewerFromReq(req);
    const ctx = {
      req, res, query, viewer, method: (req.method || 'GET').toUpperCase(),
      body: () => readJson(req),
      auth: () => { if (!viewer) fail(401, 'Sign in with your wallet first'); return viewer; },
    };
    const out = await fn(ctx);
    if (out !== undefined) {
      // Anonymous public reads are cached at Vercel's edge, so floods hit the CDN, not the database.
      const ttl = ctx.method === 'GET' && !viewer && !(req.headers?.authorization) ? edgeTtl(req) : 0;
      if (ttl) res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 6}`);
      send(res, 200, out);
    }
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: 'Something broke on our side. Try again.' });
  }
}

/* ---------------- base58 ---------------- */
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const AMAP = Object.fromEntries([...ALPH].map((c, i) => [c, i]));
export function b58encode(bytes) {
  bytes = Uint8Array.from(bytes);
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map(d => ALPH[d]).join('');
}
export function b58decode(str) {
  str = String(str || '');
  let zeros = 0; while (zeros < str.length && str[zeros] === '1') zeros++;
  const bytes = [];
  for (let i = zeros; i < str.length; i++) {
    const v = AMAP[str[i]]; if (v === undefined) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}
export const isPubkey = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && b58decode(s)?.length === 32;

/* ---------------- ed25519 ---------------- */
export function verifyEd25519(walletB58, message, sigB58) {
  try {
    const pk = b58decode(walletB58); const sig = b58decode(sigB58);
    if (!pk || pk.length !== 32 || !sig || sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pk).toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig));
  } catch { return false; }
}

/* ---------------- sessions ---------------- */
function secret() {
  // SESSION_SECRET if set; otherwise derived from the database token, which is already server-only.
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  const c = redisCfg();
  if (!c) fail(503, 'Server is missing its database (UPSTASH_REDIS_REST_URL)');
  return crypto.createHmac('sha256', c.token).update('y-session-v1').digest('base64url');
}
const hmac = (p) => crypto.createHmac('sha256', secret()).update(p).digest('base64url');
export function makeToken(wallet) {
  const p = Buffer.from(JSON.stringify({ w: wallet, exp: Date.now() + 30 * 864e5 })).toString('base64url');
  return p + '.' + hmac(p);
}
export function readToken(t) {
  if (!t || typeof t !== 'string' || !(process.env.SESSION_SECRET || redisCfg())) return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const a = Buffer.from(hmac(p)); const b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!j.w || !isPubkey(j.w) || !(j.exp > Date.now())) return null;
    return j.w;
  } catch { return null; }
}
function viewerFromReq(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? readToken(m[1].trim()) : null;
}

/* ---------------- redis (Upstash REST) ---------------- */
function redisCfg() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}
export const hasRedis = () => !!redisCfg();
// Every key gets a prefix so Y can share a database with other projects safely.
const KP = process.env.KEY_PREFIX ?? 'y:';
const MULTI = new Set(['MGET', 'DEL', 'EXISTS', 'UNLINK']);
function nsArgs(args) {
  const a = args.map(String);
  if (!KP || a.length < 2) return a;
  const c = a[0].toUpperCase();
  if (MULTI.has(c)) return [a[0], ...a.slice(1).map(k => KP + k)];
  a[1] = KP + a[1];
  return a;
}
export async function cmd(...args) {
  const c = redisCfg(); if (!c) fail(503, 'Server is missing its database (UPSTASH_REDIS_REST_URL)');
  const r = await fetch(c.url, { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(nsArgs(args)) });
  const j = await r.json().catch(() => ({ error: 'bad redis response ' + r.status }));
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}
export async function pipe(cmds) {
  cmds = cmds.filter(Boolean);
  if (!cmds.length) return [];
  const c = redisCfg(); if (!c) fail(503, 'Server is missing its database (UPSTASH_REDIS_REST_URL)');
  const out = [];
  for (let i = 0; i < cmds.length; i += 800) {
    const chunk = cmds.slice(i, i + 800);
    const r = await fetch(c.url + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chunk.map(nsArgs)) });
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j)) throw new Error('redis pipeline failed ' + r.status);
    for (const x of j) out.push(x && 'result' in x ? x.result : null);
  }
  return out;
}
export const hashObj = (arr) => {
  if (!arr) return {};
  if (!Array.isArray(arr)) return arr;
  const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o;
};
export const parse = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

/* ---------------- users ---------------- */
export const RESERVED = new Set(['newpairs', 'y', 'admin', 'support', 'dev', 'official', 'team']);
// The official @y account belongs to this wallet (OFFICIAL_WALLET, else TREASURY).
export const OFFICIAL = () => { const w = process.env.OFFICIAL_WALLET || process.env.TREASURY || ''; return isPubkey(w) ? w : ''; };
export const isOfficial = (w) => !!w && w === OFFICIAL();
export const OFFICIAL_HANDLE = 'y';
// Site-hosted images the official account may use.
const SITE_IMGS = new Set(['/y.png', '/og.jpg', '/y-mark.png', '/y-banner.jpg']);
export function publicUser(u) {
  if (!u) return null;
  return {
    wallet: u.wallet, handle: u.handle, name: u.name || u.handle, bio: u.bio || '',
    avatar: u.avatar || '', banner: u.banner || '', joined: u.joined || 0,
    verified: !!u.verified || isOfficial(u.wallet), verifiedAt: u.verified || 0, devCoins: Array.isArray(u.devCoins) ? u.devCoins : [],
    official: isOfficial(u.wallet),
  };
}
export async function getUserRaw(wallet) { return parse(await cmd('GET', 'u:' + wallet)); }
export async function getUsersRaw(wallets) {
  const uniq = [...new Set(wallets.filter(Boolean))];
  if (!uniq.length) return {};
  const vals = await cmd('MGET', ...uniq.map(w => 'u:' + w));
  const m = {}; uniq.forEach((w, i) => { const u = parse(vals[i]); if (u) m[w] = u; });
  return m;
}
export async function requireProfile(wallet) {
  const u = await getUserRaw(wallet);
  if (!u || !u.handle) fail(403, 'Finish setting up your profile first');
  return u;
}

/* ---------------- notifications ---------------- */
export async function notify(to, type, from, postId) {
  if (!to || to === from) return;
  if (type === 'like' || type === 'repost' || type === 'follow') {
    const ok = await cmd('SET', `nd:${type}:${from}:${to}:${postId || ''}`, '1', 'NX', 'EX', 86400);
    if (!ok) return;
  }
  await pipe([
    ['LPUSH', 'n:' + to, JSON.stringify({ type, from, post: postId || null, ts: Date.now() })],
    ['LTRIM', 'n:' + to, 0, 199],
  ]);
}

/* ---------------- posts ---------------- */
export const MINT_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
export const TICKER_RE = /(?<![\w$])\$([A-Za-z][A-Za-z0-9]{0,11})(?![\w])/g;
export const MENTION_RE = /(?<![\w@])@([A-Za-z0-9_]{3,15})(?![\w])/g;
export function extract(text) {
  const mints = [...new Set([...text.matchAll(MINT_RE)].map(m => m[0]).filter(isPubkey))].slice(0, 5);
  const tickers = [...new Set([...text.matchAll(TICKER_RE)].map(m => m[1].toUpperCase()))].slice(0, 5);
  const mentions = [...new Set([...text.matchAll(MENTION_RE)].map(m => m[1].toLowerCase()))].slice(0, 10);
  return { mints, tickers, mentions };
}

// entries: [{id, by?: wallet (reposter), ts?}] -> hydrated posts, missing ones dropped
export async function hydrate(entries, viewer) {
  if (!entries.length) return [];
  const ids = [...new Set(entries.map(e => e.id))];
  const res = await pipe(ids.flatMap(id => [['GET', 'post:' + id], ['HGETALL', 'pc:' + id]]));
  const posts = {};
  ids.forEach((id, i) => {
    const p = parse(res[i * 2]); if (!p) return;
    const c = hashObj(res[i * 2 + 1]);
    p.likes = Math.max(0, +c.likes || 0); p.reposts = Math.max(0, +c.reposts || 0); p.replies = Math.max(0, +c.replies || 0);
    posts[id] = p;
  });
  const parentIds = [...new Set(Object.values(posts).map(p => p.replyTo).filter(Boolean))];
  const parents = {};
  if (parentIds.length) {
    const pv = await cmd('MGET', ...parentIds.map(id => 'post:' + id));
    parentIds.forEach((id, i) => { const p = parse(pv[i]); if (p) parents[id] = p; });
  }
  const wallets = [...Object.values(posts).map(p => p.wallet), ...Object.values(parents).map(p => p.wallet), ...entries.map(e => e.by)];
  const users = await getUsersRaw(wallets);
  let flags = [];
  const live = ids.filter(id => posts[id]);
  if (viewer && live.length) flags = await pipe(live.flatMap(id => [['SISMEMBER', 'likes:' + id, viewer], ['SISMEMBER', 'rps:' + id, viewer]]));
  const vf = {}; live.forEach((id, i) => { vf[id] = { liked: !!flags[i * 2], reposted: !!flags[i * 2 + 1] }; });
  const out = [];
  for (const e of entries) {
    const p = posts[e.id]; if (!p) continue;
    const author = publicUser(users[p.wallet]); if (!author) continue;
    const parent = p.replyTo ? parents[p.replyTo] : null;
    const pu = parent ? users[parent.wallet] : null;
    out.push({
      id: p.id, text: p.text, image: p.image || '', ts: p.ts, replyTo: p.replyTo || null,
      replyToHandle: pu ? pu.handle : null, mints: p.mints || [], tickers: p.tickers || [],
      likes: p.likes, reposts: p.reposts, replies: p.replies,
      liked: !!vf[p.id]?.liked, reposted: !!vf[p.id]?.reposted, author,
      repostedBy: e.by && users[e.by] ? { wallet: e.by, handle: users[e.by].handle, name: users[e.by].name } : null,
      sortTs: e.ts || p.ts,
    });
  }
  return out;
}

/* ---------------- solana / helius ---------------- */
export const LAMPORTS = 1_000_000_000;
export async function rpc(method, params) {
  // Helius when a key is set; the public Solana RPC otherwise (slower, rate limited, but works).
  const key = process.env.HELIUS_API_KEY;
  const urls = key ? ['https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(key)]
    : [process.env.SOLANA_RPC_URL, 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
  let last = 'Solana RPC unreachable';
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const j = await r.json().catch(() => null);
      if (!j) { last = 'Solana RPC unreachable'; continue; }
      if (j.error) {
        last = 'Solana RPC: ' + (j.error.message || 'error');
        // Rate limit / access errors: try the next RPC. Real request errors: stop.
        if ([403, 429, -32005, -32052].includes(+j.error.code) || r.status >= 500 || r.status === 403 || r.status === 429) continue;
        fail(502, last);
      }
      return j.result;
    } catch (e) { if (e instanceof HttpError) throw e; last = 'Solana RPC unreachable'; }
  }
  fail(502, last);
}
export const MIN_POST_LAMPORTS = 10_000_000; // 0.01 SOL
export async function solBalance(wallet) {
  const cached = await cmd('GET', 'bal:' + wallet);
  if (cached !== null) return +cached;
  const r = await rpc('getBalance', [wallet, { commitment: 'confirmed' }]);
  const lamports = +(r?.value ?? r ?? 0);
  await cmd('SET', 'bal:' + wallet, lamports, 'EX', lamports >= MIN_POST_LAMPORTS ? 600 : 15);
  return lamports;
}
export async function hasMinSol(wallet) { return (await solBalance(wallet)) >= MIN_POST_LAMPORTS; }

/* ---------------- jupiter ---------------- */
export async function jupSearch(q) {
  const r = await fetch('https://lite-api.jup.ag/tokens/v2/search?query=' + encodeURIComponent(q), { headers: { accept: 'application/json' } });
  if (!r.ok) fail(502, 'Token data unavailable right now');
  const j = await r.json().catch(() => []);
  return Array.isArray(j) ? j : [];
}
export function slimCoin(t) {
  if (!t) return null;
  return {
    mint: t.id, name: t.name || '', symbol: t.symbol || '', icon: t.icon || '', decimals: t.decimals,
    price: t.usdPrice ?? null, mcap: t.mcap ?? t.fdv ?? null, fdv: t.fdv ?? null, liquidity: t.liquidity ?? null,
    change24h: t.stats24h?.priceChange ?? null, change1h: t.stats1h?.priceChange ?? null,
    volume24h: t.stats24h ? (+(t.stats24h.buyVolume || 0) + +(t.stats24h.sellVolume || 0)) || null : null,
    holders: t.holderCount ?? null, launchpad: t.launchpad || '', dev: t.dev || '', createdAt: t.createdAt || null,
    twitter: t.twitter || '', website: t.website || '', graduated: !!t.graduatedAt,
  };
}

export const IPFS_PREFIX = 'https://ipfs.filebase.io/ipfs/';
export const LOCAL_IMG_PREFIX = '/api/upload?id=';
export const okImageUrl = (u) => !u || (typeof u === 'string' && u.length < 200 && (SITE_IMGS.has(u) ||
  (u.startsWith(IPFS_PREFIX) && /^[A-Za-z0-9]+$/.test(u.slice(IPFS_PREFIX.length))) ||
  (u.startsWith(LOCAL_IMG_PREFIX) && /^[a-f0-9]{24}$/.test(u.slice(LOCAL_IMG_PREFIX.length)))));
