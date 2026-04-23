import { getDB } from "../_db.js";

// functions/api/search.js
// FTS5 search on titles only (video_fts) + cursor pagination by rowid
// Always returns 50 results per request (no max limit param).

function cleanQuery(q) {
  const s = (q || "").trim();
  if (!s) return "";
  return s
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toFtsMatch(cleaned) {
  if (!cleaned) return "";
  const parts = cleaned.split(" ").filter(Boolean);
  if (!parts.length) return "";
  return parts.map(p => `"${p}"`).join(" ");
}

export async function onRequest({ env, request }) {
  env.DB = env.DB || getDB(env);
  const url = new URL(request.url);

  const qRaw = url.searchParams.get("q") || "";
  const cleaned = cleanQuery(qRaw);
  const match = toFtsMatch(cleaned);

  const limit = 50;

  const cursorRaw = (url.searchParams.get("cursor") || "").trim();
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null;

  if (!match) {
    return Response.json(
      { results: [], next_cursor: null },
      { headers: { "cache-control": "public, max-age=30" } }
    );
  }

  const fts = (Number.isFinite(cursor) && cursor > 0)
    ? await env.DB.prepare(`
        SELECT rowid
        FROM video_fts
        WHERE video_fts MATCH ?
          AND rowid < ?
        ORDER BY rowid DESC
        LIMIT ?
      `).bind(match, cursor, limit).all()
    : await env.DB.prepare(`
        SELECT rowid
        FROM video_fts
        WHERE video_fts MATCH ?
        ORDER BY rowid DESC
        LIMIT ?
      `).bind(match, limit).all();

  const ids = (fts.results || []).map(r => r.rowid);
  if (!ids.length) {
    return Response.json(
      { results: [], next_cursor: null },
      { headers: { "cache-control": "public, max-age=30" } }
    );
  }

  const placeholders = ids.map(() => "?").join(",");
  const vids = await env.DB.prepare(`
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
    FROM videos AS v
    JOIN channels AS c
      ON c.id = v.channel_int
    WHERE v.id IN (${placeholders})
    ORDER BY v.id DESC
  `).bind(...ids).all();

  const results = (vids.results || []).map(v => ({
    video_id: v.video_id,
    title: v.title,
    published_at: v.published_at,
    video_kind: v.video_kind || "",
    duration_sec: v.duration_sec ?? null,
    channel_id: v.channel_id || null,
    channel_title: v.channel_title || null,
    channel_thumbnail_url: v.channel_thumbnail_url || null,
    cursor: String(v.id)
  }));

  const next_cursor = String(ids[ids.length - 1]);

  return Response.json(
    { results, next_cursor },
    { headers: { "cache-control": "public, max-age=30" } }
  );
}
