import { getDB } from "../_db.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export async function onRequest({ env, request }) {
  const DB = getDB(env);
  const url = new URL(request.url);
  const video_id = (url.searchParams.get("video_id") || "").trim();
  if (!video_id) return new Response("missing video_id", { status: 400 });

  const recLimit = clamp(parseInt(url.searchParams.get("recommended_limit") || "20", 10), 1, 60);

  const vrow = await DB.prepare(`
    SELECT id, video_id, title, published_at, channel_int, video_kind, duration_sec
    FROM videos
    WHERE video_id = ?
    LIMIT 1
  `).bind(video_id).first();

  if (!vrow) return new Response("not found", { status: 404 });

  const crow = await DB.prepare(`
    SELECT channel_id, title AS channel_title, thumbnail_url
    FROM channels
    WHERE id = ?
    LIMIT 1
  `).bind(vrow.channel_int).first();

  const video = {
    video_id: vrow.video_id,
    title: vrow.title,
    published_at: vrow.published_at,
    video_kind: vrow.video_kind || "",
    duration_sec: vrow.duration_sec ?? null,
    channel_id: crow?.channel_id || null,
    channel_title: crow?.channel_title || null,
    thumbnail_url: crow?.thumbnail_url || null,
  };

  const rec = await DB.prepare(`
    SELECT
      v.video_id,
      v.title,
      v.published_at,
      v.video_kind,
      v.duration_sec,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url AS channel_thumbnail_url
    FROM videos AS v INDEXED BY idx_videos_channel_cover
    JOIN channels AS c
      ON c.id = v.channel_int
    WHERE v.channel_int = ?
      AND v.video_id <> ?
    ORDER BY v.published_at DESC, v.id DESC
    LIMIT ?
  `).bind(vrow.channel_int, video_id, recLimit).all();

  const recommended = (rec.results || []).map(r => ({
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    video_kind: r.video_kind || "",
    duration_sec: r.duration_sec ?? null,
    channel_id: r.channel_id || null,
    channel_title: r.channel_title || null,
    channel_thumbnail_url: r.channel_thumbnail_url || null,
  }));

  return Response.json(
    {
      video,
      recommended
    },
    {
      headers: {
        "cache-control": "public, max-age=300"
      }
    }
  );
}
