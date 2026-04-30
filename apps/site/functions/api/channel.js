import { getDB } from "../_db.js";
import { normalizePublicLang } from "../_shared/language.js";
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function intParam(url, name, fallback, min, max) {
  const n = parseInt(url.searchParams.get(name) || String(fallback), 10);
  return clamp(Number.isFinite(n) ? n : fallback, min, max);
}

// cursor format: "<published_or_0>:<row_id>"
function parseCursor(raw) {
  const s = (raw || "").trim();
  if (!s) return { p: null, id: 0 };

  const [pStr, idStr] = s.split(":");
  const p = parseInt(pStr || "0", 10);
  const id = parseInt(idStr || "0", 10);

  if (!Number.isFinite(p) || !Number.isFinite(id)) return { p: null, id: 0 };
  if (id <= 0) return { p: null, id: 0 };

  return { p, id };
}

function parseJson(value, fallback) {
  try { return JSON.parse(value || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function channelSelect(includeFull) {
  return includeFull
    ? `
        SELECT
          id, channel_id, title, thumbnail_url,
          description, custom_url, published_at, country, default_language,
          localized_title, localized_description, banner_url,
          branding_title, branding_description, branding_keywords,
          branding_default_language, branding_country, unsubscribed_trailer,
          topic_categories_json, topic_ids_json, localizations_json,
          language_code, language_source, languages_json,
          channel_meta_fetched_at, channel_meta_error
        FROM channels
        WHERE channel_id = ?
      `
    : `
        SELECT id, channel_id, title, thumbnail_url, language_code, languages_json
        FROM channels
        WHERE channel_id = ?
      `;
}

function videosSql({ kind, hasCursor }) {
  const cursorSql = hasCursor ? "AND (published_at, id) < (?, ?)" : "";

  if (kind) {
    return `
      SELECT id, video_id, title, published_at, video_kind, duration_sec, view_count, like_count, comment_count, language_code, language_source
      FROM videos INDEXED BY idx_videos_channel_kind_lang_latest_cover
      WHERE channel_int = ?
        AND video_kind = ?
        AND language_code = ?
        ${cursorSql}
      ORDER BY published_at DESC, id DESC
      LIMIT ?
    `;
  }

  return `
    SELECT id, video_id, title, published_at, video_kind, duration_sec, view_count, like_count, comment_count, language_code, language_source
    FROM videos INDEXED BY idx_videos_channel_lang_latest_cover
    WHERE channel_int = ?
      AND language_code = ?
      ${cursorSql}
    ORDER BY published_at DESC, id DESC
    LIMIT ?
  `;
}

function mapVideo(r) {
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
    language_source: r.language_source || ""
  };
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);

  const channel_id = (url.searchParams.get("channel_id") || "").trim();
  if (!channel_id) return new Response("missing channel_id", { status: 400 });

  const include_channel = url.searchParams.get("include_channel") !== "0";
  const include_playlists = url.searchParams.get("include_playlists") !== "0";
  const include_videos = url.searchParams.get("include_videos") !== "0";
  const lang = normalizePublicLang(url.searchParams.get("lang") || "he", "he");

  const kindRaw = (url.searchParams.get("kind") || "").trim().toUpperCase();
  const kind = (kindRaw === "S" || kindRaw === "L") ? kindRaw : null;

  const videos_limit = intParam(url, "videos_limit", 24, 1, 50);

  const videos_cursor_raw =
    url.searchParams.get("videos_cursor") ||
    url.searchParams.get("cursor") || "";

  const { p: cursorP, id: cursorId } = parseCursor(videos_cursor_raw);
  const hasCursor = cursorP !== null && cursorId > 0;

  const chRow = await env.DB.prepare(channelSelect(include_channel || include_playlists))
    .bind(channel_id)
    .first();

  if (!chRow) return new Response("not found", { status: 404 });

  const out = { lang };

  if (include_channel) {
    out.channel = {
      channel_id: chRow.channel_id,
      title: chRow.title,
      thumbnail_url: chRow.thumbnail_url,
      description: chRow.description || "",
      custom_url: chRow.custom_url || "",
      published_at: chRow.published_at ?? null,
      country: chRow.country || "",
      default_language: chRow.default_language || "",
      localized_title: chRow.localized_title || "",
      localized_description: chRow.localized_description || "",
      banner_url: chRow.banner_url || "",
      language_code: chRow.language_code || "",
      language_source: chRow.language_source || "",
      languages: parseJson(chRow.languages_json || "[]", []),
      branding: {
        title: chRow.branding_title || "",
        description: chRow.branding_description || "",
        keywords: chRow.branding_keywords || "",
        default_language: chRow.branding_default_language || "",
        country: chRow.branding_country || "",
        unsubscribed_trailer: chRow.unsubscribed_trailer || "",
      },
      topic_categories: parseJson(chRow.topic_categories_json || "[]", []),
      topic_ids: parseJson(chRow.topic_ids_json || "[]", []),
      localizations: parseJson(chRow.localizations_json || "{}", {}),
      channel_meta_fetched_at: chRow.channel_meta_fetched_at ?? null,
      channel_meta_error: chRow.channel_meta_error || "",
    };
  }

  if (include_playlists) {
    const plLimit = intParam(url, "playlists_limit", 50, 1, 200);

    const pls = await env.DB.prepare(`
      SELECT playlist_id, title, thumb_video_id, published_at, item_count
      FROM playlists
      WHERE channel_int = ?
      ORDER BY id DESC
      LIMIT ?
    `).bind(chRow.id, plLimit).all();

    out.playlists = pls.results || [];
  }

  if (include_videos) {
    const binds = [chRow.id];
    if (kind) binds.push(kind);
    binds.push(lang);
    if (hasCursor) binds.push(cursorP, cursorId);
    binds.push(videos_limit);

    const vids = await env.DB.prepare(videosSql({ kind, hasCursor }))
      .bind(...binds)
      .all();

    const rows = vids.results || [];
    out.videos = rows.map(mapVideo);

    const last = rows[rows.length - 1];
    out.videos_next_cursor =
      rows.length >= videos_limit && last
        ? `${last.published_at ?? 0}:${last.id}`
        : null;
  }

  return Response.json(out, {
    headers: {
      "cache-control": "public, max-age=30"
    }
  });
}
