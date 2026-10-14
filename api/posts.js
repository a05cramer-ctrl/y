// Posts: feeds (GET) and create / like / repost / delete (POST ?action=)
import crypto from 'node:crypto';
import {
  run, fail, cmd, pipe, parse, hydrate, extract, requireProfile, notify, hasMinSol, solBalance, MIN_POST_LAMPORTS, isOfficial, okImageUrl, isPubkey,
} from './_lib.js';

const PAGE = 30;
const len = (s) => [...s].length;

function pairs(flat) { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], +flat[i + 1]]); return out; }
const maxScore = (before) => (before && isFinite(+before) ? '(' + +before : '+inf');

async function zpage(key, before, n = PAGE) {
  return pairs(await cmd('ZREVRANGEBYSCORE', key, maxScore(before), '-inf', 'WITHSCORES', 'LIMIT', 0, n));
}

async function forYou(viewer, offset) {
  let ranked = parse(await cmd('GET', 'fy:cache'));
  if (!ranked) {
    const ids = await cmd('ZREVRANGE', 'tl:all', 0, 499);
    if (!ids.length) return { posts: [], next: null };
    const res = await pipe(ids.flatMap(id => [['GET', 'post:' + id], ['HGETALL', 'pc:' + id]]));
    const rows = [];
    ids.forEach((id, i) => {
      const p = parse(res[i * 2]); if (!p) return;
      const c = res[i * 2 + 1] || []; const h = {}; for (let k = 0; k < c.length; k += 2) h[c[k]] = +c[k + 1] || 0;
      rows.push({ id, wallet: p.wallet, ts: p.ts, likes: h.likes || 0, reposts: h.reposts || 0, replies: h.replies || 0 });
    });
    const wallets = [...new Set(rows.map(r => r.wallet))];
    const users = wallets.length ? await cmd('MGET', ...wallets.map(w => 'u:' + w)) : [];
    const ver = {}; wallets.forEach((w, i) => { const u = parse(users[i]); ver[w] = !!u?.verified; });
    const now = Date.now();
    ranked = rows.map(r => {
      const age = Math.max(0, (now - r.ts) / 3.6e6);
      const s = (Math.max(0, r.likes) + 2 * Math.max(0, r.reposts) + 1.5 * Math.max(0, r.replies) + 1) * (ver[r.wallet] ? 2 : 1) / Math.pow(age + 2, 1.5);
      return [r.id, s];
    }).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    await cmd('SET', 'fy:cache', JSON.stringify(ranked), 'EX', 20);
  }
  const off = Math.max(0, parseInt(offset) || 0);
  const slice = ranked.slice(off, off + PAGE);
  const posts = await hydrate(slice.map(id => ({ id })), viewer);
  return { posts, next: off + PAGE < ranked.length ? String(off + PAGE) : null };
}

async function zFeed(key, viewer, before) {
  const list = await zpage(key, before);
  const posts = await hydrate(list.map(([id, ts]) => ({ id, ts })), viewer);
  return { posts, next: list.length >= PAGE ? String(list[list.length - 1][1]) : null };
}

// Profile timeline: members are "p:<id>" (own post) or "r:<id>" (repost)
async function userTimeline(key, owner, viewer, before) {
  const list = await zpage(key, before);
  const entries = list.map(([m, ts]) => (m.startsWith('r:') ? { id: m.slice(2), by: owner, ts } : { id: m.slice(2), ts }));
  const posts = await hydrate(entries, viewer);
  return { posts, next: list.length >= PAGE ? String(list[list.length - 1][1]) : null };
}

async function following(viewer, before) {
  if (!viewer) fail(401, 'Sign in to see who you follow');
  let wallets = await cmd('SMEMBERS', 'f:' + viewer);
  wallets = [viewer, ...wallets.slice(0, 400)];
  const res = await pipe(wallets.map(w => ['ZREVRANGEBYSCORE', 'tl:u:' + w, maxScore(before), '-inf', 'WITHSCORES', 'LIMIT', 0, PAGE]));
  let all = [];
  wallets.forEach((w, i) => { for (const [m, ts] of pairs(res[i])) all.push(m.startsWith('r:') ? { id: m.slice(2), by: w, ts } : { id: m.slice(2), ts }); });
  all.sort((a, b) => b.ts - a.ts);
  const seen = new Set(); const pick = [];
  for (const e of all) { if (seen.has(e.id)) continue; seen.add(e.id); pick.push(e); if (pick.length >= PAGE) break; }
  const posts = await hydrate(pick, viewer);
  const last = pick[pick.length - 1];
  return { posts, next: all.length >= PAGE && last ? String(last.ts) : null };
}

