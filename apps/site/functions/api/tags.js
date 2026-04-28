import { getDB } from "../_db.js";
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name) || String(fallback), 10);
  return clamp(Number.isFinite(n) ? n : fallback, min, max);
}

function normalizeTagType(value) {
  return value === "hashtag" ? "hashtag" : "tag";
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const type = normalizeTagType((url.searchParams.get("type") || "tag").trim().toLowerCase());
  const limit = intParam(url, "limit", 200, 1, 300);
  const offset = intParam(url, "offset", 0, 0, 1000000);

  const res = await env.DB.prepare(`
    SELECT
      t.tag_norm,
      MIN(t.tag_value) AS tag_value,
      COUNT(*) AS video_count,
      MAX(v.published_at) AS latest_published_at
    FROM video_tags AS t
    JOIN videos AS v
      ON v.id = t.video_rowid
    WHERE t.tag_type = ?
    GROUP BY t.tag_norm
    ORDER BY video_count DESC, latest_published_at DESC, t.tag_norm ASC
    LIMIT ? OFFSET ?
  `).bind(type, limit, offset).all();

  const rows = res.results || [];
  const results = rows.map(row => ({
    value: row.tag_value || row.tag_norm || "",
    norm: row.tag_norm || "",
    video_count: row.video_count ?? 0,
    latest_published_at: row.latest_published_at ?? null
  }));

  return Response.json(
    {
      results,
      type,
      limit,
      offset,
      next_offset: rows.length >= limit ? offset + rows.length : null
    },
    { headers: { "cache-control": "public, max-age=300" } }
  );
}
