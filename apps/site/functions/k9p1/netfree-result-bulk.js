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

function normalizeResult(raw) {
  const id = Number(raw?.id || 0);
  const videoId = String(raw?.video_id || raw?.v || "").trim();
  const status = Number(raw?.status ?? raw?.s);

  if (!Number.isInteger(id) || id <= 0) return null;
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(videoId)) return null;
  if (!Number.isInteger(status) || status < 0 || status > 5) return null;

  return { id, video_id: videoId, status };
}

function uniqueResults(results) {
  const map = new Map();
  for (const item of results) {
    const row = normalizeResult(item);
    if (!row) continue;
    map.set(row.id, row);
  }
  return [...map.values()];
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}


async function revealOpenChannels(DB, items) {
  const openItems = items.filter((item) => item.status === 1);
  if (!openItems.length) return 0;

  let changed = 0;
  for (const part of chunks(openItems, 100)) {
    const idPlaceholders = part.map(() => "?").join(",");
    const videoCase = part.map(() => "WHEN ? THEN ?").join(" ");
    const ids = [];
    const videoBinds = [];

    for (const item of part) {
      ids.push(item.id);
      videoBinds.push(item.id, item.video_id);
    }

    const result = await DB.prepare(`
      UPDATE channels
      SET show_in_public_channels = 1
      WHERE show_in_public_channels <> 1
        AND id IN (
          SELECT DISTINCT channel_int
          FROM videos
          WHERE id IN (${idPlaceholders})
            AND video_id = CASE id ${videoCase} ELSE video_id END
            AND netfree_status = 1
        )
    `).bind(...ids, ...videoBinds).run();

    changed += Number(result?.meta?.changes || result?.changes || 0);
  }

  return changed;
}

async function updateChunk(DB, items, { recheckDays, t }) {
  const statusCase = items.map(() => "WHEN ? THEN ?").join(" ");
  const recheckCase = items.map(() => "WHEN ? THEN ?").join(" ");
  const videoCase = items.map(() => "WHEN ? THEN ?").join(" ");
  const whereStatusCase = items.map(() => "WHEN ? THEN ?").join(" ");
  const idPlaceholders = items.map(() => "?").join(",");

  const statusBinds = [];
  const recheckBinds = [];
  const ids = [];
  const videoBinds = [];
  const whereStatusBinds = [];

  for (const item of items) {
    const recheckAfter = item.status === 5 ? t + (recheckDays * 86400) : null;
    statusBinds.push(item.id, item.status);
    recheckBinds.push(item.id, recheckAfter);
    ids.push(item.id);
    videoBinds.push(item.id, item.video_id);
    whereStatusBinds.push(item.id, item.status);
  }

  const result = await DB.prepare(`
    UPDATE videos
    SET
      netfree_status = CASE id ${statusCase} ELSE netfree_status END,
      netfree_recheck_after = CASE id ${recheckCase} ELSE netfree_recheck_after END
    WHERE id IN (${idPlaceholders})
      AND video_id = CASE id ${videoCase} ELSE video_id END
      AND netfree_status <> CASE id ${whereStatusCase} ELSE netfree_status END
  `).bind(
    ...statusBinds,
    ...recheckBinds,
    ...ids,
    ...videoBinds,
    ...whereStatusBinds
  ).run();

  await DB.prepare(`
    UPDATE videos
    SET etrog_visible = CASE
      WHEN netfree_status = 4 THEN 0
      WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 1 THEN 1
      WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 2 THEN 1
      WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 3 AND netfree_status <> 2 THEN 1
      WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 4 AND netfree_status = 1 THEN 1
      WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 5 THEN 1
      WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 6 AND netfree_status = 1 THEN 1
      ELSE 0
    END
    WHERE id IN (${idPlaceholders})
      AND video_id = CASE id ${videoCase} ELSE video_id END
  `).bind(...ids, ...videoBinds).run();

  return Number(result?.meta?.changes || result?.changes || 0);
}

export async function onRequest({ env, request }) {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "use POST" }, 405);
    }

    const DB = getDB(env);
    const body = await request.json().catch(() => ({}));
    const t = nowSec();
    const recheckDays = parsePositiveInt(body.recheck_after_days, 14, 1, 365);
    const maxResults = parsePositiveInt(body.max_results, 1000, 1, 2000);
    const validResults = uniqueResults(Array.isArray(body.results) ? body.results : []).slice(0, maxResults);

    if (!validResults.length) {
      return json({ ok: false, error: "missing valid results[]" }, 400);
    }

    let changed = 0;
    for (const part of chunks(validResults, 100)) {
      changed += await updateChunk(DB, part, { recheckDays, t });
    }

    const revealed_channels = await revealOpenChannels(DB, validResults);

    return json({
      ok: true,
      requested: Array.isArray(body.results) ? body.results.length : 0,
      accepted: validResults.length,
      changed,
      revealed_channels,
      skipped_same_status: validResults.length - changed,
      recheck_after_days: recheckDays
    });
  } catch (error) {
    return json({
      ok: false,
      route: "/k9p1/netfree-result-bulk",
      error: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 2000)
    }, 500);
  }
}
