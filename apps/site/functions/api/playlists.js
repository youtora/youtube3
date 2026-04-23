import { getDB } from "../_db.js";

export async function onRequest({ env, request }) {
  const DB = getDB(env);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "60", 10), 1), 200);

  // cursor format: "<row_id>" (playlists.id)
  const cursorRaw = (url.searchParams.get("cursor") || "").trim();
  let cursorId = null;
  if (cursorRaw) {
    const id = parseInt(cursorRaw, 10);
    if (!Number.isNaN(id) && id > 0) cursorId = id;
  }

  const rows = await DB.prepare(`
    SELECT p.id, p.playlist_id, p.title, p.thumb_video_id, p.published_at, p.item_count,
           c.channel_id, c.title AS channel_title
    FROM playlists p
    JOIN channels c ON c.id = p.channel_int
    WHERE (? IS NULL OR p.id < ?)
    ORDER BY p.id DESC
    LIMIT ?
  `).bind(cursorId, cursorId, limit).all();

  const playlists = (rows.results || []).map(r => ({
    playlist_id: r.playlist_id,
    title: r.title,
    thumb_video_id: r.thumb_video_id,
    published_at: r.published_at,
    item_count: r.item_count,
    channel_id: r.channel_id,
    channel_title: r.channel_title,
  }));

  let next_cursor = null;
  const last = (rows.results || [])[rows.results.length - 1];
  if (last) next_cursor = String(last.id);

  return Response.json(
    { playlists, next_cursor },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
