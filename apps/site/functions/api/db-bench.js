import { getDB } from "../_db.js";

function calcStats(values) {
  const sorted = [...values].sort((a, b) => a - b);

  if (!sorted.length) {
    return null;
  }

  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    avg: Math.round((sum / sorted.length) * 100) / 100,
    median: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100
  };
}

async function measure(label, fn) {
  const started = performance.now();

  try {
    const result = await fn();
    const ended = performance.now();

    return {
      label,
      ok: true,
      ms: Math.round((ended - started) * 100) / 100,
      result
    };
  } catch (error) {
    const ended = performance.now();

    return {
      label,
      ok: false,
      ms: Math.round((ended - started) * 100) / 100,
      error: String(error && error.message ? error.message : error)
    };
  }
}

async function runAll(DB, sql, args = []) {
  const res = await DB.prepare(sql).bind(...args).all();
  return res?.results || [];
}

async function benchQuery(DB, label, sql, args, samples) {
  const times = [];
  let lastRows = 0;
  let lastError = null;

  for (let i = 0; i < samples; i++) {
    const measured = await measure(label, async () => {
      const rows = await runAll(DB, sql, args);
      return {
        rows: rows.length
      };
    });

    times.push(measured.ms);

    if (measured.ok) {
      lastRows = measured.result.rows;
    } else {
      lastError = measured.error;
    }
  }

  return {
    label,
    stats_ms: calcStats(times),
    rows: lastRows,
    error: lastError
  };
}

async function explainQuery(DB, sql, args = []) {
  const measured = await measure("explain", async () => {
    return await runAll(DB, `EXPLAIN QUERY PLAN ${sql}`, args);
  });

  return measured;
}

export async function onRequest({ env, request }) {
  const token = request.headers.get("x-debug-token");

  if (!env.DEBUG_TOKEN || token !== env.DEBUG_TOKEN) {
    return new Response("Not found", {
      status: 404
    });
  }

  const DB = getDB(env);
  const url = new URL(request.url);

  const samples = Math.min(
    Math.max(parseInt(url.searchParams.get("n") || "10", 10), 1),
    30
  );

  const channelId = (url.searchParams.get("channel_id") || "").trim();

  const latestSql = `
    SELECT
      v.id,
      v.video_id,
      v.title,
      v.published_at,
      v.video_kind,
      v.duration_sec,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url AS channel_thumbnail_url
    FROM videos AS v INDEXED BY idx_videos_public_kind_lang_latest_cover
    JOIN channels AS c
      ON c.id = v.channel_int
    WHERE v.netfree_status = 1
      AND v.video_kind = ?
      AND v.language_code = ?
    ORDER BY v.published_at DESC, v.id DESC
    LIMIT ?
  `;

  const kindSql = `
    SELECT
      v.id,
      v.video_id,
      v.title,
      v.published_at,
      v.video_kind,
      v.duration_sec,
      c.channel_id,
      c.title AS channel_title,
      c.thumbnail_url AS channel_thumbnail_url
    FROM videos AS v INDEXED BY idx_videos_public_kind_lang_latest_cover
    JOIN channels AS c
      ON c.id = v.channel_int
    WHERE v.netfree_status = 1
      AND v.video_kind = ?
      AND v.language_code = ?
    ORDER BY v.published_at DESC, v.id DESC
    LIMIT ?
  `;

  const channelLookupSql = `
    SELECT id, channel_id, title, thumbnail_url
    FROM channels
    WHERE channel_id = ?
    LIMIT 1
  `;

  const channelVideosSql = `
    SELECT id, video_id, title, published_at, video_kind, duration_sec
    FROM videos INDEXED BY idx_videos_public_channel_kind_lang_latest_cover
    WHERE channel_int = ?
      AND netfree_status = 1
      AND video_kind = ?
      AND language_code = ?
    ORDER BY published_at DESC, id DESC
    LIMIT ?
  `;

  const results = [];

  results.push(
    await benchQuery(DB, "SELECT 1", "SELECT 1 AS ok", [], samples)
  );

  results.push(
    await benchQuery(DB, "latest regular videos", latestSql, ["V", "he", 200], samples)
  );

  results.push(
    await benchQuery(DB, "shorts videos", kindSql, ["S", "he", 200], samples)
  );

  results.push(
    await benchQuery(DB, "live videos", kindSql, ["L", "he", 200], samples)
  );

  let channelResult = null;

  if (channelId) {
    const channelRows = await runAll(DB, channelLookupSql, [channelId]);
    const channel = channelRows[0] || null;

    if (channel?.id) {
      channelResult = await benchQuery(
        DB,
        "channel videos",
        channelVideosSql,
        [channel.id, "V", "he", 200],
        samples
      );
    } else {
      channelResult = {
        label: "channel videos",
        error: "channel not found"
      };
    }
  }

  const explains = {
    latest: await explainQuery(DB, latestSql, ["V", "he", 200]),
    shorts: await explainQuery(DB, kindSql, ["S", "he", 200]),
    live: await explainQuery(DB, kindSql, ["L", "he", 200])
  };

  if (channelId) {
    const channelRows = await runAll(DB, channelLookupSql, [channelId]);
    const channel = channelRows[0] || null;

    if (channel?.id) {
      explains.channel = await explainQuery(DB, channelVideosSql, [channel.id, "V", "he", 200]);
    }
  }

  return Response.json(
    {
      ok: true,
      tested_at: new Date().toISOString(),
      samples,
      results,
      channel_result: channelResult,
      explains,
      note: "אם ב־EXPLAIN מופיע SCAN או USE TEMP B-TREE, כנראה שיש בעיית אינדקס או מיון כבד."
    },
    {
      headers: {
        "cache-control": "no-store"
      }
    }
  );
}
