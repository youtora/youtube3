import { getDB } from "../_db.js";
import { normalizePublicLang } from "../_shared/language.js";
import { publicProviderFromRequest, publicVideoWhereSql } from "../_shared/filter-policy.js";
// functions/api/search.js
// Default: fast title-only FTS over video_fts.
// Optional mode: ?scope=all searches title + description/tags/hashtags.
// Optional kind filter:
//   kind=all  -> all video kinds
//   kind=V    -> regular videos
//   kind=S    -> shorts
//   kind=L    -> live

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

function normalizeSearchKind(value) {
  const kind = String(value || "all").trim().toUpperCase();
  if (kind === "V" || kind === "S" || kind === "L") return kind;
  return "all";
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);

  const qRaw = url.searchParams.get("q") || "";
  const cleaned = cleanQuery(qRaw);
  const match = toFtsMatch(cleaned);
  const scope = (url.searchParams.get("scope") || "title").trim().toLowerCase() === "all" ? "all" : "title";
  const lang = normalizePublicLang(url.searchParams.get("lang") || "he", "he");
  const kind = normalizeSearchKind(url.searchParams.get("kind"));
  const provider = publicProviderFromRequest(request, url);
  const publicWhereSql = publicVideoWhereSql(provider, "v");

  const kindSql = kind === "all" ? "" : "AND v.video_kind = ?";
  const kindBind = kind === "all" ? [] : [kind];

  const limit = 50;

  const cursorRaw = (url.searchParams.get("cursor") || "").trim();
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) : null;

  if (!match) {
    return Response.json(
      { results: [], next_cursor: null, scope, lang, kind, provider },
      { headers: { "cache-control": "public, max-age=30" } }
    );
  }

  let vids;

  if (scope === "all") {
    vids = (Number.isFinite(cursor) && cursor > 0)
      ? await env.DB.prepare(`
          WITH hits AS (
            SELECT rowid AS video_rowid
            FROM video_fts
            WHERE video_fts MATCH ?

            UNION

            SELECT v.id AS video_rowid
            FROM video_details_fts
            JOIN videos v
              ON v.video_id = video_details_fts.video_id
            WHERE video_details_fts MATCH ?
          )
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
          FROM hits h
          JOIN videos AS v
            ON v.id = h.video_rowid
          JOIN channels AS c
            ON c.id = v.channel_int
          WHERE ${publicWhereSql}
            AND v.language_code = ?
            ${kindSql}
            AND v.id < ?
          ORDER BY v.id DESC
          LIMIT ?
        `).bind(match, match, lang, ...kindBind, cursor, limit).all()
      : await env.DB.prepare(`
          WITH hits AS (
            SELECT rowid AS video_rowid
            FROM video_fts
            WHERE video_fts MATCH ?

            UNION

            SELECT v.id AS video_rowid
            FROM video_details_fts
            JOIN videos v
              ON v.video_id = video_details_fts.video_id
            WHERE video_details_fts MATCH ?
          )
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
          FROM hits h
          JOIN videos AS v
            ON v.id = h.video_rowid
          JOIN channels AS c
            ON c.id = v.channel_int
          WHERE ${publicWhereSql}
            AND v.language_code = ?
            ${kindSql}
          ORDER BY v.id DESC
          LIMIT ?
        `).bind(match, match, lang, ...kindBind, limit).all();
  } else {
    vids = (Number.isFinite(cursor) && cursor > 0)
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
          FROM video_fts f
          JOIN videos AS v
            ON v.id = f.rowid
          JOIN channels AS c
            ON c.id = v.channel_int
          WHERE video_fts MATCH ?
            AND ${publicWhereSql}
            AND v.language_code = ?
            ${kindSql}
            AND f.rowid < ?
          ORDER BY f.rowid DESC
          LIMIT ?
        `).bind(match, lang, ...kindBind, cursor, limit).all()
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
          FROM video_fts f
          JOIN videos AS v
            ON v.id = f.rowid
          JOIN channels AS c
            ON c.id = v.channel_int
          WHERE video_fts MATCH ?
            AND ${publicWhereSql}
            AND v.language_code = ?
            ${kindSql}
          ORDER BY f.rowid DESC
          LIMIT ?
        `).bind(match, lang, ...kindBind, limit).all();
  }

  const rows = vids.results || [];
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
    { results, next_cursor, scope, lang, kind, provider },
    { headers: { "cache-control": "public, max-age=30" } }
  );
}
