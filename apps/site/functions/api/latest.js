import { getDB } from "../_db.js";
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name) || String(fallback), 10);
  return clamp(Number.isFinite(n) ? n : fallback, min, max);
}

// cursor format: "<published_at>:<id>"
function parseCursor(raw) {
  const s = (raw || "").trim();
  if (!s) return { p: null, id: null };

  const parts = s.split(":");
  if (parts.length !== 2) return { p: null, id: null };

  const p = parseInt(parts[0] || "0", 10);
  const id = parseInt(parts[1] || "0", 10);

  if (!Number.isFinite(p) || !Number.isFinite(id) || id <= 0) {
    return { p: null, id: null };
  }

  return { p, id };
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);

  const limit = intParam(url, "limit", 24, 1, 50);

  const kindRaw = (url.searchParams.get("kind") || "").trim().toUpperCase();
  const kind = (kindRaw === "S" || kindRaw === "L") ? kindRaw : null;

  const { p: cursorP, id: cursorId } = parseCursor(
    url.searchParams.get("cursor") || ""
  );

  let rows;

  if (kind) {
    rows =
      (cursorP !== null && cursorId !== null)
        ? await env.DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
              v.view_count,
              v.like_count,
              v.comment_count,
              c.channel_id,
              c.title AS channel_title,
              c.thumbnail_url AS channel_thumbnail_url
            FROM videos AS v INDEXED BY idx_videos_kind_latest_cover
            JOIN channels AS c
              ON c.id = v.channel_int
            WHERE v.video_kind = ?
              AND (v.published_at, v.id) < (?, ?)
            ORDER BY v.published_at DESC, v.id DESC
            LIMIT ?
          `).bind(kind, cursorP, cursorId, limit).all()
        : await env.DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
              v.view_count,
              v.like_count,
              v.comment_count,
              c.channel_id,
              c.title AS channel_title,
              c.thumbnail_url AS channel_thumbnail_url
            FROM videos AS v INDEXED BY idx_videos_kind_latest_cover
            JOIN channels AS c
              ON c.id = v.channel_int
            WHERE v.video_kind = ?
            ORDER BY v.published_at DESC, v.id DESC
            LIMIT ?
          `).bind(kind, limit).all();
  } else {
    rows =
      (cursorP !== null && cursorId !== null)
        ? await env.DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
              v.view_count,
              v.like_count,
              v.comment_count,
              c.channel_id,
              c.title AS channel_title,
              c.thumbnail_url AS channel_thumbnail_url
            FROM videos AS v INDEXED BY idx_videos_latest_cover
            JOIN channels AS c
              ON c.id = v.channel_int
            WHERE (v.published_at, v.id) < (?, ?)
            ORDER BY v.published_at DESC, v.id DESC
            LIMIT ?
          `).bind(cursorP, cursorId, limit).all()
        : await env.DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
              v.view_count,
              v.like_count,
              v.comment_count,
              c.channel_id,
              c.title AS channel_title,
              c.thumbnail_url AS channel_thumbnail_url
            FROM videos AS v INDEXED BY idx_videos_latest_cover
            JOIN channels AS c
              ON c.id = v.channel_int
            ORDER BY v.published_at DESC, v.id DESC
            LIMIT ?
          `).bind(limit).all();
  }

  const vrows = rows.results || [];

  const videos = vrows.map(r => ({
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    video_kind: r.video_kind || "",
    duration_sec: r.duration_sec ?? null,
    view_count: r.view_count ?? null,
    like_count: r.like_count ?? null,
    comment_count: r.comment_count ?? null,
    channel_id: r.channel_id || null,
    channel_title: r.channel_title || null,
    channel_thumbnail_url: r.channel_thumbnail_url || null
  }));

  const last = vrows[vrows.length - 1];
  const next_cursor =
    vrows.length >= limit && last
      ? `${last.published_at ?? 0}:${last.id}`
      : null;

  return Response.json(
    { videos, next_cursor },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
