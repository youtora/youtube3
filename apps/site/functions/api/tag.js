import { getDB } from "../_db.js";
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name) || String(fallback), 10);
  return clamp(Number.isFinite(n) ? n : fallback, min, max);
}

function normalizeTagName(value) {
  return String(value || "").trim().replace(/^#+/, "").trim();
}

function normalizeTagKey(value) {
  return normalizeTagName(value)
    .replace(/[“”״"]/g, '"')
    .replace(/[‘’׳']/g, "'")
    .toLocaleLowerCase();
}

function normalizeTagType(value) {
  return value === "hashtag" ? "hashtag" : "tag";
}

function parseCursor(raw) {
  const n = parseInt(String(raw || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildTagSql(hasCursor) {
  return `
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
    FROM video_tags AS t INDEXED BY idx_video_tags_lookup
    JOIN videos AS v
      ON v.id = t.video_rowid
    JOIN channels AS c
      ON c.id = v.channel_int
    WHERE t.tag_type = ?
      AND t.tag_norm = ?
      ${hasCursor ? "AND t.video_rowid < ?" : ""}
    ORDER BY t.video_rowid DESC, t.id DESC
    LIMIT ?
  `;
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);

  const value = normalizeTagName(url.searchParams.get("value") || url.searchParams.get("tag") || "");
  const valueNorm = normalizeTagKey(value);
  const type = normalizeTagType((url.searchParams.get("type") || "tag").trim().toLowerCase());
  const limit = intParam(url, "limit", 50, 1, 100);
  const cursor = parseCursor(url.searchParams.get("cursor") || "");

  if (!valueNorm) {
    return Response.json(
      { results: [], next_cursor: null, value, type },
      { headers: { "cache-control": "public, max-age=30" } }
    );
  }

  const sql = buildTagSql(cursor !== null);

  const res = cursor !== null
    ? await env.DB.prepare(sql).bind(type, valueNorm, cursor, limit).all()
    : await env.DB.prepare(sql).bind(type, valueNorm, limit).all();

  const rows = res.results || [];
  const results = rows.map(v => ({
    video_id: v.video_id,
    title: v.title,
    published_at: v.published_at,
    video_kind: v.video_kind || "",
    duration_sec: v.duration_sec ?? null,
    view_count: v.view_count ?? null,
    like_count: v.like_count ?? null,
    comment_count: v.comment_count ?? null,
    channel_id: v.channel_id || null,
    channel_title: v.channel_title || null,
    channel_thumbnail_url: v.channel_thumbnail_url || null,
    cursor: String(v.id)
  }));

  const last = rows[rows.length - 1];
  const next_cursor =
    rows.length >= limit && last
      ? String(last.id)
      : null;

  return Response.json(
    { results, next_cursor, value, type },
    { headers: { "cache-control": "public, max-age=30" } }
  );
}
