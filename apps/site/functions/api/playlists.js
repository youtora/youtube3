import { getDB } from "../_db.js";
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name) || String(fallback), 10);
  return clamp(Number.isFinite(n) ? n : fallback, min, max);
}

function parseCursor(raw) {
  const id = parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const limit = intParam(url, "limit", 60, 1, 200);

  // cursor format: "<row_id>" (playlists.id)
  const cursorId = parseCursor(url.searchParams.get("cursor") || "");

  const rows = cursorId !== null
    ? await env.DB.prepare(`
        SELECT
          p.id,
          p.playlist_id,
          p.title,
          p.thumb_video_id,
          p.published_at,
          p.item_count,
          c.channel_id,
          c.title AS channel_title
        FROM playlists p
        JOIN channels c
          ON c.id = p.channel_int
        WHERE p.id < ?
          AND (
            COALESCE(c.show_in_public_channels, 1) = 1
            OR EXISTS (
              SELECT 1
              FROM videos v
              WHERE v.channel_int = c.id
                AND v.netfree_status = 1
              LIMIT 1
            )
          )
        ORDER BY p.id DESC
        LIMIT ?
      `).bind(cursorId, limit).all()
    : await env.DB.prepare(`
        SELECT
          p.id,
          p.playlist_id,
          p.title,
          p.thumb_video_id,
          p.published_at,
          p.item_count,
          c.channel_id,
          c.title AS channel_title
        FROM playlists p
        JOIN channels c
          ON c.id = p.channel_int
        WHERE (
          COALESCE(c.show_in_public_channels, 1) = 1
          OR EXISTS (
            SELECT 1
            FROM videos v
            WHERE v.channel_int = c.id
              AND v.netfree_status = 1
            LIMIT 1
          )
        )
        ORDER BY p.id DESC
        LIMIT ?
      `).bind(limit).all();

  const resultRows = rows.results || [];

  const playlists = resultRows.map(r => ({
    playlist_id: r.playlist_id,
    title: r.title,
    thumb_video_id: r.thumb_video_id,
    published_at: r.published_at,
    item_count: r.item_count,
    channel_id: r.channel_id,
    channel_title: r.channel_title
  }));

  const last = resultRows[resultRows.length - 1];
  const next_cursor =
    resultRows.length >= limit && last
      ? String(last.id)
      : null;

  return Response.json(
    { playlists, next_cursor },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
