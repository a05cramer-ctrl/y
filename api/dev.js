// DEV proof: POST {mint} -> checks the session wallet created the coin (Jupiter `dev`, fallback: first tx fee payer).
// POST ?action=remove {mint} -> drop a coin from your profile.
import { run, fail, cmd, pipe, isPubkey, jupSearch, slimCoin, rpc, requireProfile, publicUser } from './_lib.js';

async function creatorOf(mint) {
  let token = null;
  try { token = (await jupSearch(mint)).find(t => t.id === mint) || null; } catch {}
  if (token?.dev) return { dev: token.dev, token, via: 'jupiter' };
  // Fallback: walk signatures back to the oldest, fee payer of the first tx is the deployer.
  let before; let oldest = null;
  for (let i = 0; i < 10; i++) {
    const sigs = await rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!Array.isArray(sigs) || !sigs.length) break;
    oldest = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) { before = null; break; }
    before = oldest;
  }
  if (before) fail(422, 'This coin has too much history to trace its creator. Try again later.');
  if (!oldest) return { dev: null, token, via: 'none' };
  const tx = await rpc('getTransaction', [oldest, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  const keys = tx?.transaction?.message?.accountKeys || [];
  const payer = keys.find(k => k.signer)?.pubkey || keys[0]?.pubkey || keys[0] || null;
  return { dev: typeof payer === 'string' ? payer : null, token, via: 'chain' };
}

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    if (ctx.method !== 'POST') fail(405, 'Method not allowed');
    const w = ctx.auth();
    const u = await requireProfile(w);
    const { mint: m } = await ctx.body();
    const mint = String(m || '').trim();
    if (!isPubkey(mint)) fail(400, 'Paste the coin\'s contract address (mint)');
    const coins = Array.isArray(u.devCoins) ? u.devCoins : [];

    if (ctx.query.action === 'remove') {
      u.devCoins = coins.filter(c => c.mint !== mint);
      const owner = await cmd('GET', 'cdev:' + mint);
      await pipe([['SET', 'u:' + w, JSON.stringify(u)], owner === w ? ['DEL', 'cdev:' + mint] : null]);
      return { user: publicUser(u) };
    }

    const k = `rl:dev:${w}:${Math.floor(Date.now() / 3.6e6)}`;
    const n = await cmd('INCR', k); if (n === 1) await cmd('EXPIRE', k, 3700);
    if (n > 20) fail(429, 'Too many attempts this hour');

    const { dev, token } = await creatorOf(mint);
    if (!dev) fail(404, "Couldn't find who created this coin");
    if (dev !== w) fail(403, 'This coin was deployed by a different wallet (' + dev.slice(0, 4) + '…' + dev.slice(-4) + ')');
    const c = slimCoin(token);
    const entry = { mint, symbol: c?.symbol || '', name: c?.name || '', icon: c?.icon || '', at: Date.now() };
    u.devCoins = [entry, ...coins.filter(x => x.mint !== mint)].slice(0, 50);
    await pipe([['SET', 'u:' + w, JSON.stringify(u)], ['SET', 'cdev:' + mint, w]]);
    return { user: publicUser(u), coin: entry };
  });
}
