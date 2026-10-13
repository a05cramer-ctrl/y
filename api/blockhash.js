// GET: proxies Helius getLatestBlockhash (cached 5s) so the client never needs the RPC key.
// POST ?action=send {tx: base64}: broadcasts a signed transaction, for wallets without signAndSendTransaction.
import { run, fail, rpc, cmd, parse } from './_lib.js';

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    if (ctx.method === 'POST' && ctx.query.action === 'send') {
      ctx.auth();
      const { tx } = await ctx.body();
      if (typeof tx !== 'string' || tx.length > 2000 || !/^[A-Za-z0-9+/=]+$/.test(tx)) fail(400, 'Invalid transaction');
      const sig = await rpc('sendTransaction', [tx, { encoding: 'base64', preflightCommitment: 'confirmed' }]);
      return { signature: sig };
    }
    if (ctx.method !== 'GET') fail(405, 'Method not allowed');
    const hit = parse(await cmd('GET', 'bh:latest'));
    if (hit) return hit;
    const r = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const v = r?.value || r;
    if (!v?.blockhash) fail(502, 'Could not get a recent blockhash');
    const out = { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight };
    await cmd('SET', 'bh:latest', JSON.stringify(out), 'EX', 5);
    return out;
  });
}
