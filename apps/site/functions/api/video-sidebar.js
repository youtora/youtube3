import { getDB } from "../_db.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normalizeTab(value) {
  const tab = String(value || "more").trim().toLowerCase();
  return ["more", "popular", "playlists"].includes(tab) ? tab : "more";
}

function mapVideo(r, current) {
  return {
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    video_kind: r.video_kind || "",
    duration_sec: r.duration_sec ?? null,
    view_count: r.view_count ?? null,
    like_count: r.like_count ?? null,
    comment_count: r.comment_count ?? null,
    channel_id: current.channel_id || null,
    channel_title: current.channel_title || null,
    channel_thumbnail_url: current.thumbnail_url || null
  };
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);

  const video_id = (url.searchParams.get("video_id") || "").trim();
  if (!video_id) return Response.json({ error: "missing video_id" }, { status: 400 });

  const tab = normalizeTab(url.searchParams.get("tab"));
  const limit = clamp(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 1, 10);

  const current = await env.DB.prepare(`
    SELECT
      v.id,
      v.video_id,
      v.channel_int,
      v.language_code,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url
    FROM videos v
    LEFT JOIN channels c
      ON c.id = v.channel_int
    WHERE v.video_id = ?
      AND v.netfree_status = 1
    LIMIT 1
  `).bind(video_id).first();

  if (!current || !current.channel_int) return Response.json({ error: "not found" }, { status: 404 });

  const lang = String(current.language_code || "he").trim() || "he";

  if (tab === "playlists") {
    const rows = await env.DB.prepare(`
      SELECT
        playlist_id,
        title,
        thumb_video_id,
        published_at,
        item_count
      FROM playlists
      WHERE channel_int = ?
      ORDER BY id DESC
      LIMIT ?
    `).bind(current.channel_int, limit).all();

    const playlists = (rows.results || []).map(r => ({
      playlist_id: r.playlist_id,
      title: r.title,
      thumb_video_id: r.thumb_video_id,
      published_at: r.published_at,
      item_count: r.item_count,
      channel_id: current.channel_id || null,
      channel_title: current.channel_title || null
    }));

    return Response.json(
      { tab, playlists },
      { headers: { "cache-control": "public, max-age=120" } }
    );
  }

  const orderSql = tab === "popular"
    ? "view_count DESC, published_at DESC, id DESC"
    : "published_at DESC, id DESC";

  const rows = await env.DB.prepare(`
    SELECT
      id,
      video_id,
      title,
      published_at,
      video_kind,
      duration_sec,
      view_count,
      like_count,
      comment_count
    FROM videos
    WHERE channel_int = ?
      AND netfree_status = 1
      AND video_id <> ?
      AND language_code = ?
    ORDER BY ${orderSql}
    LIMIT ?
  `).bind(current.channel_int, video_id, lang, limit).all();

  return Response.json(
    {
      tab,
      videos: (rows.results || []).map(r => mapVideo(r, current))
    },
    { headers: { "cache-control": "public, max-age=120" } }
  );
}
