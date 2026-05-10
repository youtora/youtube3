import { getDB } from "../_db.js";
import { parseJsonArray } from "../_shared/video-meta.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const video_id = (url.searchParams.get("video_id") || "").trim();
  if (!video_id) return new Response("missing video_id", { status: 400 });

  const recLimit = clamp(parseInt(url.searchParams.get("recommended_limit") || "10", 10) || 10, 1, 10);

  const vrow = await env.DB.prepare(`
    SELECT
      v.id,
      v.video_id,
      v.title,
      v.published_at,
      v.channel_int,
      v.video_kind,
      v.duration_sec,
      v.view_count,
      v.like_count,
      v.comment_count,
      v.language_code,
      d.description,
      d.tags_json,
      d.hashtags_json,
      d.fetched_at AS details_fetched_at,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url
    FROM videos v
    LEFT JOIN video_details d
      ON d.video_id = v.video_id
    LEFT JOIN channels c
      ON c.id = v.channel_int
    WHERE v.video_id = ?
      AND v.netfree_status = 1
    LIMIT 1
  `).bind(video_id).first();

  if (!vrow) return new Response("not found", { status: 404 });

  const video = {
    video_id: vrow.video_id,
    title: vrow.title,
    published_at: vrow.published_at,
    video_kind: vrow.video_kind || "",
    duration_sec: vrow.duration_sec ?? null,
    view_count: vrow.view_count ?? null,
    like_count: vrow.like_count ?? null,
    comment_count: vrow.comment_count ?? null,
    language_code: vrow.language_code || "",
    description: vrow.description || "",
    tags: parseJsonArray(vrow.tags_json),
    hashtags: parseJsonArray(vrow.hashtags_json),
    details_fetched_at: vrow.details_fetched_at ?? null,
    channel_id: vrow.channel_id || null,
    channel_title: vrow.channel_title || null,
    thumbnail_url: vrow.thumbnail_url || null
  };

  const lang = String(vrow.language_code || "he").trim() || "he";

  const rec = await env.DB.prepare(`
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
    ORDER BY published_at DESC, id DESC
    LIMIT ?
  `).bind(vrow.channel_int, video_id, lang, recLimit).all();

  const recommended = (rec.results || []).map(r => ({
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    video_kind: r.video_kind || "",
    duration_sec: r.duration_sec ?? null,
    view_count: r.view_count ?? null,
    like_count: r.like_count ?? null,
    comment_count: r.comment_count ?? null,
    channel_id: vrow.channel_id || null,
    channel_title: vrow.channel_title || null,
    channel_thumbnail_url: vrow.thumbnail_url || null
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
