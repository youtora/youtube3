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
  public: 1,
  חסום: 2,
};

function normalizeStatus(raw, fallback = "pending") {
  const value = String(raw ?? fallback).trim().toLowerCase();
  if (value === "all") return { mode: "all", status: null };

  if (/^[0-5]$/.test(value)) {
    return { mode: "single", status: Number(value) };
  }

  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, value)) {
    return { mode: "single", status: STATUS_MAP[value] };
  }

  return { mode: "single", status: STATUS_MAP[fallback] };
}

function normalizeSort(raw) {
  const value = String(raw || "popular").trim().toLowerCase();
  if (["popular", "newest", "oldest", "retry"].includes(value)) return value;
  return "popular";
}

function orderBySql(sort) {
  const statusPriority = `
      CASE v.netfree_status
        WHEN 0 THEN 0
        WHEN 5 THEN 1
        WHEN 3 THEN 2
        WHEN 2 THEN 3
        WHEN 4 THEN 4
        WHEN 1 THEN 5
        ELSE 9
      END`;

  if (sort === "newest") {
    return `ORDER BY ${statusPriority}, v.published_at DESC, v.id DESC`;
  }

  if (sort === "oldest") {
    return `ORDER BY ${statusPriority}, v.published_at ASC, v.id ASC`;
  }

  if (sort === "retry") {
    return `ORDER BY
      ${statusPriority},
      COALESCE(v.netfree_recheck_after, 0) ASC,
      v.netfree_check_attempts ASC,
      COALESCE(v.view_count, 0) DESC,
      v.published_at DESC,
      v.id DESC`;
  }

  return `ORDER BY
      ${statusPriority},
      COALESCE(v.view_count, 0) DESC,
      COALESCE(v.like_count, 0) DESC,
      COALESCE(v.comment_count, 0) DESC,
      v.published_at DESC,
      v.id DESC`;
}

function rowQuery(whereSql, sort = "popular") {
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
      v.stats_fetched_at,
      v.netfree_status,
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

  const counts = await DB.prepare(`
    SELECT netfree_status, COUNT(*) AS count
    FROM videos
    GROUP BY netfree_status
    ORDER BY netfree_status
  `).all();

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
    recheck_due: Number(recheckDue?.count || 0),
    pending_by_channel: byChannel.results || []
  };
}

async function listQueue({ DB, url }) {
  const limit = parsePositiveInt(url.searchParams.get("limit"), 30, 1, 100);
  const statusFilter = normalizeStatus(url.searchParams.get("status") || "pending", "pending");
  const sort = normalizeSort(url.searchParams.get("sort"));
  const channelId = String(url.searchParams.get("channel_id") || "").trim();
  const q = String(url.searchParams.get("q") || "").trim();

  const where = [];
  const args = [];

  if (statusFilter.mode === "single") {
    where.push("v.netfree_status = ?");
    args.push(statusFilter.status);
  } else {
    where.push("v.netfree_status IN (0, 1, 2, 3, 4, 5)");
  }

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
    .bind(...args, limit)
    .all();

  return json({
    ok: true,
    status_filter: statusFilter.mode === "all" ? "all" : statusFilter.status,
    sort,
    limit,
    query: q,
    channel_id: channelId || null,
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
  const staleBefore = t - leaseSeconds;

  const rows = await DB.prepare(`
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
      v.stats_fetched_at,
      v.netfree_status,
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
    WHERE (
        v.netfree_status IN (0, 3)
        OR (
          v.netfree_status = 5
          AND (
            v.netfree_recheck_after IS NULL
            OR v.netfree_recheck_after = 0
            OR v.netfree_recheck_after <= ?
          )
        )
      )
      AND (
        v.netfree_claimed_at IS NULL
        OR v.netfree_claimed_at = 0
        OR v.netfree_claimed_at < ?
      )
    ${orderBySql(sort)}
    LIMIT ?
  `).bind(t, staleBefore, limit).all();

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
    .bind(...ids, ids.length)
    .all();

  return json({
    ok: true,
    claimed: items.length,
    worker,
    lease_seconds: leaseSeconds,
    sort,
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
