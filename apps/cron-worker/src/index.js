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

function toIntOrNull(value){
  if(value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function cleanText(value, maxLen){
  const s = String(value || "").replace(/\u0000/g, "").trim();
  return s ? s.slice(0, maxLen) : "";
}

function normalizeTagKey(value){
  return String(value || "")
    .trim()
    .replace(/^#+/, "")
    .trim()
    .replace(/[“”״"]/g, '"')
    .replace(/[‘’׳']/g, "'")
    .toLocaleLowerCase();
}

function cleanTags(tags){
  if(!Array.isArray(tags)) return [];
  const out = [];
  const seen = new Set();

  for(const raw of tags){
    const tag = cleanText(raw, 120);
    if(!tag) continue;

    const key = normalizeTagKey(tag);
    if(!key || seen.has(key)) continue;

    seen.add(key);
    out.push(tag);
    if(out.length >= 40) break;
  }

  return out;
}

function extractHashtags(...texts){
  const out = [];
  const seen = new Set();

  for(const text of texts){
    const s = String(text || "");
    const re = /(^|[^\p{L}\p{N}_-])#((?:[\p{L}\p{N}_-]|['"׳״’](?=[\p{L}\p{N}_-])){2,80})/gu;
    let m;

    while((m = re.exec(s))){
      const tag = cleanText(m[2], 80);
      if(!tag) continue;

      const key = normalizeTagKey(tag);
      if(!key || seen.has(key)) continue;

      seen.add(key);
      out.push(tag);
      if(out.length >= 30) return out;
    }
  }

  return out;
}

function buildVideoMeta(it){
  const sn = it?.snippet || {};
  const st = it?.statistics || {};
  const description = cleanText(sn.description || "", 6000);
  const tags = cleanTags(sn.tags || []);
  const hashtags = extractHashtags(sn.title || "", description);

  return {
    title: cleanText(sn.title || "", 200),
    published_at_iso: sn.publishedAt || "",
    channel_id: sn.channelId || "",
    video_kind: classifyVideoItem(it),
    duration_sec: extractDurationSec(it),
    view_count: toIntOrNull(st.viewCount),
    like_count: toIntOrNull(st.likeCount),
    comment_count: toIntOrNull(st.commentCount),
    description,
    tags,
    hashtags,
    category_id: sn.categoryId || "",
    default_language: sn.defaultLanguage || "",
    default_audio_language: sn.defaultAudioLanguage || "",
    live_broadcast_content: sn.liveBroadcastContent || ""
  };
}

async function fetchVideoMeta(env, ids){
  const out = new Map();
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if(!env.YT_API_KEY || !uniq.length) return out;

  for(let i = 0; i < uniq.length; i += 50){
    const chunk = uniq.slice(i, i + 50);
    const u = new URL("https://www.googleapis.com/youtube/v3/videos");
    u.searchParams.set("part", "snippet,statistics,contentDetails,liveStreamingDetails,player");
    u.searchParams.set("id", chunk.join(","));
    u.searchParams.set("maxWidth", "8192");
    u.searchParams.set("maxHeight", "8192");
    u.searchParams.set("fields", "items(id,snippet(publishedAt,channelId,title,description,tags,categoryId,defaultLanguage,defaultAudioLanguage,liveBroadcastContent),statistics(viewCount,likeCount,commentCount),contentDetails(duration),liveStreamingDetails,player(embedWidth,embedHeight))");
    u.searchParams.set("key", env.YT_API_KEY);

    const data = await ytJson(u.toString());
    for(const it of (data?.items || [])){
      if(it?.id) out.set(it.id, buildVideoMeta(it));
    }
  }

  return out;
}

function uniqueIndexedTags(tags, type, maxLen){
  const out = [];
  const seen = new Set();

  for(const raw of tags || []){
    const value = cleanText(raw, maxLen);
    const norm = normalizeTagKey(value);
    if(!value || !norm || seen.has(norm)) continue;

    seen.add(norm);
    out.push({ type, value, norm });
  }

  return out;
}

function videoTagIndexStmts(env, videoId, tags, hashtags){
  const items = [
    ...uniqueIndexedTags(tags, "tag", 120),
    ...uniqueIndexedTags(hashtags, "hashtag", 80)
  ];

  const stmts = [
    env.DB.prepare(`DELETE FROM video_tags WHERE video_id = ?`).bind(videoId)
  ];

  for(let i = 0; i < items.length; i += 25){
    const chunk = items.slice(i, i + 25);
    if(!chunk.length) continue;

    const valuesSql = chunk.map(() => "(?, ?, ?)").join(", ");
    const binds = [];

    for(const item of chunk){
      binds.push(item.type, item.value, item.norm);
    }

    binds.push(videoId, videoId);

    stmts.push(env.DB.prepare(`
      WITH input(tag_type, tag_value, tag_norm) AS (
        VALUES ${valuesSql}
      )
      INSERT OR IGNORE INTO video_tags(video_id, tag_type, tag_value, tag_norm, video_rowid)
      SELECT ?, input.tag_type, input.tag_value, input.tag_norm, v.id
      FROM input
      JOIN videos AS v
        ON v.video_id = ?
    `).bind(...binds));
  }

  return stmts;
}

function videoDetailsStmts(env, videoId, meta, ts){
  const tags = Array.isArray(meta?.tags) ? meta.tags : [];
  const hashtags = Array.isArray(meta?.hashtags) ? meta.hashtags : [];
  const tagsJson = JSON.stringify(tags);
  const hashtagsJson = JSON.stringify(hashtags);
  const description = meta?.description || "";
  const tagsText = tags.join(" ");
  const hashtagsText = hashtags.map(t => `#${t}`).join(" ");

  return [
    env.DB.prepare(`
      INSERT INTO video_details(
        video_id, description, tags_json, hashtags_json,
        category_id, default_language, default_audio_language, live_broadcast_content,
        fetched_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        description            = excluded.description,
        tags_json              = excluded.tags_json,
        hashtags_json          = excluded.hashtags_json,
        category_id            = excluded.category_id,
        default_language       = excluded.default_language,
        default_audio_language = excluded.default_audio_language,
        live_broadcast_content = excluded.live_broadcast_content,
        fetched_at             = excluded.fetched_at,
        updated_at             = excluded.updated_at
      WHERE
        video_details.description IS NOT excluded.description
        OR video_details.tags_json IS NOT excluded.tags_json
        OR video_details.hashtags_json IS NOT excluded.hashtags_json
        OR video_details.category_id IS NOT excluded.category_id
        OR video_details.default_language IS NOT excluded.default_language
        OR video_details.default_audio_language IS NOT excluded.default_audio_language
        OR video_details.live_broadcast_content IS NOT excluded.live_broadcast_content
        OR COALESCE(video_details.fetched_at, 0) != excluded.fetched_at
    `).bind(
      videoId,
      description,
      tagsJson,
      hashtagsJson,
      meta?.category_id || "",
      meta?.default_language || "",
      meta?.default_audio_language || "",
      meta?.live_broadcast_content || "",
      ts,
      ts
    ),
    env.DB.prepare(`DELETE FROM video_details_fts WHERE video_id = ?`).bind(videoId),
    env.DB.prepare(`
      INSERT INTO video_details_fts(video_id, description, tags, hashtags)
      VALUES(?, ?, ?, ?)
    `).bind(videoId, description, tagsText, hashtagsText),
    ...videoTagIndexStmts(env, videoId, tags, hashtags)
  ];
}

function parseJsonArray(value){
  try {
    const arr = JSON.parse(value || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
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
function videoUpsertAndMetaStmts(env, rows, ts){
  // הגנה כפולה: שום statement לא ינסה להכניס videos.video_id ריק/NULL.
  // זה מטפל בפריטי playlist מחוקים/פרטיים וגם בכל שינוי פורמט ש-YouTube מחזיר.
  const cleanRows = [];
  const seen = new Set();

  for (const raw of (rows || [])) {
    const vid = String(
      raw?.vid ||
      raw?.video_id ||
      raw?.videoId ||
      ""
    ).trim();

    if (!vid || seen.has(vid)) {
      if (!vid) {
        console.log("videoUpsertAndMetaStmts skip row without video id", JSON.stringify(raw || {}).slice(0, 500));
      }
      continue;
    }

    seen.add(vid);

    cleanRows.push({
      ...raw,
      vid,
      channel_int: raw?.channel_int,
      title: String(raw?.title || "").slice(0, 200) || "[untitled]",
      published_at: Number(raw?.published_at || 0) || 0
    });
  }

  const ids = cleanRows.map(r => r.vid).filter(Boolean);

  if (!ids.length) {
    return Promise.resolve({
      stmts: [],
      metaCount: 0
    });
  }

  return fetchVideoMeta(env, ids).then(metaMap => {
    const stmts = [];

    for(const row of cleanRows){
      const vid = String(row.vid || "").trim();
      if (!vid) continue;

      const meta = metaMap.get(vid) || null;
      const title = (meta?.title || row.title || "[untitled]").slice(0, 200);
      const publishedAt = toUnixSeconds(meta?.published_at_iso || "") || row.published_at || 0;

      // משתמשים ב-INSERT ... SELECT ... WHERE כדי שגם אם בעתיד vid יהיה ריק,
      // SQLite לא ינסה להכניס NULL לעמודת videos.video_id.
      stmts.push(env.DB.prepare(`
        INSERT INTO videos(
          video_id, channel_int, title, published_at,
          video_kind, duration_sec,
          view_count, like_count, comment_count, stats_fetched_at,
          updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NOT NULL AND ? <> ''
        ON CONFLICT(video_id) DO UPDATE SET
          channel_int      = excluded.channel_int,
          title            = excluded.title,
          published_at     = CASE
            WHEN excluded.published_at > 0 THEN excluded.published_at
            ELSE videos.published_at
          END,
          video_kind       = CASE WHEN excluded.video_kind IS NOT NULL THEN excluded.video_kind ELSE videos.video_kind END,
          duration_sec     = CASE WHEN excluded.duration_sec IS NOT NULL THEN excluded.duration_sec ELSE videos.duration_sec END,
          view_count       = CASE WHEN excluded.view_count IS NOT NULL THEN excluded.view_count ELSE videos.view_count END,
          like_count       = CASE WHEN excluded.like_count IS NOT NULL THEN excluded.like_count ELSE videos.like_count END,
          comment_count    = CASE WHEN excluded.comment_count IS NOT NULL THEN excluded.comment_count ELSE videos.comment_count END,
          stats_fetched_at = CASE WHEN excluded.stats_fetched_at IS NOT NULL THEN excluded.stats_fetched_at ELSE videos.stats_fetched_at END,
          updated_at       = excluded.updated_at
        WHERE
          videos.channel_int IS NOT excluded.channel_int
          OR videos.title IS NOT excluded.title
          OR (excluded.published_at IS NOT NULL AND COALESCE(videos.published_at,0) != COALESCE(excluded.published_at,0))
          OR (excluded.video_kind IS NOT NULL AND COALESCE(videos.video_kind,'') != excluded.video_kind)
          OR (excluded.duration_sec IS NOT NULL AND COALESCE(videos.duration_sec,-1) != excluded.duration_sec)
          OR (excluded.view_count IS NOT NULL AND COALESCE(videos.view_count,-1) != excluded.view_count)
          OR (excluded.like_count IS NOT NULL AND COALESCE(videos.like_count,-1) != excluded.like_count)
          OR (excluded.comment_count IS NOT NULL AND COALESCE(videos.comment_count,-1) != excluded.comment_count)
          OR (excluded.stats_fetched_at IS NOT NULL AND COALESCE(videos.stats_fetched_at,0) != excluded.stats_fetched_at)
      `).bind(
        vid,
        row.channel_int,
        title,
        publishedAt,
        meta?.video_kind ?? null,
        meta?.duration_sec ?? null,
        meta?.view_count ?? null,
        meta?.like_count ?? null,
        meta?.comment_count ?? null,
        meta ? ts : null,
        ts,
        vid,
        vid
      ));

      if(meta){
        stmts.push(...videoDetailsStmts(env, vid, meta, ts));
      }
    }

    return {
      stmts,
      metaCount: metaMap.size
    };
  });
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
      // כל סרטון שנכנס דרך הקרון מקבל metadata מיד.
      // נשארים בכמות קטנה כדי לא לעבור את מגבלת subrequests של Cloudflare/Turso.
      u.searchParams.set("maxResults","5");
      if(r.next_page_token) u.searchParams.set("pageToken", r.next_page_token);
      u.searchParams.set("key", env.YT_API_KEY);

      const data = await ytJson(u.toString());
      const items = data?.items || [];
      const now = nowSec();
      const videos = [];
      const seen = new Set();

      for(const it of items){
        const sn = it?.snippet || {};
        const vid = String(
          it?.contentDetails?.videoId ||
          sn?.resourceId?.videoId ||
          ""
        ).trim();

        // לפעמים YouTube מחזיר פריטים מחוקים/פרטיים בלי videoId.
        if(!vid || seen.has(vid)) continue;
        seen.add(vid);

        videos.push({
          vid,
          channel_int: r.channel_int,
          title: String(sn?.title || "").slice(0,200) || "[untitled]",
          published_at: toUnixSeconds(sn?.publishedAt || null) || 0
        });
      }

      if(videos.length){
        const { stmts, metaCount } = await videoUpsertAndMetaStmts(env, videos, now);
        if(stmts.length) await env.DB.batch(stmts);
        console.log(`backfillSome inserted/updated ${videos.length} videos with ${metaCount} metadata rows channel_int=${r.channel_int}`);
      }

      const next = data?.nextPageToken || null;
      const done = next ? 0 : 1;

      await env.DB.prepare(`
        UPDATE channel_backfill
        SET next_page_token=?, done=?,
            imported_count = imported_count + ?,
            updated_at=?
        WHERE channel_int=?
      `).bind(next, done, videos.length, nowSec(), r.channel_int).run();

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
  if(!env.YT_API_KEY) return;

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
      const entries = extractEntries(xml).slice(0, 5);

      if(entries.length){
        const now = nowSec();
        const videos = [];
        const seen = new Set();

        for(const e of entries){
          const vid = String(e.videoId || "").trim();
          if(!vid || seen.has(vid)) continue;
          seen.add(vid);

          videos.push({
            vid,
            channel_int: ch.id,
            title: String(e.title || "").slice(0, 200) || "[untitled]",
            published_at: e.published_at || 0
          });
        }

        if(videos.length){
          const { stmts, metaCount } = await videoUpsertAndMetaStmts(env, videos, now);
          if(stmts.length) await env.DB.batch(stmts);
          console.log(`catchUpFeeds inserted/updated ${videos.length} videos with ${metaCount} metadata rows channel_int=${ch.id}`);
        }
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
    console.log("youtube4-cron v6 metadata-safe 2026-04-28");

    ctx.waitUntil((async ()=>{
      const started = nowSec();
      await setState(env, "cron_last_run", String(started));

      let lastErr = "";

      try { await catchUpFeeds(env, 1); }
      catch (e) {
        if (!lastErr) lastErr = `catchUpFeeds: ${e?.stack || e}`;
        console.log(`catchUpFeeds error`, e);
      }

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
