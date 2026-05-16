import { getDB } from "../_db.js";
import { normalizePublicLang } from "../_shared/language.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name) || String(fallback), 10);
  return clamp(Number.isFinite(n) ? n : fallback, min, max);
}

function normalizeSort(value) {
  const sort = String(value || "latest").trim().toLowerCase();
  return sort === "views" ? "views" : "latest";
}

// latest cursor format: "<published_at>:<id>"
// views cursor format:  "<view_count>:<published_at>:<id>"
function parseCursor(raw, sort) {
  const s = (raw || "").trim();
  if (!s) return { views: null, p: null, id: null };

  const parts = s.split(":");

  if (sort === "views") {
    if (parts.length !== 3) return { views: null, p: null, id: null };

    const views = parseInt(parts[0] || "0", 10);
    const p = parseInt(parts[1] || "0", 10);
    const id = parseInt(parts[2] || "0", 10);

    if (!Number.isFinite(views) || !Number.isFinite(p) || !Number.isFinite(id) || id <= 0) {
      return { views: null, p: null, id: null };
    }

    return { views, p, id };
  }

  if (parts.length !== 2) return { views: null, p: null, id: null };

  const p = parseInt(parts[0] || "0", 10);
  const id = parseInt(parts[1] || "0", 10);

  if (!Number.isFinite(p) || !Number.isFinite(id) || id <= 0) {
    return { views: null, p: null, id: null };
  }

  return { views: null, p, id };
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

function normalizeVideoKind(value) {
  const kind = String(value || "V").trim().toUpperCase();
  return (kind === "S" || kind === "L") ? kind : "V";
}

function sortParts(sort) {
  if (sort === "views") {
    return {
      index: "idx_videos_public_kind_lang_views",
      minViewsSql: "AND v.view_count >= 2000",
      cursorSql: "AND (v.view_count, v.published_at, v.id) < (?, ?, ?)",
      orderSql: "v.view_count DESC, v.published_at DESC, v.id DESC"
    };
  }

  return {
    index: "idx_videos_public_kind_lang_latest_cover",
    minViewsSql: "",
    cursorSql: "AND (v.published_at, v.id) < (?, ?)",
    orderSql: "v.published_at DESC, v.id DESC"
  };
}

function dbVideoKind(kind) {
  return kind;
}

function selectSql({ kind, sort, cursor }) {
  const parts = sortParts(sort);
  const cursorSql = cursor ? parts.cursorSql : "";

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
    FROM videos AS v INDEXED BY ${parts.index}
    JOIN channels AS c
      ON c.id = v.channel_int
    WHERE v.netfree_status = 1
      AND v.video_kind = ?
      AND v.language_code = ?
      ${parts.minViewsSql}
      ${cursorSql}
    ORDER BY ${parts.orderSql}
    LIMIT ?
  `;
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);

  const limit = intParam(url, "limit", 24, 1, 50);
  const lang = normalizePublicLang(url.searchParams.get("lang") || "he", "he");
  const sort = normalizeSort(url.searchParams.get("sort") || "latest");

  const kind = normalizeVideoKind(url.searchParams.get("kind"));

  const { views: cursorViews, p: cursorP, id: cursorId } = parseCursor(
    url.searchParams.get("cursor") || "",
    sort
  );
  const hasCursor = cursorP !== null && cursorId !== null && (sort !== "views" || cursorViews !== null);

  const binds = [dbVideoKind(kind), lang];
  if (hasCursor) {
    if (sort === "views") binds.push(cursorViews, cursorP, cursorId);
    else binds.push(cursorP, cursorId);
  }
  binds.push(limit);

  const rows = await env.DB.prepare(selectSql({ kind, sort, cursor: hasCursor }))
    .bind(...binds)
    .all();

  const vrows = rows.results || [];
  const videos = vrows.map(mapVideoRow);

  const last = vrows[vrows.length - 1];
  const next_cursor =
    vrows.length >= limit && last
      ? sort === "views"
        ? `${last.view_count ?? 0}:${last.published_at ?? 0}:${last.id}`
        : `${last.published_at ?? 0}:${last.id}`
      : null;

  return Response.json(
    { videos, next_cursor, lang, sort },
    { headers: { "cache-control": "public, max-age=60" } }
  );
}
