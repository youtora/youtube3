import { getDB } from "../_db.js";
// functions/admin/channels.js

function unauthorized() { return new Response("unauthorized", { status: 401 }); }

export async function onRequest({ env, request }) {

  env.DB = getDB(env);
  if (request.method === "GET") {
    // קריאה אחת: רשימת ערוצים + מצב WebSub אם קיים
    const rows = await env.DB.prepare(`
      SELECT c.id,
             c.channel_id,
             c.title,
             c.thumbnail_url,
             c.is_active,
             c.updated_at,
             s.status AS websub_status,
             s.lease_expires_at,
             s.last_error
      FROM channels c
      LEFT JOIN subscriptions s ON s.channel_int = c.id
      ORDER BY c.id DESC
    `).all();

    return Response.json({ channels: rows.results || [] }, { headers: { "cache-control": "no-store" } });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const action = (body.action || "").trim();
    const channel_id = (body.channel_id || "").trim();
    if (!channel_id) return new Response("missing channel_id", { status: 400 });

    if (action !== "purge") return new Response("unsupported action", { status: 400 });

    const ch = await env.DB.prepare(`
      SELECT id
      FROM channels
      WHERE channel_id = ?
      LIMIT 1
    `).bind(channel_id).first();

    if (!ch?.id) return new Response("not found", { status: 404 });
    const channel_int = ch.id;

    // ⚠️ מחיקה מלאה: ילדים -> הורה (כדי לא להיתקע עם FK)
    // video_fts: אם הוא מוגדר עם טריגרים על videos, ייתכן שלא צריך למחוק ידנית.
    // כאן נעשה "best effort": אם אין table/אי אפשר למחוק - ממשיכים.
    let delFts = 0;
    try {
      const r = await env.DB.prepare(`
        DELETE FROM video_fts
        WHERE rowid IN (SELECT id FROM videos WHERE channel_int = ?)
      `).bind(channel_int).run();
      delFts = r?.meta?.changes || 0;
    } catch (_) {}

    const delVideos = await env.DB.prepare(`
      DELETE FROM videos
      WHERE channel_int = ?
    `).bind(channel_int).run();

    const delPlaylists = await env.DB.prepare(`
      DELETE FROM playlists
      WHERE channel_int = ?
    `).bind(channel_int).run();

    const delSubs = await env.DB.prepare(`
      DELETE FROM subscriptions
      WHERE channel_int = ?
    `).bind(channel_int).run();

    const delBackfill = await env.DB.prepare(`
      DELETE FROM channel_backfill
      WHERE channel_int = ?
    `).bind(channel_int).run();

    const delChannel = await env.DB.prepare(`
      DELETE FROM channels
      WHERE id = ?
    `).bind(channel_int).run();

    return Response.json({
      ok: true,
      action: "purge",
      channel_id,
      deleted: {
        video_fts: delFts,
        videos: delVideos?.meta?.changes || 0,
        playlists: delPlaylists?.meta?.changes || 0,
        subscriptions: delSubs?.meta?.changes || 0,
        channel_backfill: delBackfill?.meta?.changes || 0,
        channels: delChannel?.meta?.changes || 0
      }
    }, { headers: { "cache-control": "no-store" } });
  }

  return new Response("use GET or POST", { status: 200 });
}
