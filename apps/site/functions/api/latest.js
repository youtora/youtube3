import { getDB } from "../_db.js";
import { normalizePublicLang } from "../_shared/language.js";

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

function mapVideoRow(r) {
  return {
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    video_kind: r.video_kind || "",
    duration_sec: r.duration_sec ?? null,
    view_count: r.view_count ?? null,
    like_count: r.like_count ?? null,
    comment_count: r.comment_count ?? null,
    language_code: r.language_code || "",
    language_source: r.language_source || "",
    channel_id: r.channel_id || null,
    channel_title: r.channel_title || null,
    channel_thumbnail_url: r.channel_thumbnail_url || null
  };
}

function selectSql({ kind, cursor }) {
  const cursorSql = cursor ? "AND (v.published_at, v.id) < (?, ?)" : "";
  const kindSql = kind ? "AND v.video_kind = ?" : "";
  const indexName = kind ? "idx_videos_public_kind_lang_latest_cover" : "idx_videos_public_lang_latest_cover";

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
      v.language_code,
      v.language_source,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url AS channel_thumbnail_url
    FROM videos AS v INDEXED BY ${indexName}
    JOIN channels AS c
      ON c.id = v.channel_int
    WHERE v.netfree_status = 1
      AND v.language_code = ?
      ${kindSql}
      ${cursorSql}
    ORDER BY v.published_at DESC, v.id DESC
    LIMIT ?
  `;
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);

  const limit = intParam(url, "limit", 24, 1, 50);
  const lang = normalizePublicLang(url.searchParams.get("lang") || "he", "he");

  const kindRaw = (url.searchParams.get("kind") || "").trim().toUpperCase();
  const kind = (kindRaw === "S" || kindRaw === "L") ? kindRaw : null;

  const { p: cursorP, id: cursorId } = parseCursor(
    url.searchParams.get("cursor") || ""
  );
  const hasCursor = cursorP !== null && cursorId !== null;

  const binds = [lang];
  if (kind) binds.push(kind);
  if (hasCursor) binds.push(cursorP, cursorId);
  binds.push(limit);

  const rows = await env.DB.prepare(selectSql({ kind, cursor: hasCursor }))
    .bind(...binds)
    .all();

  const vrows = rows.results || [];
  const videos = vrows.map(mapVideoRow);

  const last = vrows[vrows.length - 1];
  const next_cursor =
    vrows.length >= limit && last
      ? `${last.published_at ?? 0}:${last.id}`
      : null;

  return Response.json(
    { videos, next_cursor, lang },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
