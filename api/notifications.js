// Notifications: GET list (marks unread count), GET ?count=1 unread count, POST ?action=read marks all read.
import { run, fail, cmd, pipe, parse, getUsersRaw, publicUser, hydrate } from './_lib.js';

export default async function handler(req, res) {
  return run(req, res, async (ctx) => {
    const w = ctx.auth();
    if (ctx.method === 'POST') {
      if (ctx.query.action !== 'read') fail(400, 'Unknown action');
      await cmd('SET', 'nseen:' + w, Date.now());
      return { ok: true };
    }
    if (ctx.method !== 'GET') fail(405, 'Method not allowed');
    const [raw, seen] = await pipe([['LRANGE', 'n:' + w, 0, ctx.query.count ? 49 : 99], ['GET', 'nseen:' + w]]);
    const items = (raw || []).map(parse).filter(Boolean);
    const seenTs = +seen || 0;
    const unread = items.filter(n => n.ts > seenTs).length;
    if (ctx.query.count) return { unread };
    const users = await getUsersRaw(items.map(n => n.from));
    const postIds = [...new Set(items.map(n => n.post).filter(Boolean))];
    const posts = await hydrate(postIds.map(id => ({ id })), w);
    const pm = Object.fromEntries(posts.map(p => [p.id, p]));
    const out = [];
    for (const n of items) {
      const u = users[n.from]; if (!u?.handle) continue;
      if (n.post && !pm[n.post]) continue;
      out.push({ type: n.type, ts: n.ts, unread: n.ts > seenTs, from: publicUser(u), post: n.post ? pm[n.post] : null });
    }
    return { items: out, unread };
  });
}
