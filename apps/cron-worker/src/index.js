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
      await ensureReady();

      const stmts = statements.map((statement) => {
        if (statement?.__toStmt) return statement.__toStmt();
        return statement;
      });

      return client.batch(stmts, "write");
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
      u.searchParams.set("maxResults","25");
      if(r.next_page_token) u.searchParams.set("pageToken", r.next_page_token);
      u.searchParams.set("key", env.YT_API_KEY);

      const data = await ytJson(u.toString());
      const items = data?.items || [];
      const metaMap = await fetchVideoMeta(
        env,
        items.map(it => it?.contentDetails?.videoId).filter(Boolean)
      );

      const now = nowSec();
      const stmts = [];
      const stmtVideoIds = [];

      for(const it of items){
        const vid = String(it?.contentDetails?.videoId || "").trim();
        if(!vid) continue;

        const sn = it?.snippet || {};
        const title = String(sn?.title || "").slice(0,200) || "[untitled]";
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
            OR (excluded.duration_sec IS NOT NULL AND COALESCE(videos.duration_sec,-1) != COALESCE(excluded.duration_sec,-1))
        `).bind(vid, r.channel_int, title, published_at, video_kind, duration_sec, now));

        stmtVideoIds.push(vid);
      }

      let importedOk = 0;

      for(let i=0; i<stmts.length; i++){
        try {
          await stmts[i].run();
          importedOk++;
        } catch (itemErr) {
          console.log(
            `backfillSome item skip channel_int=${r.channel_int} playlistId=${playlistId} video_id=${stmtVideoIds[i]}`,
            itemErr
          );
        }
      }

      const next = data?.nextPageToken || null;
      const done = next ? 0 : 1;

      await env.DB.prepare(`
        UPDATE channel_backfill
        SET next_page_token=?, done=?,
            imported_count = imported_count + ?,
            updated_at=?
        WHERE channel_int=?
      `).bind(next, done, importedOk, nowSec(), r.channel_int).run();

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
      const entries = extractEntries(xml);

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
      u.searchParams.set("maxResults","50");
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

export default {
  async scheduled(event, env, ctx){
    env.DB = createDB(env);

    ctx.waitUntil((async ()=>{
      const started = nowSec();
      await setState(env, "cron_last_run", String(started));

      let lastErr = "";

      try { await backfillSome(env, 1); }
      catch (e) {
        if (!lastErr) lastErr = `backfillSome: ${e?.stack || e}`;
        console.log(`backfillSome error`, e);
      }

      await setState(env, "cron_last_error", lastErr);
      if (!lastErr) await setState(env, "cron_last_ok", String(nowSec()));
    })());
  }
};
