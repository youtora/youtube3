import { getDB } from "../_db.js";
import { parseJsonArray } from "../_shared/video-meta.js";

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
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

function mapSideVideo(r) {
  return {
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
  };
}

async function loadDiscoverVideos(env, current, limit) {
  const lang = String(current.language_code || "he").trim() || "he";
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
      FROM videos AS v INDEXED BY idx_videos_public_lang_latest_cover
      LEFT JOIN channels c
        ON c.id = v.channel_int
      WHERE v.netfree_status = 1
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
    bindValues.push(lang, band.anchorPub, band.minPub, current.id, perBand);
  }

  const rows = await env.DB.prepare(selectSql).bind(...bindValues).all();
  const seen = new Set();
  const out = [];

  for (const r of rows.results || []) {
    if (!r?.video_id || seen.has(r.video_id)) continue;
    seen.add(r.video_id);
    out.push(mapSideVideo(r, current));
    if (out.length >= limit) break;
  }

  return out.slice(0, limit);
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const video_id = (url.searchParams.get("video_id") || "").trim();
  if (!video_id) return new Response("missing video_id", { status: 400 });

  const recLimit = clamp(parseInt(url.searchParams.get("recommended_limit") || "10", 10) || 10, 1, 10);

  const vrow = await env.DB.prepare(`
    SELECT
      v.id,
      v.video_id,
      v.title,
      v.published_at,
      v.channel_int,
      v.video_kind,
      v.duration_sec,
      v.view_count,
      v.like_count,
      v.comment_count,
      v.language_code,
      d.description,
      d.tags_json,
      d.hashtags_json,
      d.fetched_at AS details_fetched_at,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url
    FROM videos v
    LEFT JOIN video_details d
      ON d.video_id = v.video_id
    LEFT JOIN channels c
      ON c.id = v.channel_int
    WHERE v.video_id = ?
      AND v.netfree_status = 1
    LIMIT 1
  `).bind(video_id).first();

  if (!vrow) return new Response("not found", { status: 404 });

  const video = {
    video_id: vrow.video_id,
    title: vrow.title,
    published_at: vrow.published_at,
    video_kind: vrow.video_kind || "",
    duration_sec: vrow.duration_sec ?? null,
    view_count: vrow.view_count ?? null,
    like_count: vrow.like_count ?? null,
    comment_count: vrow.comment_count ?? null,
    language_code: vrow.language_code || "",
    description: vrow.description || "",
    tags: parseJsonArray(vrow.tags_json),
    hashtags: parseJsonArray(vrow.hashtags_json),
    details_fetched_at: vrow.details_fetched_at ?? null,
    channel_id: vrow.channel_id || null,
    channel_title: vrow.channel_title || null,
    thumbnail_url: vrow.thumbnail_url || null
  };

  const recommended = await loadDiscoverVideos(env, vrow, recLimit);

  return Response.json(
    {
      video,
      recommended
    },
    {
      headers: {
        "cache-control": "public, max-age=300"
      }
    }
  );
}
