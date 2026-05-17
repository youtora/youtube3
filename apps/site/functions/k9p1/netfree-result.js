import { getDB } from "../_db.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function parsePositiveInt(value, fallback, min, max) {
  const n = parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const STATUS_MAP = {
  pending: 0,
  open: 1,
  blocked: 2,
  error: 3,
  unavailable: 4,
  netfree_unchecked: 5,
  unchecked_netfree: 5,
  not_checked_netfree: 5,
  netfree_pending: 5,
  recheck: 5,
  hidden: 0,
  public: 1
};

function normalizeStatus(raw) {
  const value = String(raw ?? "").trim().toLowerCase();

  if (/^[0-5]$/.test(value)) return Number(value);

  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, value)) {
    return STATUS_MAP[value];
  }

  return null;
}

function normalizeVideoIds(body) {
  const ids = [];

  if (body.video_id) ids.push(body.video_id);
  if (Array.isArray(body.video_ids)) ids.push(...body.video_ids);

  return [...new Set(ids
    .map((id) => String(id || "").trim())
    .filter((id) => /^[a-zA-Z0-9_-]{6,20}$/.test(id))
  )];
}

function statusName(status) {
  switch (Number(status)) {
    case 0: return "pending";
    case 1: return "open";
    case 2: return "blocked";
    case 3: return "error";
    case 4: return "unavailable";
    case 5: return "netfree_unchecked";
    default: return "unknown";
  }
}


async function revealOpenChannels(DB, videoIds, status) {
  if (Number(status) !== 1 || !videoIds.length) return 0;

  const placeholders = videoIds.map(() => "?").join(",");
  const result = await DB.prepare(`
    UPDATE channels
    SET show_in_public_channels = 1
    WHERE show_in_public_channels <> 1
      AND id IN (
        SELECT DISTINCT channel_int
        FROM videos
        WHERE video_id IN (${placeholders})
          AND netfree_status = 1
      )
  `).bind(...videoIds).run();

  return Number(result?.meta?.changes || result?.changes || 0);
}

function getRecheckAfter(body, status, t) {
  if (Number(status) !== 5) return null;

  const explicit = parseInt(String(body.netfree_recheck_after || body.recheck_after || ""), 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const days = parsePositiveInt(body.recheck_after_days, 14, 1, 365);
  return t + (days * 86400);
}

export async function onRequest({ env, request }) {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "use POST" }, 405);
    }

    const DB = getDB(env);
    const body = await request.json().catch(() => ({}));
    const status = normalizeStatus(body.status);
    const videoIds = normalizeVideoIds(body);
    const t = nowSec();
    const recheckAfter = getRecheckAfter(body, status, t);

    if (status == null) {
      return json({ ok: false, error: "invalid status. use 0/1/2/3/4/5 or pending/open/blocked/error/unavailable/netfree_unchecked" }, 400);
    }

    if (!videoIds.length) {
      return json({ ok: false, error: "missing video_id or video_ids" }, 400);
    }

    const stmts = videoIds.map((videoId) => DB.prepare(`
      UPDATE videos
      SET
        netfree_status = ?,
        netfree_recheck_after = ?,
        etrog_visible = CASE
          WHEN ? = 4 THEN 0
          WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 1 THEN 1
          WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 2 THEN 1
          WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 3 AND ? <> 2 THEN 1
          WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 4 AND ? = 1 THEN 1
          WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 5 THEN 1
          WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 6 AND ? = 1 THEN 1
          ELSE 0
        END,
        netfree_discovered_at = CASE
          WHEN ? = 0 THEN ?
          ELSE COALESCE(netfree_discovered_at, updated_at, published_at, ?)
        END
      WHERE video_id = ?
        AND netfree_status <> ?
    `).bind(status, recheckAfter, status, status, status, status, status, t, t, videoId, status));

    const result = await DB.batch(stmts);
    const revealed_channels = await revealOpenChannels(DB, videoIds, status);

    const placeholders = videoIds.map(() => "?").join(",");
    const rows = await DB.prepare(`
      SELECT
        v.id,
        v.video_id,
        v.title,
        v.published_at,
        v.updated_at,
        v.view_count,
        v.like_count,
        v.comment_count,
        v.netfree_status,
        v.netfree_discovered_at,
        v.netfree_recheck_after,
        c.channel_id,
        c.title AS channel_title
      FROM videos v
      JOIN channels c ON c.id = v.channel_int
      WHERE v.video_id IN (${placeholders})
      ORDER BY v.published_at DESC, v.id DESC
    `).bind(...videoIds).all();

    return json({
      ok: true,
      status,
      status_name: statusName(status),
      recheck_after: recheckAfter,
      requested: videoIds.length,
      changed: result?.meta?.changes || 0,
      revealed_channels,
      items: rows.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      route: "/k9p1/netfree-result",
      error: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 2000)
    }, 500);
  }
}
