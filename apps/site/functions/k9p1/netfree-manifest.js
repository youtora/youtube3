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

function normalizeMode(value) {
  const mode = String(value || "ready").trim().toLowerCase();
  if (["pending", "0"].includes(mode)) return "pending";
  if (["recheck", "netfree_unchecked", "5"].includes(mode)) return "recheck";
  return "ready";
}

async function loadPending(DB, { limit, cutoff }) {
  if (limit <= 0) return [];

  const rows = await DB.prepare(`
    SELECT
      v.id,
      v.video_id,
      v.netfree_status AS s
    FROM videos v
    JOIN channels c ON c.id = v.channel_int
    WHERE v.netfree_status = 0
      AND v.netfree_discovered_at <= ?
      AND COALESCE(c.filter_policy, 0) NOT IN (5, 6)
      AND COALESCE(c.netfree_default_status, 0) <> 2
    ORDER BY v.netfree_discovered_at ASC, v.id ASC
    LIMIT ?
  `).bind(cutoff, limit).all();

  return rows.results || [];
}

async function loadRecheck(DB, { limit, t }) {
  if (limit <= 0) return [];

  const rows = await DB.prepare(`
    SELECT
      v.id,
      v.video_id,
      v.netfree_status AS s
    FROM videos v
    JOIN channels c ON c.id = v.channel_int
    WHERE v.netfree_status = 5
      AND v.netfree_recheck_after <= ?
      AND COALESCE(c.filter_policy, 0) NOT IN (5, 6)
      AND COALESCE(c.netfree_default_status, 0) <> 2
    ORDER BY v.netfree_recheck_after ASC, v.id ASC
    LIMIT ?
  `).bind(t, limit).all();

  return rows.results || [];
}

export async function onRequest({ env, request }) {
  try {
    if (request.method !== "GET") {
      return json({ ok: false, error: "use GET" }, 405);
    }

    const DB = getDB(env);
    const url = new URL(request.url);
    const t = nowSec();
    const limit = parsePositiveInt(url.searchParams.get("limit"), 5000, 1, 20000);
    const minAgeDays = parsePositiveInt(
      url.searchParams.get("min_age_days") || url.searchParams.get("min_pending_age_days"),
      7,
      0,
      365
    );
    const mode = normalizeMode(url.searchParams.get("mode") || url.searchParams.get("status"));
    const cutoff = t - (minAgeDays * 86400);

    let pending = [];
    let recheck = [];

    if (mode === "pending") {
      pending = await loadPending(DB, { limit, cutoff });
    } else if (mode === "recheck") {
      recheck = await loadRecheck(DB, { limit, t });
    } else {
      pending = await loadPending(DB, { limit, cutoff });
      recheck = pending.length < limit
        ? await loadRecheck(DB, { limit: limit - pending.length, t })
        : [];
    }

    const items = [...pending, ...recheck].map((row) => ({
      id: Number(row.id),
      video_id: String(row.video_id || ""),
      s: Number(row.s)
    })).filter((row) => row.id > 0 && /^[a-zA-Z0-9_-]{6,20}$/.test(row.video_id));

    return json({
      ok: true,
      compact: true,
      generated_at: t,
      mode,
      limit,
      min_pending_age_days: minAgeDays,
      counts: {
        pending_loaded: pending.length,
        recheck_loaded: recheck.length,
        total_loaded: items.length
      },
      items
    });
  } catch (error) {
    return json({
      ok: false,
      route: "/k9p1/netfree-manifest",
      error: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 2000)
    }, 500);
  }
}
