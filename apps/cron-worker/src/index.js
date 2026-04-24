import { createClient } from "@tursodatabase/serverless/compat";

function isRetryableLibsql404(error) {
  const msg = String(error || "");
  return msg.includes("LibsqlError") && msg.includes("HTTP error! status: 404");
}

function createDB(env) {
  if (!env.TURSO_DATABASE_URL) {
    throw new Error("Missing TURSO_DATABASE_URL");
  }

  if (!env.TURSO_AUTH_TOKEN) {
    throw new Error("Missing TURSO_AUTH_TOKEN");
  }

  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  let readyPromise = null;

  async function ensureReady() {
    if (!readyPromise) {
      readyPromise = client.execute("PRAGMA foreign_keys = ON");
    }
    await readyPromise;
  }

  async function execute(payload) {
    await ensureReady();

    try {
      return await client.execute(payload);
    } catch (error) {
      if (!isRetryableLibsql404(error)) throw error;
      return client.execute(payload);
    }
  }

  function rowsToObjects(rs) {
    const rows = rs?.rows || [];
    const columns = rs?.columns || [];

    return rows.map((row) => {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        return { ...row };
      }

      const out = {};
      for (let i = 0; i < columns.length; i++) {
        out[columns[i]] = row[i];
      }
      return out;
    });
  }

  return {
    prepare(sql) {
      const state = {
        sql,
        args: [],
      };

      return {
        bind(...args) {
          state.args = args;
          return this;
        },

        async all() {
          const rs = await execute({
            sql: state.sql,
            args: state.args,
          });

          return {
            results: rowsToObjects(rs),
          };
        },

        async first() {
          const rs = await execute({
            sql: state.sql,
            args: state.args,
          });

          return rowsToObjects(rs)[0] || null;
        },

        async run() {
          const rs = await execute({
            sql: state.sql,
            args: state.args,
          });

          return {
            meta: {
              changes: rs?.rowsAffected || 0,
              last_row_id: rs?.lastInsertRowid != null ? Number(rs.lastInsertRowid) : 0,
            },
          };
        },

        __toStmt() {
          return {
            sql: state.sql,
            args: state.args,
          };
        },
      };
    },

    async batch(statements) {
      let totalChanges = 0;
      let lastRowId = 0;

      for (const statement of statements) {
        const stmt = statement?.__toStmt ? statement.__toStmt() : statement;
        const rs = await execute({
          sql: stmt.sql,
          args: stmt.args || [],
        });

        totalChanges += rs?.rowsAffected || 0;
        if (rs?.lastInsertRowid != null) {
          lastRowId = Number(rs.lastInsertRowid);
        }
      }

      return {
        meta: {
          changes: totalChanges,
          last_row_id: lastRowId,
        },
      };
    },
  };
}

function nowSec(){ return Math.floor(Date.now()/1000); }
function toUnixSeconds(iso){
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms/1000) : 0;
}

function canonicalTopicUrl(topic){
  const t = (topic || "").trim();
  if(!t) return "";

  return t.replace(
    "https://www.youtube.com/feeds/videos.xml",
    "https://www.youtube.com/xml/feeds/videos.xml"
  );
}

async function ytJson(url){
  const r = await fetch(url);
  const t = await r.text();
  if(!r.ok) throw new Error(`YT ${r.status}: ${t.slice(0,200)}`);
  return JSON.parse(t);
}

async function getState(env, key, def=""){
  const r = await env.DB.prepare(`SELECT value FROM cron_state WHERE key=?`).bind(key).first();
  return r?.value ?? def;
}
async function setState(env, key, value){
  await env.DB.prepare(`
    INSERT INTO cron_state(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
    WHERE cron_state.value IS NOT excluded.value
  `).bind(key, String(value)).run();
}

function decodeXml(s){
  return (s||"")
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'");
}
function matchText(s,re){ const m=s.match(re); return m ? decodeXml(m[1].trim()) : null; }