async function mergedFeed(keys, viewer, before) {
  const res = await pipe(keys.map(k => ['ZREVRANGEBYSCORE', k, maxScore(before), '-inf', 'WITHSCORES', 'LIMIT', 0, PAGE]));
  const m = new Map();
  res.forEach(r => pairs(r).forEach(([id, ts]) => m.set(id, ts)));
  const list = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, PAGE);
  const posts = await hydrate(list.map(([id, ts]) => ({ id, ts })), viewer);
  return { posts, next: list.length >= PAGE ? String(list[list.length - 1][1]) : null };
}

async function search(q, viewer, before) {
  q = String(q || '').trim().slice(0, 64);
  if (!q) return { posts: [], next: null };
  if (isPubkey(q)) return zFeed('tl:m:' + q, viewer, before);
  const tk = /^\$?([A-Za-z][A-Za-z0-9]{0,11})$/.exec(q);
  if (q.startsWith('$') && tk) return zFeed('tl:t:' + tk[1].toUpperCase(), viewer, before);
  // Plain text: scan the latest 500 posts
  const ids = await cmd('ZREVRANGE', 'tl:all', 0, 499);
  const vals = ids.length ? await cmd('MGET', ...ids.map(id => 'post:' + id)) : [];
  const needle = q.toLowerCase();
  const hits = [];
  ids.forEach((id, i) => { const p = parse(vals[i]); if (p && p.text.toLowerCase().includes(needle)) hits.push({ id, ts: p.ts }); });
  let list = hits;
  if (tk) { const t = await zpage('tl:t:' + tk[1].toUpperCase(), null, 50); for (const [id, ts] of t) if (!list.find(x => x.id === id)) list.push({ id, ts }); }
  list = list.sort((a, b) => b.ts - a.ts).filter(x => !before || x.ts < +before).slice(0, PAGE);
  const posts = await hydrate(list, viewer);
  return { posts, next: null };
}

async function thread(id, viewer) {
  const main = (await hydrate([{ id }], viewer))[0];
  if (!main) fail(404, 'This post was deleted or never existed');
  const ancestors = [];
  let cur = main.replyTo; let guard = 0;
  while (cur && guard++ < 6) {
    const p = (await hydrate([{ id: cur }], viewer))[0];
    if (!p) { ancestors.unshift({ deleted: true, id: cur }); break; }
    ancestors.unshift(p); cur = p.replyTo;
  }
  const rids = await cmd('ZRANGE', 'replies:' + id, 0, 199);
  const replies = await hydrate(rids.map(r => ({ id: r })), viewer);
  replies.sort((a, b) => (b.likes + b.replies) - (a.likes + a.replies) || a.ts - b.ts);
  return { post: main, ancestors, replies };
}

