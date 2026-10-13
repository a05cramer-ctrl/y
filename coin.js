// Coin resolve: GET ?q=<mint|$TICKER|TICKER> -> live coin data (Jupiter, cached 60s) + Y dev if proven.
// GET ?mints=a,b,c -> batch (used for trending/profile dev coins).
import { run, fail, cmd, parse, isPubkey, jupSearch, slimCoin, getUserRaw, publicUser } from './_lib.js';

async function resolve(q) {
  q = String(q || '').trim();
  const isMint = isPubkey(q);
  const sym = isMint ? '' : q.replace(/^\$/, '').toUpperCase();
  if (!isMint && !/^[A-Z0-9]{1,12}$/.test(sym)) fail(400, 'Unknown coin');
  const key = 'coin:' + (isMint ? q : '$' + sym);
  const hit = await cmd('GET', key);
  if (hit !== null) return parse(hit);
  const arr = await jupSearch(isMint ? q : sym);
  let pick = null;
  if (isMint) pick = arr.find(t => t.id === q) || null;
  else {
    const m = arr.filter(t => String(t.symbol || '').toUpperCase() === sym);
    m.sort((a, b) => (+b.liquidity || 0) - (+a.liquidity || 0) || (+b.mcap || 0) - (+a.mcap || 0));
    pick = m[0] || null;
  }
  const coin = slimCoin(pick);
  await cmd('SET', key, JSON.stringify(coin), 'EX', coin ? 60 : 30);
  if (coin && !isMint) await cmd('SET', 'coin:' + coin.mint, JSON.stringify(coin), 'EX', 60);
  return coin;
}

async function withDev(coin) {
  if (!coin) return null;
  const w = await cmd('GET', 'cdev:' + coin.mint);
  let yDev = null;
  if (w) { const u = await getUserRaw(w); if (u?.handle) yDev = publicUser(u); }
  return { ...coin, yDev };
}

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    if (ctx.method !== 'GET') fail(405, 'Method not allowed');
    const { q, mints } = ctx.query;
    if (mints) {
      const list = String(mints).split(',').filter(isPubkey).slice(0, 20);
      const out = {};
      for (const m of list) { try { const c = await resolve(m); if (c) out[m] = c; } catch {} }
      return { coins: out };
    }
    const coin = await withDev(await resolve(q));
    if (!coin) fail(404, 'Coin not found');
    return { coin };
  });
}