function extractEntries(xml){
  const out=[];
  const entryRe=/<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while((m=entryRe.exec(xml))){
    const e=m[1];
    const videoId = matchText(e,/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if(!videoId) continue;
    const title = matchText(e,/<title>([^<]+)<\/title>/) || "";
    const published = matchText(e,/<published>([^<]+)<\/published>/);
    out.push({
      videoId,
      title,
      published_at: toUnixSeconds(published || null) ?? 0
    });
  }
  return out;
}

function pickPlaylistThumbVideoId(thumbnails){
  if(!thumbnails) return null;
  const keys = ["maxres","standard","high","medium","default"];
  for(const k of keys){
    const u = thumbnails?.[k]?.url || "";
    const m = u.match(/\/vi\/([^/]+)\//);
    if(m) return m[1];
  }
  return null;
}

function parseIsoDurationSec(iso){
  const m = String(iso || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if(!m) return null;
  const days = parseInt(m[1] || "0", 10);
  const hours = parseInt(m[2] || "0", 10);
  const mins = parseInt(m[3] || "0", 10);
  const secs = parseInt(m[4] || "0", 10);
  return (((days * 24) + hours) * 60 + mins) * 60 + secs;
}

function classifyVideoItem(it){
  if(it?.liveStreamingDetails) return "L";

  const sec = parseIsoDurationSec(it?.contentDetails?.duration || "");
  if(!(Number.isFinite(sec) && sec > 0 && sec <= 180)) return "";

  const w = Number(it?.player?.embedWidth || 0);
  const h = Number(it?.player?.embedHeight || 0);

  if(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > w){
    return "S";
  }

  return "";
}

function extractDurationSec(it){
  const sec = parseIsoDurationSec(it?.contentDetails?.duration || "");
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

function buildVideoMeta(it){
  return {
    video_kind: classifyVideoItem(it),
    duration_sec: extractDurationSec(it)
  };
}

async function fetchVideoMeta(env, ids){
  const out = new Map();
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if(!env.YT_API_KEY || !uniq.length) return out;

  for(let i=0;i<uniq.length;i+=50){
    const chunk = uniq.slice(i, i+50);
    const u = new URL("https://www.googleapis.com/youtube/v3/videos");
    u.searchParams.set("part", "contentDetails,liveStreamingDetails,player");
    u.searchParams.set("id", chunk.join(","));
    u.searchParams.set("maxResults", String(chunk.length));
    u.searchParams.set("maxWidth", "8192");
    u.searchParams.set("maxHeight", "8192");
    u.searchParams.set("key", env.YT_API_KEY);

    const data = await ytJson(u.toString());
    for(const it of (data?.items || [])){
      if(it?.id) out.set(it.id, buildVideoMeta(it));
    }
  }

  return out;
}

async function fetchChannelUploadsPlaylistId(env, channelId){
  const u = new URL("https://www.googleapis.com/youtube/v3/channels");
  u.searchParams.set("part","contentDetails");
  u.searchParams.set("id", channelId);
  u.searchParams.set("key", env.YT_API_KEY);
  const data = await ytJson(u.toString());
  return data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads || null;
}
function isPlaylistNotFoundError(err){
  const msg = String(err?.message || err || "");
  return msg.includes("YT 404") && msg.includes("playlistId");
}
/** backfill ערוצים: מייבא היסטוריה מה-Uploads playlist */
async function backfillSome(env, maxCalls=20){
  if(!env.YT_API_KEY) return;

  const rows = await env.DB.prepare(`
    SELECT cb.channel_int, cb.uploads_playlist_id, cb.next_page_token
    FROM channel_backfill cb
    JOIN channels c ON c.id = cb.channel_int
    WHERE cb.done=0 AND c.is_active=1
    ORDER BY cb.channel_int ASC
    LIMIT ?
  `).bind(maxCalls).all();

   for(const r of (rows?.results || [])){
    const playlistId = r.uploads_playlist_id;

    if(!playlistId){
      await env.DB.prepare(`
        UPDATE channel_backfill
        SET done=1, updated_at=?
        WHERE channel_int=?
      `).bind(nowSec(), r.channel_int).run();
      continue;
    }

    try {
      const u = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      u.searchParams.set("part","snippet,contentDetails");
      u.searchParams.set("playlistId", playlistId);
      u.searchParams.set("maxResults","10");
      if(r.next_page_token) u.searchParams.set("pageToken", r.next_page_token);
      u.searchParams.set("key", env.YT_API_KEY);

      const data = await ytJson(u.toString());
      const items = data?.items || [];
      const metaMap = await fetchVideoMeta(env, items.map(it => it?.contentDetails?.videoId).filter(Boolean));

      const now = nowSec();
      const stmts = [];

      for(const it of items){
        const vid = it?.contentDetails?.videoId || null;
        if(!vid) continue;

        const sn = it?.snippet || {};
        const title = (sn?.title || "").slice(0,200);
        const published_at = toUnixSeconds(sn?.publishedAt || null) ?? 0;
        const meta = metaMap.get(vid) || {};
        const video_kind = meta.video_kind ?? null;
        const duration_sec = meta.duration_sec ?? null;

        stmts.push(env.DB.prepare(`
          INSERT INTO videos(video_id, channel_int, title, published_at, video_kind, duration_sec, updated_at)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(video_id) DO UPDATE SET
            title=excluded.title,
            published_at=CASE WHEN excluded.published_at > 0 THEN excluded.published_at ELSE videos.published_at END,
            video_kind=CASE WHEN excluded.video_kind IS NOT NULL THEN excluded.video_kind ELSE videos.video_kind END,
            duration_sec=CASE WHEN excluded.duration_sec IS NOT NULL THEN excluded.duration_sec ELSE videos.duration_sec END,
            updated_at=excluded.updated_at
          WHERE
            videos.title IS NOT excluded.title
            OR (excluded.published_at IS NOT NULL AND COALESCE(videos.published_at,0) != COALESCE(excluded.published_at,0))
            OR (excluded.video_kind IS NOT NULL AND COALESCE(videos.video_kind,'') != excluded.video_kind)
            OR (excluded.duration_sec IS NOT NULL AND COALESCE(videos.duration_sec,-1) != excluded.duration_sec)
        `).bind(vid, r.channel_int, title, published_at, video_kind, duration_sec, now));
      }

      if(stmts.length) await env.DB.batch(stmts);

      const next = data?.nextPageToken || null;
      const done = next ? 0 : 1;

      await env.DB.prepare(`
        UPDATE channel_backfill
        SET next_page_token=?, done=?,
            imported_count = imported_count + ?,
            updated_at=?
        WHERE channel_int=?
      `).bind(next, done, items.length, nowSec(), r.channel_int).run();
    } catch (e) {
      if(isPlaylistNotFoundError(e)){
        console.log(`backfillSome skip invalid playlistId=${playlistId} channel_int=${r.channel_int}`);

        await env.DB.prepare(`
          UPDATE channel_backfill
          SET done=1, next_page_token=NULL, updated_at=?
          WHERE channel_int=?
        `).bind(nowSec(), r.channel_int).run();

        continue;
      }

      console.log(`backfillSome row error channel_int=${r.channel_int} playlistId=${playlistId}`, e);
      continue;
    }
  }
}

/** בדיקת פיד יומית (catch-up) */
async function catchUpFeeds(env, maxChannels=5){
  let lastId = parseInt(await getState(env, "feed_cursor", "0"), 10) || 0;

  async function loadRows(fromId){
    return env.DB.prepare(`
      SELECT id, channel_id
      FROM channels
      WHERE is_active=1 AND id>?
      ORDER BY id ASC
      LIMIT ?
    `).bind(fromId, maxChannels).all();
  }

  let rows = await loadRows(lastId);
  let list = rows?.results || [];

  if(!list.length && lastId > 0){
    await setState(env, "feed_cursor", "0");
    rows = await loadRows(0);
    list = rows?.results || [];
  }

  if(!list.length) return;

  for(const ch of list){
    const feed = await fetch(`https://www.youtube.com/xml/feeds/videos.xml?channel_id=${encodeURIComponent(ch.channel_id)}`);

    if(feed.ok){
      const xml = await feed.text();
      const entries = extractEntries(xml).slice(0, 10);

      if(entries.length){
        const now = nowSec();
        const stmts = entries.map(e => {
          return env.DB.prepare(`
            INSERT INTO videos(video_id, channel_int, title, published_at, video_kind, duration_sec, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id) DO UPDATE SET
              channel_int   = excluded.channel_int,
              title         = excluded.title,
              published_at  = COALESCE(excluded.published_at, videos.published_at),
              updated_at    = excluded.updated_at
            WHERE
              videos.channel_int IS NOT excluded.channel_int
              OR videos.title IS NOT excluded.title
              OR (excluded.published_at IS NOT NULL AND COALESCE(videos.published_at,0) != COALESCE(excluded.published_at,0))
          `).bind(
            e.videoId,
            ch.id,
            e.title,
            e.published_at ?? 0,
            null,
            null,
            now
          );
        });

        await env.DB.batch(stmts);
      }
    }

    await setState(env, "feed_cursor", String(ch.id));
  }

  if(list.length < maxChannels){
    await setState(env, "feed_cursor", "0");
  }
}


/** renew פושים למי שמתקרב לפקיעה */
async function renewNeeded(env, max=10, renewBeforeSec=2*24*3600){
  const now = nowSec();

  const rows = await env.DB.prepare(`
    SELECT s.topic_url, s.channel_int, s.lease_expires_at
    FROM subscriptions s
    JOIN channels c ON c.id = s.channel_int
    WHERE c.is_active=1
      AND s.topic_url IS NOT NULL
      AND (s.lease_expires_at IS NULL OR s.lease_expires_at < (? + ?))
    ORDER BY COALESCE(s.lease_expires_at,0) ASC
    LIMIT ?
  `).bind(now, renewBeforeSec, max).all();

  for(const r of (rows?.results || [])){
    const topic = canonicalTopicUrl(r.topic_url);

    const callback = env.WEBSUB_CALLBACK_URL;
    const hub = env.WEBSUB_HUB_URL || "https://pubsubhubbub.appspot.com/subscribe";
    const lease = env.WEBSUB_LEASE_SECONDS || "432000";

    if(!callback) throw new Error("missing WEBSUB_CALLBACK_URL");
    if(!env.WEBSUB_VERIFY_TOKEN) throw new Error("missing WEBSUB_VERIFY_TOKEN");
    if(!env.WEBSUB_SECRET) throw new Error("missing WEBSUB_SECRET");

    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.topic": topic,
      "hub.callback": callback,
      "hub.verify": "async",
      "hub.verify_token": env.WEBSUB_VERIFY_TOKEN,
      "hub.secret": env.WEBSUB_SECRET,
      "hub.lease_seconds": lease
    });

    const res = await fetch(hub, {
      method: "POST",
      headers: { "content-type":"application/x-www-form-urlencoded" },
      body: params.toString()
    });

    await env.DB.prepare(`
      INSERT INTO subscriptions(topic_url, channel_int, status, last_subscribed_at, last_error)
      VALUES(?, ?, 'pending', ?, ?)
      ON CONFLICT(topic_url) DO UPDATE SET
        channel_int = excluded.channel_int,
        status = CASE WHEN subscriptions.status='active' THEN 'active' ELSE 'pending' END,
        last_subscribed_at = excluded.last_subscribed_at,
        last_error = excluded.last_error
    `).bind(topic, r.channel_int, nowSec(), res.ok ? null : `renew failed ${res.status}`).run();
  }
}

/** ריענון פלייליסטים פעם בחודש (שומר רק thumb_video_id) */
async function refreshPlaylistsMonthly(env, perRun=5, maxPages=10){
  if(!env.YT_API_KEY) return;

  const monthKey = new Date().toISOString().slice(0,7);
  const lastMonth = await getState(env, "pl_month", "");

  if(lastMonth !== monthKey){
    await setState(env, "pl_month", monthKey);
    await setState(env, "pl_cursor", "0");
  }

  const cursor = parseInt(await getState(env, "pl_cursor", "0"), 10) || 0;

  const chans = await env.DB.prepare(`
    SELECT id, channel_id
    FROM channels
    WHERE is_active=1 AND id>?
    ORDER BY id ASC
    LIMIT ?
  `).bind(cursor, perRun).all();

  let last = cursor;

  for(const ch of (chans?.results || [])){
    last = ch.id;

    let pageToken = null;
    for(let i=0;i<maxPages;i++){
      const u = new URL("https://www.googleapis.com/youtube/v3/playlists");
      u.searchParams.set("part","snippet,contentDetails");
      u.searchParams.set("channelId", ch.channel_id);
      u.searchParams.set("maxResults","10");
      if(pageToken) u.searchParams.set("pageToken", pageToken);
      u.searchParams.set("key", env.YT_API_KEY);

      const data = await ytJson(u.toString());
      const items = data?.items || [];
      pageToken = data?.nextPageToken || null;

      const now = nowSec();
      const stmts = [];

      for(const it of items){
        const playlist_id = it?.id || null;
        if(!playlist_id) continue;

        const sn = it?.snippet || {};
        const cd = it?.contentDetails || {};

        const title = (sn?.title || "").slice(0,200);
        const published_at = toUnixSeconds(sn?.publishedAt || null);
        const item_count = Number.isFinite(cd?.itemCount) ? cd.itemCount : null;

        const thumb_video_id = pickPlaylistThumbVideoId(it?.snippet?.thumbnails);

        stmts.push(env.DB.prepare(`
          INSERT INTO playlists(playlist_id, channel_int, title, thumb_video_id, published_at, item_count, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(playlist_id) DO UPDATE SET
            channel_int    = excluded.channel_int,
            title          = COALESCE(excluded.title, playlists.title),
            thumb_video_id = COALESCE(excluded.thumb_video_id, playlists.thumb_video_id),
            published_at   = COALESCE(excluded.published_at, playlists.published_at),
            item_count     = COALESCE(excluded.item_count, playlists.item_count),
            updated_at     = excluded.updated_at
          WHERE
            playlists.channel_int IS NOT excluded.channel_int
            OR (excluded.title IS NOT NULL AND playlists.title IS NOT excluded.title)
            OR (excluded.thumb_video_id IS NOT NULL AND playlists.thumb_video_id IS NOT excluded.thumb_video_id)
            OR (excluded.published_at IS NOT NULL AND COALESCE(playlists.published_at,0) != COALESCE(excluded.published_at,0))
            OR (excluded.item_count IS NOT NULL AND COALESCE(playlists.item_count,-1) != COALESCE(excluded.item_count,-1))
        `).bind(playlist_id, ch.id, title, thumb_video_id, published_at, item_count, now));
      }

      if(stmts.length) await env.DB.batch(stmts);
      if(!pageToken) break;
    }
  }

  await setState(env, "pl_cursor", String(last));
}



async function runCron(env, opts = {}) {
  const runtimeEnv = { ...env, DB: createDB(env) };
  const started = nowSec();
  await setState(runtimeEnv, "cron_last_run", String(started));

  const feedLimit = Number.isFinite(opts.feedLimit) ? opts.feedLimit : 1;
  const backfillLimit = Number.isFinite(opts.backfillLimit) ? opts.backfillLimit : 1;
  const renewLimit = Number.isFinite(opts.renewLimit) ? opts.renewLimit : 1;
  const playlistChannels = Number.isFinite(opts.playlistChannels) ? opts.playlistChannels : 1;
  const playlistPages = Number.isFinite(opts.playlistPages) ? opts.playlistPages : 1;

  let lastErr = "";
  const steps = {};

  try {
    await catchUpFeeds(runtimeEnv, feedLimit);
    steps.catchUpFeeds = { ok: true, limit: feedLimit };
  }
  catch (e) {
    lastErr = `catchUpFeeds: ${e?.stack || e}`;
    steps.catchUpFeeds = { ok: false, limit: feedLimit, error: String(e?.message || e) };
    console.log(`catchUpFeeds error`, e);
  }

  try {
    await backfillSome(runtimeEnv, backfillLimit);
    steps.backfillSome = { ok: true, limit: backfillLimit };
  }
  catch (e) {
    if (!lastErr) lastErr = `backfillSome: ${e?.stack || e}`;
    steps.backfillSome = { ok: false, limit: backfillLimit, error: String(e?.message || e) };
    console.log(`backfillSome error`, e);
  }

  try {
    await renewNeeded(runtimeEnv, renewLimit, 2 * 24 * 3600);
    steps.renewNeeded = { ok: true, limit: renewLimit };
  }
  catch (e) {
    if (!lastErr) lastErr = `renewNeeded: ${e?.stack || e}`;
    steps.renewNeeded = { ok: false, limit: renewLimit, error: String(e?.message || e) };
    console.log(`renewNeeded error`, e);
  }

  try {
    await refreshPlaylistsMonthly(runtimeEnv, playlistChannels, playlistPages);
    steps.refreshPlaylistsMonthly = { ok: true, channels: playlistChannels, pages: playlistPages };
  }
  catch (e) {
    if (!lastErr) lastErr = `refreshPlaylistsMonthly: ${e?.stack || e}`;
    steps.refreshPlaylistsMonthly = { ok: false, channels: playlistChannels, pages: playlistPages, error: String(e?.message || e) };
    console.log(`refreshPlaylistsMonthly error`, e);
  }

  await setState(runtimeEnv, "cron_last_error", lastErr);
  if (!lastErr) {
    await setState(runtimeEnv, "cron_last_ok", String(nowSec()));
  }

  const cron_last_run = await getState(runtimeEnv, "cron_last_run", "");
  const cron_last_ok = await getState(runtimeEnv, "cron_last_ok", "");
  const cron_last_error = await getState(runtimeEnv, "cron_last_error", "");

  return {
    ok: !lastErr,
    cron_last_run,
    cron_last_ok,
    cron_last_error,
    steps,
    limits: {
      feedLimit,
      backfillLimit,
      renewLimit,
      playlistChannels,
      playlistPages,
    },
  };
}

function getBasicAuthCredentials(request) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) return null;

  try {
    const decoded = atob(auth.slice(6));
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return {
      user: decoded.slice(0, idx),
      pass: decoded.slice(idx + 1),
    };
  } catch {
    return null;
  }
}

