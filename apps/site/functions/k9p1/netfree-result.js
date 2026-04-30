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

  if (/^[0-5]$/.test(value)) {
    return Number(value);
  }

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
    env.DB = DB;

    const body = await request.json().catch(() => ({}));
    const status = normalizeStatus(body.status);
    const videoIds = normalizeVideoIds(body);
    const t = nowSec();
    const recheckAfter = getRecheckAfter(body, status, t);
    const defaultError = Number(status) === 5 ? "נטפרי עדיין לא בדקו - לבדיקה חוזרת" : "";
    const error = String(body.error || body.netfree_last_error || defaultError).trim().slice(0, 500);

    if (status == null) {
      return json({ ok: false, error: "invalid status. use 0/1/2/3/4/5 or pending/open/blocked/error/unavailable/netfree_unchecked" }, 400);
    }

    if (!videoIds.length) {
      return json({ ok: false, error: "missing video_id or video_ids" }, 400);
    }

    const stmts = videoIds.map((videoId) => DB.prepare(`
      UPDATE videos
      SET netfree_status = ?,
          netfree_checked_at = ?,
          netfree_recheck_after = ?,
          netfree_check_attempts = netfree_check_attempts + 1,
          netfree_last_error = ?,
          netfree_claimed_at = NULL,
          netfree_claimed_by = ''
      WHERE video_id = ?
    `).bind(status, t, recheckAfter, error, videoId));

    const result = await DB.batch(stmts);

    const placeholders = videoIds.map(() => "?").join(",");
    const rows = await DB.prepare(`
      SELECT
        v.video_id,
        v.title,
        v.published_at,
        v.view_count,
        v.like_count,
        v.comment_count,
        v.netfree_status,
        v.netfree_checked_at,
        v.netfree_recheck_after,
        v.netfree_check_attempts,
        v.netfree_last_error,
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
