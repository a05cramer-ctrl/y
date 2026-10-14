// Wallet sign-in: GET ?wallet= -> nonce + message; POST {wallet, signature} -> session token.
// GET ?action=me -> current session user.
import crypto from 'node:crypto';
import { run, fail, cmd, pipe, isPubkey, verifyEd25519, makeToken, getUserRaw, publicUser, isOfficial, OFFICIAL_HANDLE } from './_lib.js';

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
  if (taken && taken !== wallet) return existing;
  const u = {
    ...(existing || {}), wallet, handle: OFFICIAL_HANDLE, name: 'Y', bio: 'X locked your coin. Post it on Y. The timeline for memecoins.',
    avatar: '/y.png', banner: '/y-banner.jpg', website: '', joined: existing?.joined || Date.now(), devCoins: existing?.devCoins || [], verified: Date.now(),
  };
  await pipe([
    ['SET', 'h:' + OFFICIAL_HANDLE, wallet],
    ['SET', 'u:' + wallet, JSON.stringify(u)],
    ['ZADD', 'handles', 0, OFFICIAL_HANDLE],
    ['ZADD', 'z:followers', 0, wallet],
  ]);
  return u;
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
    if (isOfficial(wallet) && !(u && u.handle)) u = await createOfficial(wallet, u);
    return { token: makeToken(wallet), wallet, user: u && u.handle ? publicUser(u) : null };
  });
}
