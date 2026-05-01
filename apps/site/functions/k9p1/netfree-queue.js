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
  ready: "ready",
  due: "ready",
  queue: "ready",
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
  public: 1,
  חסום: 2,
};

function normalizeStatus(raw, fallback = "ready") {
  const value = String(raw ?? fallback).trim().toLowerCase();
  if (value === "all") return { mode: "all", status: null };
  if (value === "ready" || value === "due" || value === "queue") return { mode: "ready", status: null };

  if (/^[0-5]$/.test(value)) {
    return { mode: "single", status: Number(value) };
  }

  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, value)) {
    const status = STATUS_MAP[value];
    if (status === "ready") return { mode: "ready", status: null };
    return { mode: "single", status };
  }

  return { mode: "ready", status: null };
}

function normalizeSort(raw) {
  const value = String(raw || "priority").trim().toLowerCase();
  if (["priority", "newest", "oldest", "checked_oldest"].includes(value)) return value;
  return "priority";
}

function discoveredExpr() {
  return "COALESCE(v.netfree_discovered_at, v.updated_at, v.published_at, 0)";
}

function dueWhereSql() {
  return `(
    (
      v.netfree_status = 0
      AND COALESCE(v.netfree_checked_at, 0) = 0
      AND ${discoveredExpr()} <= ?
    )
    OR (
      v.netfree_status = 5
      AND (
        v.netfree_recheck_after IS NULL
        OR v.netfree_recheck_after = 0
        OR v.netfree_recheck_after <= ?
      )
    )
  )`;
}

function priorityCaseSql() {
  return `CASE
      WHEN v.netfree_status = 0
        AND COALESCE(v.netfree_checked_at, 0) = 0
        AND ${discoveredExpr()} <= ? THEN 0
      WHEN v.netfree_status = 5
        AND (
          v.netfree_recheck_after IS NULL
          OR v.netfree_recheck_after = 0
          OR v.netfree_recheck_after <= ?
        ) THEN 1
      WHEN v.netfree_status = 3 THEN 2
      WHEN v.netfree_status = 2 THEN 3
      WHEN v.netfree_status = 4 THEN 4
      WHEN v.netfree_status = 1 THEN 5
      ELSE 9
    END`;
}

function orderBySql(sort) {
  const priorityCase = priorityCaseSql();

  if (sort === "newest") {
    return `ORDER BY ${priorityCase}, v.published_at DESC, v.id DESC`;
  }

  if (sort === "oldest") {
    return `ORDER BY ${priorityCase}, v.published_at ASC, v.id ASC`;
  }

  if (sort === "checked_oldest") {
    return `ORDER BY
      ${priorityCase},
      COALESCE(v.netfree_checked_at, 0) ASC,
      COALESCE(v.netfree_recheck_after, 0) ASC,
      v.published_at DESC,
      v.id DESC`;
  }

  return `ORDER BY
      ${priorityCase},
      CASE WHEN v.netfree_status = 0 THEN ${discoveredExpr()} ELSE NULL END ASC,
      CASE WHEN v.netfree_status = 5 THEN COALESCE(v.netfree_checked_at, 0) ELSE NULL END ASC,
      CASE WHEN v.netfree_status = 5 THEN COALESCE(v.netfree_recheck_after, 0) ELSE NULL END ASC,
      v.published_at DESC,
      v.id DESC`;
}

function rowQuery(whereSql, sort = "priority") {
  return `
    SELECT
      v.id,
      v.video_id,
      v.title,
      v.published_at,
      v.updated_at,
      v.video_kind,
      v.duration_sec,
      v.view_count,
      v.like_count,
      v.comment_count,
      v.stats_fetched_at,
      v.netfree_status,
      v.netfree_discovered_at,
      v.netfree_checked_at,
      v.netfree_recheck_after,
      v.netfree_check_attempts,
      v.netfree_last_error,
      v.netfree_claimed_at,
      v.netfree_claimed_by,
      c.id AS channel_int,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url AS channel_thumbnail_url,
      c.netfree_default_status,
      c.show_in_public_channels
    FROM videos v
    JOIN channels c ON c.id = v.channel_int
    ${whereSql}
    ${orderBySql(sort)}
    LIMIT ?
  `;
}

async function loadCounts(DB) {
  const t = nowSec();
  const weekAgo = t - (7 * 86400);

  const counts = await DB.prepare(`
    SELECT netfree_status, COUNT(*) AS count
    FROM videos
    GROUP BY netfree_status
    ORDER BY netfree_status
  `).all();

  const pendingReady = await DB.prepare(`
    SELECT COUNT(*) AS count
    FROM videos v
    WHERE v.netfree_status = 0
      AND COALESCE(v.netfree_checked_at, 0) = 0
      AND ${discoveredExpr()} <= ?
  `).bind(weekAgo).first();

  const pendingTooNew = await DB.prepare(`
    SELECT COUNT(*) AS count
    FROM videos v
    WHERE v.netfree_status = 0
      AND COALESCE(v.netfree_checked_at, 0) = 0
      AND ${discoveredExpr()} > ?
  `).bind(weekAgo).first();

  const recheckDue = await DB.prepare(`
    SELECT COUNT(*) AS count
    FROM videos
    WHERE netfree_status = 5
      AND (
        netfree_recheck_after IS NULL
        OR netfree_recheck_after = 0
        OR netfree_recheck_after <= ?
      )
  `).bind(t).first();

  const byChannel = await DB.prepare(`
    SELECT
      c.id,
      c.channel_id,
      c.title,
      c.netfree_default_status,
      c.show_in_public_channels,
      COUNT(v.id) AS pending_count
    FROM channels c
    JOIN videos v ON v.channel_int = c.id
    WHERE v.netfree_status IN (0, 5)
    GROUP BY c.id
    ORDER BY pending_count DESC, c.id DESC
    LIMIT 20
  `).all();

  return {
    by_status: counts.results || [],
    pending_ready_after_week: Number(pendingReady?.count || 0),
    pending_too_new: Number(pendingTooNew?.count || 0),
    recheck_due: Number(recheckDue?.count || 0),
    pending_by_channel: byChannel.results || []
  };
}

