// Gold check: POST {signature} -> confirm a SystemProgram transfer of >= CHECK_SOL from the session wallet to TREASURY.
// GET -> {treasury, lamports} so the client knows what to pay.
import { run, fail, cmd, pipe, LAMPORTS, rpc, requireProfile, publicUser, isPubkey } from './_lib.js';

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const price = () => Math.round((+process.env.CHECK_SOL || 0.01) * LAMPORTS);
const treasury = () => { const t = process.env.TREASURY || ''; return isPubkey(t) ? t : ''; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchTx(sig) {
  for (let i = 0; i < 12; i++) {
    const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (tx) return tx;
    await sleep(i < 4 ? 1500 : 2500);
  }
  return null;
}

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    if (ctx.method === 'GET') return { treasury: treasury(), lamports: price() };
    if (ctx.method !== 'POST') fail(405, 'Method not allowed');
    const w = ctx.auth();
    const u = await requireProfile(w);
    if (u.verified) return { user: publicUser(u), already: true };
    const T = treasury();
    if (!T) fail(503, 'Treasury not set');
    const { signature } = await ctx.body();
    const sig = String(signature || '');
    if (!SIG_RE.test(sig)) fail(400, 'Missing transaction signature');
    const used = await cmd('GET', 'vsig:' + sig);
    if (used && used !== w) fail(409, 'This payment was already used');

    const tx = await fetchTx(sig);
    if (!tx) fail(408, "Payment not confirmed yet. Keep this page open and press 'Check payment' in a few seconds.", { retry: true });
    if (tx.meta?.err) fail(400, 'That transaction failed on-chain');
    const keys = tx.transaction?.message?.accountKeys || [];
    const signers = keys.filter(k => k.signer).map(k => k.pubkey);
    if (!signers.includes(w)) fail(403, 'That payment was signed by a different wallet');
    const ixs = [
      ...(tx.transaction?.message?.instructions || []),
      ...((tx.meta?.innerInstructions || []).flatMap(x => x.instructions || [])),
    ];
    let paid = 0;
    for (const ix of ixs) {
      if (ix.program !== 'system' || !ix.parsed) continue;
      const { type, info } = ix.parsed;
      if ((type === 'transfer' || type === 'transferWithSeed') && info?.destination === T && info?.source === w) paid += +info.lamports || 0;
    }
    if (paid < price()) fail(402, `Payment too small: needs ${price() / LAMPORTS} SOL to the treasury`);
    const claimed = await cmd('SET', 'vsig:' + sig, w, 'NX');
    if (!claimed && (await cmd('GET', 'vsig:' + sig)) !== w) fail(409, 'This payment was already used');
    u.verified = Date.now();
    const recent = await cmd('ZREVRANGEBYSCORE', 'tl:u:' + w, '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, 200);
    const c = [['SET', 'u:' + w, JSON.stringify(u)], ['DEL', 'fy:cache']];
    for (let i = 0; i < recent.length; i += 2) if (recent[i].startsWith('p:')) c.push(['ZADD', 'tl:v', recent[i + 1], recent[i].slice(2)]);
    await pipe(c);
    return { user: publicUser(u) };
  });
}
