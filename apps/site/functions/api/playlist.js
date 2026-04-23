import { getDB } from "../_db.js";

export async function onRequest({ env, request }) {
  env.DB = env.DB || getDB(env);
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405 });
  }

  const playlist_id = (url.searchParams.get("playlist_id") || "").trim();
  if (!playlist_id) {
    return Response.json({ error: "missing playlist_id" }, { status: 400 });
  }

  // שים לב: אין פה thumbnail_url בכלל
  const playlist = await env.DB.prepare(`
    SELECT
      p.playlist_id,
      p.title,
      p.thumb_video_id,
      p.published_at,
      p.item_count,
      p.updated_at,
      c.channel_id,
      c.title AS channel_title
    FROM playlists p
    JOIN channels c ON c.id = p.channel_int
    WHERE p.playlist_id = ?
    LIMIT 1
  `).bind(playlist_id).first();

  if (!playlist) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return Response.json(
    { playlist },
    { headers: { "cache-control": "no-store" } }
  );
}
