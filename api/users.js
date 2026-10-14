// Users: lookup, search, who-to-follow, profile create/edit, follow/unfollow, follower lists.
import {
  run, fail, cmd, pipe, parse, isPubkey, publicUser, getUserRaw, getUsersRaw, RESERVED, notify, okImageUrl, isOfficial, OFFICIAL_HANDLE, cleanWebsite,
} from './_lib.js';

const HANDLE_RE = /^[a-z0-9_]{3,15}$/;
const clean = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);

async function withCounts(users, viewer) {
  const list = users.filter(Boolean);
  if (!list.length) return [];
  const per = viewer ? 4 : 2;
  const c = await pipe(list.flatMap(u => [
    ['SCARD', 'fs:' + u.wallet], ['SCARD', 'f:' + u.wallet],
    ...(viewer ? [['SISMEMBER', 'f:' + viewer, u.wallet], ['SISMEMBER', 'f:' + u.wallet, viewer]] : []),
  ]));
  return list.map((u, i) => ({
    ...publicUser(u), followers: +c[i * per] || 0, following: +c[i * per + 1] || 0,
    isFollowing: viewer ? !!+c[i * per + 2] : false, followsYou: viewer ? !!+c[i * per + 3] : false,
  }));
}

async function byHandle(handle) {
  const w = await cmd('GET', 'h:' + String(handle).toLowerCase());
  return w ? getUserRaw(w) : null;
}

async function saveProfile(viewer, body) {
  const existing = await getUserRaw(viewer);
  const handle = String(body.handle ?? existing?.handle ?? '').toLowerCase().trim();
  const offY = isOfficial(viewer) && handle === OFFICIAL_HANDLE;
  if (!offY && !HANDLE_RE.test(handle)) fail(400, 'Handle must be 3–15 characters: a–z, 0–9 and _');
  if (!offY && RESERVED.has(handle)) fail(409, '@' + handle + ' is reserved');
  const name = clean(body.name ?? existing?.name ?? handle, 50) || handle;
  const bio = clean(body.bio ?? existing?.bio ?? '', 160);
  const avatar = body.avatar !== undefined ? String(body.avatar || '') : existing?.avatar || '';
  const banner = body.banner !== undefined ? String(body.banner || '') : existing?.banner || '';
  if (!okImageUrl(avatar) || !okImageUrl(banner)) fail(400, 'Images must be uploaded through Y');
  const website = body.website !== undefined ? cleanWebsite(body.website) : (existing?.website || '');
  if (website === null) fail(400, 'That website link is not valid');

  if (!existing || existing.handle !== handle) {
    const ok = await cmd('SET', 'h:' + handle, viewer, 'NX');
    if (!ok) {
      const owner = await cmd('GET', 'h:' + handle);
      if (owner !== viewer) fail(409, '@' + handle + ' is taken');
    }
    if (existing?.handle) await pipe([['DEL', 'h:' + existing.handle], ['ZREM', 'handles', existing.handle]]);
  }
  const u = {
    ...(existing || {}), wallet: viewer, handle, name, bio, avatar, banner, website,
    joined: existing?.joined || Date.now(), devCoins: existing?.devCoins || [], verified: existing?.verified || (isOfficial(viewer) ? Date.now() : 0),
  };
  const followers = await cmd('SCARD', 'fs:' + viewer);
  await pipe([
    ['SET', 'u:' + viewer, JSON.stringify(u)],
    ['ZADD', 'handles', 0, handle],
    ['ZADD', 'z:followers', +followers || 0, viewer],
  ]);
  return { user: (await withCounts([u], viewer))[0], created: !existing?.handle };
}

