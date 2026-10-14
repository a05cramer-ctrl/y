// Wallet sign-in: GET ?wallet= -> nonce + message; POST {wallet, signature} -> session token.
// GET ?action=me -> current session user.
import crypto from 'node:crypto';
import { run, fail, cmd, pipe, parse, isPubkey, verifyEd25519, makeToken, getUserRaw, publicUser, isOfficial, OFFICIAL_HANDLE } from './_lib.js';

function message(wallet, nonce, host) {
  return [
    `${host || 'Y'} wants you to sign in with your Solana wallet:`,
    wallet,
    '',
    'Sign in to Y. This does not send a transaction or cost any SOL.',
    '',
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString()}`,
  ].join('\n');
}

// First sign-in from the official wallet creates the @y account, verified.
async function createOfficial(wallet, existing) {
  const taken = await cmd('GET', 'h:' + OFFICIAL_HANDLE);
  // @y moved to a new official wallet: carry the whole account over (profile, posts, followers).
  if (taken && taken !== wallet) return (await transferAccount(taken, wallet)) || existing;
  const u = {
    ...(existing || {}), wallet, handle: OFFICIAL_HANDLE, name: 'Y', bio: 'X locked your coin. Post it on Y. The timeline for memecoins.',
    avatar: '/y.png', banner: '/y-banner.jpg', website: '', joined: existing?.joined || Date.now(), devCoins: existing?.devCoins || [], verified: Date.now(),
  };
  await pipe([
    ...(existing?.handle && existing.handle !== OFFICIAL_HANDLE ? [['DEL', 'h:' + existing.handle], ['ZREM', 'handles', existing.handle]] : []),
    ['SET', 'h:' + OFFICIAL_HANDLE, wallet],
    ['SET', 'u:' + wallet, JSON.stringify(u)],
    ['ZADD', 'handles', 0, OFFICIAL_HANDLE],
    ['ZADD', 'z:followers', 0, wallet],
  ]);
  return u;
}

// Move an account from one wallet to another: profile, handle, posts, replies, reposts, followers, following, notifications.
async function transferAccount(from, to) {
  if (!(await cmd('SET', 'xfer:' + from, to, 'NX', 'EX', 120))) return null;
  try {
    const old = parse(await cmd('GET', 'u:' + from));
    if (!old?.handle) return null;
    const [tlu, tlur, fol, fing, notifs, mine] = await pipe([
      ['ZRANGE', 'tl:u:' + from, 0, -1, 'WITHSCORES'], ['ZRANGE', 'tl:ur:' + from, 0, -1, 'WITHSCORES'],
      ['SMEMBERS', 'fs:' + from], ['SMEMBERS', 'f:' + from], ['LRANGE', 'n:' + from, 0, 199], ['GET', 'u:' + to],
    ]);
    const pairs = (a) => { const o = []; for (let i = 0; i < (a || []).length; i += 2) o.push([a[i], a[i + 1]]); return o; };
    const own = new Set([...pairs(tlu).filter(([m]) => m.startsWith('p:')).map(([m]) => m.slice(2)), ...pairs(tlur).map(([m]) => m)]);
    const reposts = pairs(tlu).filter(([m]) => m.startsWith('r:')).map(([m]) => m.slice(2));
    const posts = own.size ? await cmd('MGET', ...[...own].map(id => 'post:' + id)) : [];
    const c = [];
    [...own].forEach((id, i) => { const p = parse(posts[i]); if (p) c.push(['SET', 'post:' + id, JSON.stringify({ ...p, wallet: to })]); });
    for (const id of reposts) c.push(['SREM', 'rps:' + id, from], ['SADD', 'rps:' + id, to]);
    for (const [m, sc] of pairs(tlu)) c.push(['ZADD', 'tl:u:' + to, sc, m]);
    for (const [m, sc] of pairs(tlur)) c.push(['ZADD', 'tl:ur:' + to, sc, m]);
    for (const x of fol || []) if (x !== to) c.push(['SREM', 'f:' + x, from], ['SADD', 'f:' + x, to], ['SADD', 'fs:' + to, x]);
    for (const t of fing || []) if (t !== to) c.push(['SREM', 'fs:' + t, from], ['SADD', 'fs:' + t, to], ['SADD', 'f:' + to, t]);
    for (const n of (notifs || []).slice().reverse()) c.push(['LPUSH', 'n:' + to, n]);
    const prev = parse(mine);
    const u = { ...old, wallet: to, verified: old.verified || Date.now(), devCoins: [...(old.devCoins || []), ...(prev?.devCoins || [])] };
    if (prev?.handle && prev.handle !== old.handle) c.push(['DEL', 'h:' + prev.handle], ['ZREM', 'handles', prev.handle]);
    c.push(
      ['SET', 'u:' + to, JSON.stringify(u)], ['SET', 'h:' + old.handle, to],
      ['DEL', 'u:' + from, 'tl:u:' + from, 'tl:ur:' + from, 'fs:' + from, 'f:' + from, 'n:' + from, 'nseen:' + from],
      ['ZREM', 'z:followers', from], ['ZADD', 'z:followers', (fol || []).filter(x => x !== to).length, to], ['DEL', 'fy:cache'],
    );
    await pipe(c);
    return u;
  } finally { await cmd('DEL', 'xfer:' + from); }
}

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    if (ctx.method === 'GET' && ctx.query.action === 'me') {
      const w = ctx.auth();
      const u = await getUserRaw(w);
      return { wallet: w, user: u && u.handle ? publicUser(u) : null };
    }
    if (ctx.method === 'GET') {
      const wallet = String(ctx.query.wallet || '');
      if (!isPubkey(wallet)) fail(400, 'That is not a Solana wallet address');
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'local';
      const k = `rl:nonce:${ip}:${Math.floor(Date.now() / 60000)}`;
      const n = await cmd('INCR', k); if (n === 1) await cmd('EXPIRE', k, 70);
      if (n > 30) fail(429, 'Too many sign-in attempts. Wait a minute.');
      const nonce = crypto.randomBytes(16).toString('hex');
      const msg = message(wallet, nonce, String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0]);
      await cmd('SET', `nonce:${wallet}`, msg, 'EX', 300);
      return { nonce, message: msg };
    }
    if (ctx.method !== 'POST') fail(405, 'Method not allowed');
    const body = await ctx.body();
    const wallet = String(body.wallet || '');
    const sig = String(body.signature || '');
    if (!isPubkey(wallet)) fail(400, 'That is not a Solana wallet address');
    const msg = await cmd('GETDEL', `nonce:${wallet}`);
    if (!msg) fail(401, 'Sign-in request expired. Try again.');
    if (!verifyEd25519(wallet, msg, sig)) fail(401, 'Signature did not match this wallet');
    let u = await getUserRaw(wallet);
    if (isOfficial(wallet) && u?.handle !== OFFICIAL_HANDLE) u = await createOfficial(wallet, u);
    return { token: makeToken(wallet), wallet, user: u && u.handle ? publicUser(u) : null };
  });
}