function requireOptionalBasicAuth(request, env) {
  if (!env.ADMIN_BASIC_USER || !env.ADMIN_BASIC_PASS) {
    return null;
  }

  const creds = getBasicAuthCredentials(request);
  if (creds?.user === env.ADMIN_BASIC_USER && creds?.pass === env.ADMIN_BASIC_PASS) {
    return null;
  }

  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="youtube3-cron"',
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function toLocalDisplay(unixSec) {
  if (!unixSec) return "—";
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n * 1000).toLocaleString("he-IL");
}

async function getStatus(env) {
  const runtimeEnv = { ...env, DB: createDB(env) };
  return {
    ok: true,
    db: true,
    cron_last_run: await getState(runtimeEnv, "cron_last_run", ""),
    cron_last_ok: await getState(runtimeEnv, "cron_last_ok", ""),
    cron_last_error: await getState(runtimeEnv, "cron_last_error", ""),
  };
}

function renderHome(status) {
  const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>youtube3-cron</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;background:#f6f7fb;color:#111;margin:0;padding:24px}
    .wrap{max-width:780px;margin:0 auto}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:20px;box-shadow:0 4px 18px rgba(0,0,0,.06)}
    h1{margin:0 0 12px;font-size:28px}
    p{margin:8px 0}
    .grid{display:grid;grid-template-columns:180px 1fr;gap:10px 14px;margin:18px 0}
    .key{color:#555}
    .actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
    button,a{appearance:none;border:0;border-radius:12px;padding:12px 16px;font-size:16px;cursor:pointer;text-decoration:none}
    button{background:#111;color:#fff}
    a{background:#eef2ff;color:#1d4ed8}
    code{background:#f3f4f6;padding:2px 6px;border-radius:8px}
    .ok{color:#166534}
    .bad{color:#b91c1c;white-space:pre-wrap;word-break:break-word}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>youtube3-cron</h1>
      <p>דף בקרה לוורקר הקרון.</p>
      <div class="grid">
        <div class="key">DB</div><div class="${status.db ? "ok" : "bad"}">${status.db ? "מחובר" : "שגיאה"}</div>
        <div class="key">ריצה אחרונה</div><div>${toLocalDisplay(status.cron_last_run)}</div>
        <div class="key">הצלחה אחרונה</div><div>${toLocalDisplay(status.cron_last_ok)}</div>
        <div class="key">שגיאה אחרונה</div><div class="${status.cron_last_error ? "bad" : "ok"}">${status.cron_last_error || "אין"}</div>
      </div>
      <div class="actions">
        <form method="post" action="/run-now">
          <button type="submit">הפעל עכשיו ידנית (קל)</button>
        </form>
        <a href="/health">JSON מצב</a>
      </div>
      <p style="margin-top:18px">ההרצה הידנית מפעילה מצב קל כדי לא ליפול על מגבלת subrequests.</p>
      <p>אם הגדרת <code>ADMIN_BASIC_USER</code> ו־<code>ADMIN_BASIC_PASS</code> בוורקר, הדף הזה יהיה מוגן בסיסמה.</p>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const authResponse = requireOptionalBasicAuth(request, env);
    if (authResponse) return authResponse;

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        const status = await getStatus(env);
        return Response.json(status);
      }

      if (request.method === "POST" && url.pathname === "/run-now") {
        const result = await runCron(env, { feedLimit: 1, backfillLimit: 1, renewLimit: 1, playlistChannels: 1, playlistPages: 1 });
        return Response.json({
          ok: result.ok,
          message: result.ok ? "manual run finished" : "manual run finished with errors",
          ...result,
        });
      }

      if (request.method === "GET" && url.pathname === "/run-now") {
        const result = await runCron(env, { feedLimit: 1, backfillLimit: 1, renewLimit: 1, playlistChannels: 1, playlistPages: 1 });
        return Response.json({
          ok: result.ok,
          message: result.ok ? "manual run finished" : "manual run finished with errors",
          ...result,
        });
      }

      if (request.method === "GET" && url.pathname === "/") {
        const status = await getStatus(env);
        return renderHome(status);
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error?.stack || error || "unknown error"),
      }, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    console.log(`scheduled fired: ${event.cron || "unknown"}`);
    ctx.waitUntil(runCron(env, { feedLimit: 1, backfillLimit: 1, renewLimit: 1, playlistChannels: 1, playlistPages: 1 }));
  }
};