async function create(viewer, body) {
  const user = await requireProfile(viewer);
  const text = String(body.text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const image = body.image ? String(body.image) : '';
  if (!text && !image) fail(400, 'Write something first');
  if (len(text) > 280) fail(400, 'Posts are limited to 280 characters');
  if (!okImageUrl(image)) fail(400, 'Image must be uploaded through Y');
  let parent = null;
  if (body.replyTo) {
    parent = parse(await cmd('GET', 'post:' + String(body.replyTo)));
    if (!parent) fail(404, 'The post you replied to was deleted');
  }
  const hour = Math.floor(Date.now() / 3.6e6);
  const n = await cmd('INCR', `rl:post:${viewer}:${hour}`);
  if (n === 1) await cmd('EXPIRE', `rl:post:${viewer}:${hour}`, 3700);
  if (n > 30) fail(429, 'Slow down: 30 posts per hour max. Try again later.');
  // Gold-check and official accounts already proved they're real; everyone else needs 0.01 SOL in the wallet.
  if (!user.verified && !isOfficial(viewer)) {
    const bal = await solBalance(viewer);
    if (bal < MIN_POST_LAMPORTS) fail(402, `Posting needs 0.01 SOL in your wallet (you have ${(bal / 1e9).toFixed(4)} SOL). It keeps bots out.`);
  }

  const ts = Date.now();
  const id = ts.toString(36) + crypto.randomBytes(4).toString('hex');
  const { mints, tickers, mentions } = extract(text);
  const post = { id, wallet: viewer, text, image, ts, replyTo: parent ? parent.id : null, mints, tickers };
  const c = [
    ['SET', 'post:' + id, JSON.stringify(post)],
    ['HSET', 'pc:' + id, 'likes', 0, 'reposts', 0, 'replies', 0],
    ...mints.map(m => ['ZADD', 'tl:m:' + m, ts, id]),
    ...tickers.map(t => ['ZADD', 'tl:t:' + t, ts, id]),
  ];
  if (parent) {
    c.push(['ZADD', 'replies:' + parent.id, ts, id], ['HINCRBY', 'pc:' + parent.id, 'replies', 1], ['ZADD', 'tl:ur:' + viewer, ts, id]);
  } else {
    c.push(['ZADD', 'tl:all', ts, id], ['ZADD', 'tl:u:' + viewer, ts, 'p:' + id], ['DEL', 'fy:cache']);
    if (user.verified) c.push(['ZADD', 'tl:v', ts, id]);
  }
  await pipe(c);
  if (parent) await notify(parent.wallet, 'reply', viewer, id);
  if (mentions.length) {
    const ws = await cmd('MGET', ...mentions.map(h => 'h:' + h));
    for (const w of new Set(ws.filter(Boolean))) if (!parent || w !== parent.wallet) await notify(w, 'mention', viewer, id);
  }
  return { post: (await hydrate([{ id }], viewer))[0] };
}

async function toggle(viewer, id, kind, on) {
  await requireProfile(viewer);
  const p = parse(await cmd('GET', 'post:' + id));
  if (!p) fail(404, 'This post was deleted');
  const set = (kind === 'like' ? 'likes:' : 'rps:') + id;
  const field = kind === 'like' ? 'likes' : 'reposts';
  const changed = await cmd(on ? 'SADD' : 'SREM', set, viewer);
  if (changed) {
    const ts = Date.now();
    const c = [['HINCRBY', 'pc:' + id, field, on ? 1 : -1]];
    if (kind === 'like') c.push(on ? ['ZADD', 'tl:ul:' + viewer, ts, id] : ['ZREM', 'tl:ul:' + viewer, id]);
    else c.push(on ? ['ZADD', 'tl:u:' + viewer, ts, 'r:' + id] : ['ZREM', 'tl:u:' + viewer, 'r:' + id]);
    await pipe(c);
    if (on) await notify(p.wallet, kind, viewer, id);
  }
  const [count, flag] = await pipe([['HGET', 'pc:' + id, field], ['SISMEMBER', set, viewer]]);
  return { id, [field]: Math.max(0, +count || 0), [kind === 'like' ? 'liked' : 'reposted']: !!flag };
}

async function remove(viewer, id) {
  const p = parse(await cmd('GET', 'post:' + id));
  if (!p) fail(404, 'Already deleted');
  if (p.wallet !== viewer) fail(403, 'You can only delete your own posts');
  const c = [
    ['DEL', 'post:' + id, 'pc:' + id, 'likes:' + id, 'rps:' + id],
    ['ZREM', 'tl:all', id], ['ZREM', 'tl:v', id], ['ZREM', 'tl:u:' + viewer, 'p:' + id], ['ZREM', 'tl:ur:' + viewer, id],
    ...(p.mints || []).map(m => ['ZREM', 'tl:m:' + m, id]),
    ...(p.tickers || []).map(t => ['ZREM', 'tl:t:' + t, id]),
    ['DEL', 'fy:cache'],
  ];
  if (p.replyTo) c.push(['ZREM', 'replies:' + p.replyTo, id], ['HINCRBY', 'pc:' + p.replyTo, 'replies', -1]);
  await pipe(c);
  return { ok: true, id };
}

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    const { query: q, viewer } = ctx;
    if (ctx.method === 'GET') {
      if (q.id) return thread(String(q.id), viewer);
      const feed = q.feed || 'foryou';
      switch (feed) {
        case 'foryou': return forYou(viewer, q.cursor);
        case 'following': return following(viewer, q.cursor);
        case 'verified': return zFeed('tl:v', viewer, q.cursor);
        case 'latest': return zFeed('tl:all', viewer, q.cursor);
        case 'search': return search(q.q, viewer, q.cursor);
        case 'coin': {
          const keys = [];
          if (isPubkey(q.mint)) keys.push('tl:m:' + q.mint);
          if (q.sym && /^[A-Za-z0-9]{1,12}$/.test(q.sym)) keys.push('tl:t:' + q.sym.toUpperCase());
          if (!keys.length) fail(400, 'Unknown coin');
          return mergedFeed(keys, viewer, q.cursor);
        }
        case 'user': case 'replies': case 'likes': {
          const w = String(q.wallet || '');
          if (!isPubkey(w)) fail(400, 'Unknown user');
          if (feed === 'user') return userTimeline('tl:u:' + w, w, viewer, q.cursor);
          if (feed === 'replies') return zFeed('tl:ur:' + w, viewer, q.cursor);
          return zFeed('tl:ul:' + w, viewer, q.cursor);
        }
        default: fail(400, 'Unknown feed');
      }
    }
    if (ctx.method !== 'POST') fail(405, 'Method not allowed');
    const viewerW = ctx.auth();
    const body = await ctx.body();
    const action = q.action || 'create';
    const id = String(body.id || '');
    switch (action) {
      case 'create': return create(viewerW, body);
      case 'like': return toggle(viewerW, id, 'like', true);
      case 'unlike': return toggle(viewerW, id, 'like', false);
      case 'repost': return toggle(viewerW, id, 'repost', true);
      case 'unrepost': return toggle(viewerW, id, 'repost', false);
      case 'delete': return remove(viewerW, id);
      default: fail(400, 'Unknown action');
    }
  });
}

