import { getDB } from "../_db.js";

export async function onRequest({ env, request }) {
  const DB = getDB(env);
  const url = new URL(request.url);

  const limit = 200;

  const kindRaw = (url.searchParams.get("kind") || "").trim().toUpperCase();
  const kind = (kindRaw === "S" || kindRaw === "L") ? kindRaw : null;

  // cursor format: "<published_at>:<id>"
  const cursorRaw = (url.searchParams.get("cursor") || "").trim();
  let cursorP = null;
  let cursorId = null;

  if (cursorRaw) {
    const parts = cursorRaw.split(":");
    if (parts.length === 2) {
      const p = parseInt(parts[0] || "0", 10);
      const id = parseInt(parts[1] || "0", 10);
      if (Number.isFinite(p) && Number.isFinite(id) && id > 0) {
        cursorP = p;
        cursorId = id;
      }
    }
  }

  let rows;

  if (kind) {
    rows =
      (cursorP !== null && cursorId !== null)
        ? await DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
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
        : await DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
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
        ? await DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
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
        : await DB.prepare(`
            SELECT
              v.id,
              v.video_id,
              v.title,
              v.published_at,
              v.video_kind,
              v.duration_sec,
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
    channel_id: r.channel_id || null,
    channel_title: r.channel_title || null,
    channel_thumbnail_url: r.channel_thumbnail_url || null,
  }));
  let next_cursor = null;
  const last = vrows[vrows.length - 1];
  if (last) {
    const p = (last.published_at ?? 0);
    next_cursor = `${p}:${last.id}`;
  }

  return Response.json(
    { videos, next_cursor },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