function addStatusWhere({ where, args, statusFilter, weekAgo, t }) {
  if (statusFilter.mode === "ready") {
    where.push(dueWhereSql());
    args.push(weekAgo, t);
    return;
  }

  if (statusFilter.mode === "single") {
    where.push("v.netfree_status = ?");
    args.push(statusFilter.status);
    return;
  }

  where.push("v.netfree_status IN (0, 1, 2, 3, 4, 5)");
}

function orderArgs(sort, weekAgo, t) {
  // בכל ORDER BY יש priorityCaseSql פעם אחת.
  return [weekAgo, t];
}

async function listQueue({ DB, url }) {
  const limit = parsePositiveInt(url.searchParams.get("limit"), 30, 1, 100);
  const statusFilter = normalizeStatus(url.searchParams.get("status") || "ready", "ready");
  const sort = normalizeSort(url.searchParams.get("sort"));
  const channelId = String(url.searchParams.get("channel_id") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim();
  const t = nowSec();
  const weekAgo = t - (7 * 86400);

  const where = [];
  const args = [];

  addStatusWhere({ where, args, statusFilter, weekAgo, t });

  if (channelId) {
    where.push("c.channel_id = ?");
    args.push(channelId);
  }

  if (q) {
    where.push("(v.title LIKE ? OR v.video_id LIKE ? OR c.title LIKE ? OR c.channel_id LIKE ?)");
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }

  const rows = await DB.prepare(rowQuery(`WHERE ${where.join(" AND ")}`, sort))
    .bind(...args, ...orderArgs(sort, weekAgo, t), limit)
    .all();

  return json({
    ok: true,
    status_filter: statusFilter.mode === "all" ? "all" : statusFilter.mode === "ready" ? "ready" : statusFilter.status,
    sort,
    limit,
    query: q,
    channel_id: channelId || null,
    min_pending_age_days: 7,
    counts: await loadCounts(DB),
    items: rows.results || []
  });
}

async function claimQueue({ DB, body }) {
  const limit = parsePositiveInt(body.limit, 10, 1, 50);
  const leaseSeconds = parsePositiveInt(body.lease_seconds, 1800, 60, 7200);
  const worker = String(body.worker || body.worker_id || "local-checker").trim().slice(0, 80) || "local-checker";
  const sort = normalizeSort(body.sort);
  const t = nowSec();
  const weekAgo = t - (7 * 86400);
  const staleBefore = t - leaseSeconds;

  const rows = await DB.prepare(`
    SELECT
      v.id,
      v.video_id,
      v.title,
      v.published_at,
      v.updated_at,
      v.video_kind,
      v.duration_sec,
      v.view_count,
      v.like_count,
      v.comment_count,
      v.stats_fetched_at,
      v.netfree_status,
      v.netfree_discovered_at,
      v.netfree_checked_at,
      v.netfree_recheck_after,
      v.netfree_check_attempts,
      v.netfree_last_error,
      v.netfree_claimed_at,
      v.netfree_claimed_by,
      c.id AS channel_int,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url AS channel_thumbnail_url,
      c.netfree_default_status,
      c.show_in_public_channels
    FROM videos v
    JOIN channels c ON c.id = v.channel_int
    WHERE ${dueWhereSql()}
      AND (
        v.netfree_claimed_at IS NULL
        OR v.netfree_claimed_at = 0
        OR v.netfree_claimed_at < ?
      )
    ${orderBySql(sort)}
    LIMIT ?
  `).bind(weekAgo, t, staleBefore, ...orderArgs(sort, weekAgo, t), limit).all();

  const items = rows.results || [];
  if (!items.length) {
    return json({
      ok: true,
      claimed: 0,
      worker,
      items: [],
      counts: await loadCounts(DB)
    });
  }

  const stmts = items.map((item) => DB.prepare(`
    UPDATE videos
    SET netfree_claimed_at = ?,
        netfree_claimed_by = ?
    WHERE video_id = ?
  `).bind(t, worker, item.video_id));

  await DB.batch(stmts);

  const ids = items.map((item) => item.video_id);
  const placeholders = ids.map(() => "?").join(",");
  const updatedRows = await DB.prepare(rowQuery(`WHERE v.video_id IN (${placeholders})`, sort))
    .bind(...ids, ...orderArgs(sort, weekAgo, t), ids.length)
    .all();

  return json({
    ok: true,
    claimed: items.length,
    worker,
    lease_seconds: leaseSeconds,
    sort,
    min_pending_age_days: 7,
    items: updatedRows.results || items,
    counts: await loadCounts(DB)
  });
}

export async function onRequest({ env, request }) {
  try {
    const DB = getDB(env);
    env.DB = DB;

    if (request.method === "GET") {
      return await listQueue({ DB, url: new URL(request.url) });
    }

    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const action = String(body.action || "").trim().toLowerCase();

      if (action === "claim") {
        return await claimQueue({ DB, body });
      }

      return json({ ok: false, error: "unsupported action" }, 400);
    }

    return json({ ok: false, error: "use GET or POST" }, 405);
  } catch (error) {
    return json({
      ok: false,
      route: "/k9p1/netfree-queue",
      error: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 2000)
    }, 500);
  }
}
