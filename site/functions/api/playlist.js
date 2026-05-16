import { getDB } from "../_db.js";
import { publicProviderFromRequest, publicVideoWhereSql } from "../_shared/filter-policy.js";
export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const provider = publicProviderFromRequest(request, url);
  const publicVideoWhere = publicVideoWhereSql(provider, "v");

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
      AND (
        COALESCE(c.show_in_public_channels, 1) = 1
        OR EXISTS (
          SELECT 1
          FROM videos v
          WHERE v.channel_int = c.id
            AND ${publicVideoWhere}
          LIMIT 1
        )
      )
    LIMIT 1
  `).bind(playlist_id).first();

  if (!playlist) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return Response.json(
    { playlist, provider },
    { headers: { "cache-control": "public, max-age=300" } }
  );
}