async function follow(viewer, target, on) {
  const me = await getUserRaw(viewer);
  if (!me?.handle) fail(403, 'Finish setting up your profile first');
  if (!isPubkey(target)) fail(400, 'Unknown user');
  if (target === viewer) fail(400, "You can't follow yourself");
  const t = await getUserRaw(target);
  if (!t?.handle) fail(404, 'User not found');
  const changed = await cmd(on ? 'SADD' : 'SREM', 'f:' + viewer, target);
  if (changed) {
    await cmd(on ? 'SADD' : 'SREM', 'fs:' + target, viewer);
    const n = await cmd('SCARD', 'fs:' + target);
    await cmd('ZADD', 'z:followers', n, target);
    if (on) await notify(target, 'follow', viewer, null);
  }
  return { user: (await withCounts([t], viewer))[0] };
}

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    const { query: q, viewer } = ctx;
    if (ctx.method === 'GET') {
      if (q.handle) {
        const u = await byHandle(q.handle);
        if (!u) fail(404, 'This account does not exist');
        return { user: (await withCounts([u], viewer))[0] };
      }
      if (q.wallet) {
        if (!isPubkey(q.wallet)) fail(400, 'Unknown wallet');
        const u = await getUserRaw(q.wallet);
        return { user: u?.handle ? (await withCounts([u], viewer))[0] : null };
      }
      if (q.wallets) {
        const ws = String(q.wallets).split(',').filter(isPubkey).slice(0, 100);
        const m = await getUsersRaw(ws);
        const out = {};
        for (const [w, u] of Object.entries(m)) if (u.handle) out[w] = publicUser(u);
        return { users: out };
      }
      if (q.available !== undefined) {
        const h = String(q.available).toLowerCase();
        if (h === OFFICIAL_HANDLE && isOfficial(viewer)) return { available: true, reason: '' };
        if (!HANDLE_RE.test(h)) return { available: false, reason: '3–15 characters: a–z, 0–9 and _' };
        if (RESERVED.has(h)) return { available: false, reason: 'Reserved' };
        const w = await cmd('GET', 'h:' + h);
        return { available: !w || w === viewer, reason: w && w !== viewer ? 'Taken' : '' };
      }
      if (q.q !== undefined) {
        const p = String(q.q).toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 15);
        if (!p) return { users: [] };
        const handles = await cmd('ZRANGEBYLEX', 'handles', '[' + p, '[' + p + '~', 'LIMIT', 0, 10);
        const ws = handles.length ? await cmd('MGET', ...handles.map(h => 'h:' + h)) : [];
        const m = await getUsersRaw(ws.filter(Boolean));
        return { users: await withCounts(ws.map(w => m[w]), viewer) };
      }
      if (q.list === 'followers' || q.list === 'following') {
        if (!isPubkey(q.of)) fail(400, 'Unknown user');
        const ws = (await cmd('SMEMBERS', (q.list === 'followers' ? 'fs:' : 'f:') + q.of)).slice(0, 200);
        const m = await getUsersRaw(ws);
        return { users: await withCounts(ws.map(w => m[w]), viewer) };
      }
      if (q.sort === 'followers') {
        const n = Math.min(20, Math.max(1, +q.limit || 5));
        const ws = await cmd('ZREVRANGE', 'z:followers', 0, 59);
        const m = await getUsersRaw(ws);
        let us = ws.map(w => m[w]).filter(u => u?.handle && u.wallet !== viewer);
        if (viewer && us.length) {
          const f = await pipe(us.map(u => ['SISMEMBER', 'f:' + viewer, u.wallet]));
          us = us.filter((_, i) => !+f[i]);
        }
        us.sort((a, b) => ((b.official ? 2 : 0) + (b.verified ? 1 : 0)) - ((a.official ? 2 : 0) + (a.verified ? 1 : 0)));
        return { users: await withCounts(us.slice(0, n), viewer) };
      }
      fail(400, 'Missing query');
    }
    if (ctx.method !== 'POST') fail(405, 'Method not allowed');
    const w = ctx.auth();
    const body = await ctx.body();
    switch (q.action) {
      case 'profile': return saveProfile(w, body);
      case 'follow': return follow(w, String(body.wallet || ''), true);
      case 'unfollow': return follow(w, String(body.wallet || ''), false);
      default: fail(400, 'Unknown action');
    }
  });
}
