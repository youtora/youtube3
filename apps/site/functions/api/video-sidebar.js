import { getDB } from "../_db.js";
import { publicProviderFromRequest, publicVideoIndexName, publicVideoWhereSql } from "../_shared/filter-policy.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function normalizeTab(value) {
  const tab = String(value || "discover").trim().toLowerCase();
  return ["discover", "more", "popular", "playlists"].includes(tab) ? tab : "discover";
}

function normalizeVideoKind(value) {
  const kind = String(value || "V").trim().toUpperCase();
  return ["V", "S", "L"].includes(kind) ? kind : "V";
}

const DISCOVER_BANDS_DAYS = [
  [3, 21],
  [22, 90],
  [120, 270],
  [300, 540],
  [600, 1000]
];

function hashString(s) {
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return h >>> 0;
}

function makeDiscoverBands(videoId) {
  const now = Math.floor(Date.now() / 1000);
  const day = 60 * 60 * 24;

  // מתחלף פעם בשבוע: מספיק מגוון, ועדיין מתאים לקאש.
  const weekBucket = Math.floor(now / (day * 7));
  const keyBase = `${videoId || "video"}:${weekBucket}`;

  return DISCOVER_BANDS_DAYS.map(([minDays, maxDays], idx) => {
    const minAge = minDays * day;
    const maxAge = maxDays * day;
    const spread = Math.max(1, maxAge - minAge);
    const jump = hashString(`${keyBase}:${idx}`) % spread;
    const anchorPub = now - minAge - jump;
    const minPub = now - maxAge;

    return {
      part: idx + 1,
      minPub,
      anchorPub
    };
  });
}

function mapVideo(r, current) {
  return {
    video_id: r.video_id,
    title: r.title,
    published_at: r.published_at,
    video_kind: r.video_kind || "",
    duration_sec: r.duration_sec ?? null,
    view_count: r.view_count ?? null,
    like_count: r.like_count ?? null,
    comment_count: r.comment_count ?? null,
    channel_id: r.channel_id || current.channel_id || null,
    channel_title: r.channel_title || current.channel_title || null,
    channel_thumbnail_url: r.channel_thumbnail_url || current.thumbnail_url || null
  };
}

async function loadDiscoverVideos(env, current, limit, provider = "netfree") {
  const lang = String(current.language_code || "he").trim() || "he";
  const kind = normalizeVideoKind(current.video_kind);
  const discoverIndex = publicVideoIndexName(provider, "idx_videos_public_kind_lang_latest_cover", "idx_videos_etrog_kind_lang_latest_cover");
  const publicWhereSql = publicVideoWhereSql(provider, "v");
  const bands = makeDiscoverBands(current.video_id);
  const perBand = 2;

  const selectSql = bands.map((_, idx) => `
    SELECT *
    FROM (
      SELECT
        ${idx + 1} AS part,
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
      FROM videos AS v INDEXED BY ${discoverIndex}
      LEFT JOIN channels c
        ON c.id = v.channel_int
      WHERE ${publicWhereSql}
        AND v.video_kind = ?
        AND v.language_code = ?
        AND v.published_at <= ?
        AND v.published_at >= ?
        AND v.id <> ?
      ORDER BY v.published_at DESC, v.id DESC
      LIMIT ?
    )
  `).join("\nUNION ALL\n");

  const bindValues = [];
  for (const band of bands) {
    bindValues.push(kind, lang, band.anchorPub, band.minPub, current.id, perBand);
  }

  const rows = await env.DB.prepare(selectSql).bind(...bindValues).all();
  const seen = new Set();
  const out = [];

  for (const r of rows.results || []) {
    if (!r?.video_id || seen.has(r.video_id)) continue;
    seen.add(r.video_id);
    out.push(mapVideo(r, current));
    if (out.length >= limit) break;
  }

  return out.slice(0, limit);
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const provider = publicProviderFromRequest(request, url);

  const video_id = (url.searchParams.get("video_id") || "").trim();
  if (!video_id) return Response.json({ error: "missing video_id" }, { status: 400 });

  const tab = normalizeTab(url.searchParams.get("tab"));
  const limit = clamp(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 1, 10);

  const current = await env.DB.prepare(`
    SELECT
      v.id,
      v.video_id,
      v.channel_int,
      v.language_code,
      v.video_kind,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url
    FROM videos v
    LEFT JOIN channels c
      ON c.id = v.channel_int
    WHERE v.video_id = ?
      AND ${publicVideoWhereSql(provider, "v")}
    LIMIT 1
  `).bind(video_id).first();

  if (!current || !current.channel_int) return Response.json({ error: "not found" }, { status: 404 });

  const lang = String(current.language_code || "he").trim() || "he";
  const kind = normalizeVideoKind(current.video_kind);

  if (tab === "discover") {
    const videos = await loadDiscoverVideos(env, current, limit, provider);
    return Response.json(
      { tab, videos, provider },
      { headers: { "cache-control": "public, max-age=120" } }
    );
  }

  if (tab === "playlists") {
    const rows = await env.DB.prepare(`
      SELECT
        playlist_id,
        title,
        thumb_video_id,
        published_at,
        item_count
      FROM playlists
      WHERE channel_int = ?
      ORDER BY id DESC
      LIMIT ?
    `).bind(current.channel_int, limit).all();

    const playlists = (rows.results || []).map(r => ({
      playlist_id: r.playlist_id,
      title: r.title,
      thumb_video_id: r.thumb_video_id,
      published_at: r.published_at,
      item_count: r.item_count,
      channel_id: current.channel_id || null,
      channel_title: current.channel_title || null
    }));

    return Response.json(
      { tab, playlists, provider },
      { headers: { "cache-control": "public, max-age=120" } }
    );
  }

  const orderSql = tab === "popular"
    ? "IFNULL(view_count, 0) DESC, published_at DESC, id DESC"
    : "published_at DESC, id DESC";

  const indexName = tab === "popular"
    ? publicVideoIndexName(provider, "idx_videos_public_channel_kind_lang_views_cover", "idx_videos_etrog_channel_kind_lang_views_cover")
    : publicVideoIndexName(provider, "idx_videos_public_channel_kind_lang_latest_cover", "idx_videos_etrog_channel_kind_lang_latest_cover");

  const publicWhereSql = publicVideoWhereSql(provider, "videos");

  const rows = await env.DB.prepare(`
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
    FROM videos INDEXED BY ${indexName}
    WHERE channel_int = ?
      AND ${publicWhereSql}
      AND video_kind = ?
      AND video_id <> ?
      AND language_code = ?
    ORDER BY ${orderSql}
    LIMIT ?
  `).bind(current.channel_int, kind, video_id, lang, limit).all();

  return Response.json(
    {
      tab,
      videos: (rows.results || []).map(r => mapVideo(r, current))
    },
    { headers: { "cache-control": "public, max-age=120" } }
  );
}
