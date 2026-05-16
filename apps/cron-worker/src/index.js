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

      const stmts = (statements || []).map((statement) => {
        const stmt = statement?.__toStmt ? statement.__toStmt() : statement;

        return {
          sql: stmt.sql,
          args: stmt.args || [],
        };
      });

      const results = [];

      // חשוב: לא להשתמש כאן ב-client.batch, כי בסביבת Cloudflare עם compat
      // ראינו שה-bind של סימני ? עלול ללכת לאיבוד. execute שומר את ה-args תקין.
      for (const stmt of stmts) {
        results.push(await execute({
          sql: stmt.sql,
          args: stmt.args || [],
        }));
      }

      return results;
    },
  };
}

async function runStatementsSequential(stmts){
  let changes = 0;

  for(const stmt of stmts || []){
    const result = await stmt.run();
    changes += Number(result?.meta?.changes || 0);
  }

  return changes;
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
function safeJsonArrayLength(value){
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.length : -1;
  } catch (_) {
    return -1;
  }
}

async function filterVideosNeedingImportOrMeta(env, videos){
  const clean = (videos || [])
    .map((row) => ({
      ...row,
      vid: String(row?.vid || row?.video_id || row?.videoId || "").trim()
    }))
    .filter((row) => row.vid);

  if(!clean.length) return [];

  const known = new Map();

  for(let i = 0; i < clean.length; i += 50){
    const part = clean.slice(i, i + 50);
    const placeholders = part.map(() => "?").join(",");

    const rows = await env.DB.prepare(`
      SELECT
        v.video_id,
        v.stats_fetched_at,
        d.video_id AS details_video_id,
        d.description,
        d.tags_json,
        d.hashtags_json,
        d.fetched_at
      FROM videos AS v
      LEFT JOIN video_details AS d
        ON d.video_id = v.video_id
      WHERE v.video_id IN (${placeholders})
    `).bind(...part.map((row) => row.vid)).all();

    for(const row of (rows?.results || [])){
      if(row?.video_id) known.set(String(row.video_id), row);
    }
  }

  const now = nowSec();
  const repairEmptyAfterHours = intFromEnv(
    env.CRON_REPAIR_EMPTY_META_AFTER_HOURS,
    168,
    24,
    720
  );
  const repairEmptyAfterSec = repairEmptyAfterHours * 3600;

  return clean.filter((row) => {
    const current = known.get(row.vid);

    // לא קיים בכלל בטבלת videos: סרטון חדש, חייב ייבוא מלא.
    if(!current) return true;

    const fetchedAt = Number(current.fetched_at || 0);
    const statsFetchedAt = Number(current.stats_fetched_at || 0);

    // קיים ב-videos אבל אין שורת video_details: חייב השלמה.
    if(!current.details_video_id) return true;

    // יש details אבל לא ברור שמטא-דאטה באמת נמשך מיוטיוב.
    if(!fetchedAt) return true;
    if(!statsFetchedAt) return true;

    const description = String(current.description || "").trim();
    const tagsCount = safeJsonArrayLength(current.tags_json);
    const hashtagsCount = safeJsonArrayLength(current.hashtags_json);

    // JSON שבור/חסר: חייב בנייה מחדש כדי שדפי תגיות/האשטגים לא ייפגעו.
    if(tagsCount < 0) return true;
    if(hashtagsCount < 0) return true;

    const oldEnoughForEmptyRepair = (now - fetchedAt) >= repairEmptyAfterSec;

    // אם בעבר נכתב metadata ריק, לא נרענן אותו כל דקה.
    // ננסה לתקן רק אם עבר מספיק זמן, ברירת מחדל: שבוע.
    if(oldEnoughForEmptyRepair && !description) return true;
    if(oldEnoughForEmptyRepair && tagsCount === 0 && hashtagsCount === 0) return true;

    // קיים, יש details, יש fetched_at, והמידע נראה תקין: לדלג ולחסוך Turso.
    return false;
  });
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
  if(!(Number.isFinite(sec) && sec > 0 && sec <= 180)) return "V";

  const w = Number(it?.player?.embedWidth || 0);
  const h = Number(it?.player?.embedHeight || 0);

  if(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > w){
    return "S";
  }

  return "V";
}

function normalizeVideoKindForDb(value){
  const kind = String(value || "V").trim().toUpperCase();
  return kind === "S" || kind === "L" ? kind : "V";
}

function intFromEnv(value, fallback, min, max){
  const n = parseInt(String(value ?? ""), 10);
  if(!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function boolFromEnv(value, fallback=false){
  if(value === undefined || value === null || value === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if(["1", "true", "yes", "on"].includes(s)) return true;
  if(["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
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
    // לא מגבילים עם fields: part=snippet כבר כולל tags, וזה עדיין אותה קריאת videos.list אחת.
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
  // בכוונה לא מסתמכים כאן על המערכים בזיכרון.
  // קודם video_details נשמר, ואז בונים את video_tags מאותו JSON שכבר נמצא במסד.
  // כך אם דף הסרטון מציג tags_json/hashtags_json, אותו מקור בדיוק מזין גם את דפי התגיות.
  return [
    env.DB.prepare(`DELETE FROM video_tags WHERE video_id = ?`).bind(videoId),

    env.DB.prepare(`
      INSERT OR IGNORE INTO video_tags(video_id, video_rowid, tag_type, tag_value, tag_norm)
      SELECT
        d.video_id,
        v.id,
        'tag',
        TRIM(j.value),
        LOWER(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(TRIM(j.value), '#', ''),
                '״',
                '"'
              ),
              '׳',
              ''''
            ),
            '’',
            ''''
          )
        )
      FROM video_details AS d
      JOIN videos AS v
        ON v.video_id = d.video_id
      JOIN json_each(
        CASE
          WHEN json_valid(COALESCE(d.tags_json, '')) THEN d.tags_json
          ELSE '[]'
        END
      ) AS j
      WHERE d.video_id = ?
        AND TRIM(COALESCE(j.value, '')) <> ''
    `).bind(videoId),

    env.DB.prepare(`
      INSERT OR IGNORE INTO video_tags(video_id, video_rowid, tag_type, tag_value, tag_norm)
      SELECT
        d.video_id,
        v.id,
        'hashtag',
        TRIM(REPLACE(j.value, '#', '')),
        LOWER(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(TRIM(REPLACE(j.value, '#', '')), '#', ''),
                '״',
                '"'
              ),
              '׳',
              ''''
            ),
            '’',
            ''''
          )
        )
      FROM video_details AS d
      JOIN videos AS v
        ON v.video_id = d.video_id
      JOIN json_each(
        CASE
          WHEN json_valid(COALESCE(d.hashtags_json, '')) THEN d.hashtags_json
          ELSE '[]'
        END
      ) AS j
      WHERE d.video_id = ?
        AND TRIM(REPLACE(COALESCE(j.value, ''), '#', '')) <> ''
    `).bind(videoId)
  ];
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
        description            = CASE WHEN excluded.description <> '' THEN excluded.description ELSE video_details.description END,
        tags_json              = excluded.tags_json,
        hashtags_json          = excluded.hashtags_json,
        category_id            = excluded.category_id,
        default_language       = excluded.default_language,
        default_audio_language = excluded.default_audio_language,
        live_broadcast_content = excluded.live_broadcast_content,
        fetched_at             = excluded.fetched_at,
        updated_at             = excluded.updated_at
      WHERE
        (excluded.description <> '' AND video_details.description IS NOT excluded.description)
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
    ...videoTagIndexStmts(env, videoId, tags, hashtags),
    env.DB.prepare(`DELETE FROM video_details_fts WHERE video_id = ?`).bind(videoId),
    env.DB.prepare(`
      INSERT INTO video_details_fts(video_id, description, tags, hashtags)
      VALUES(?, ?, ?, ?)
    `).bind(videoId, description, tagsText, hashtagsText)
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

function normalizeLangCode(code){
  const raw = String(code || "").trim().toLowerCase().replace(/_/g, "-");
  if(!raw) return "";
  const base = raw.split("-")[0];
  const map = { iw:"he", he:"he", heb:"he", en:"en", eng:"en", fr:"fr", fra:"fr", fre:"fr", yi:"yi", yid:"yi", ji:"yi", ru:"ru", rus:"ru" };
  return map[base] || base;
}

function isSupportedLang(code){
  return ["he", "en", "fr", "yi", "ru"].includes(normalizeLangCode(code));
}

function guessLanguageFromText(...texts){
  const text = texts.map(v => String(v || "")).join(" ").trim();
  if(!text) return "";
  const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
  if(cyrillic >= 3 && cyrillic >= hebrew && cyrillic >= latin) return "ru";
  if(hebrew >= 3 && hebrew >= cyrillic) return "he";
  return "";
}

function inferVideoLanguage(meta={}, fallbackChannelLang=""){
  const candidates = [
    [meta.default_audio_language, "default_audio_language"],
    [meta.default_language, "default_language"],
    [fallbackChannelLang, "channel_language"],
  ];
  for(const [code, source] of candidates){
    const lang = normalizeLangCode(code);
    if(isSupportedLang(lang)) return { language_code: lang, language_source: source };
  }
  const guessed = guessLanguageFromText(meta.title, meta.description);
  if(guessed) return { language_code: guessed, language_source: "text_heuristic" };
  return { language_code: "unknown", language_source: "unknown" };
}

function channelVideoLanguageStmts(env, channel_int, language_code, source="video"){
  const lang = normalizeLangCode(language_code);
  if(!channel_int || !isSupportedLang(lang)) return [];

  const sourceText = source ? `video:${source}` : "video";
  const oneLangJson = JSON.stringify([lang]);
  const langJsonValue = JSON.stringify(lang);
  const langLike = `%"${lang}"%`;

  return [
    env.DB.prepare(`
      INSERT OR IGNORE INTO channel_languages(channel_int, language_code, source)
      VALUES(?, ?, ?)
    `).bind(channel_int, lang, sourceText),
    env.DB.prepare(`
      UPDATE channels
      SET
        language_code = CASE
          WHEN COALESCE(language_code, '') = '' THEN ?
          ELSE language_code
        END,
        language_source = CASE
          WHEN COALESCE(language_source, '') = '' THEN ?
          ELSE language_source
        END,
        languages_json = CASE
          WHEN COALESCE(languages_json, '') = '' OR languages_json = '[]' THEN ?
          WHEN languages_json LIKE ? THEN languages_json
          ELSE substr(languages_json, 1, length(languages_json) - 1) || ',' || ? || ']'
        END
      WHERE id = ?
    `).bind(lang, sourceText, oneLangJson, langLike, langJsonValue, channel_int)
  ];
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
      published_at: Number(raw?.published_at || 0) || 0,
      channel_language_code: raw?.channel_language_code || raw?.language_code || "",
      netfree_default_status: Number(raw?.netfree_default_status) === 0 ? 0 : 1
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
      const lang = inferVideoLanguage(meta || {}, row.channel_language_code || "");
      const videoKind = normalizeVideoKindForDb(meta?.video_kind);

      // vid כבר נוקה למעלה, לכן משתמשים ב-VALUES רגיל.
      // ב-Turso/libSQL זה בטוח יותר מ-INSERT ... SELECT ... WHERE ... ON CONFLICT.
      stmts.push(env.DB.prepare(`
        INSERT INTO videos(
          video_id, channel_int, title, published_at,
          video_kind, duration_sec,
          view_count, like_count, comment_count, stats_fetched_at,
          language_code, language_source, netfree_status, netfree_discovered_at, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          language_code    = CASE WHEN excluded.language_code IS NOT NULL AND excluded.language_code <> '' THEN excluded.language_code ELSE videos.language_code END,
          language_source  = CASE WHEN excluded.language_source IS NOT NULL AND excluded.language_source <> '' THEN excluded.language_source ELSE videos.language_source END,
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
          OR (excluded.language_code IS NOT NULL AND COALESCE(videos.language_code,'') != excluded.language_code)
      `).bind(
        vid,
        row.channel_int,
        title,
        publishedAt,
        videoKind,
        meta?.duration_sec ?? null,
        meta?.view_count ?? null,
        meta?.like_count ?? null,
        meta?.comment_count ?? null,
        meta ? ts : null,
        lang.language_code,
        lang.language_source,
        row.netfree_default_status,
        ts,
        ts
      ));

      stmts.push(...channelVideoLanguageStmts(env, row.channel_int, lang.language_code, lang.language_source));

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
async function upsertVideosAndMetaDirect(env, rows, ts){
  // גרסה חסכונית ל-cron: כל סרטון מקבל UPSERT אחד לטבלת videos,
  // video_details נשמר מיד, תגיות נשמרות מיד, ו-FTS כבוי כברירת מחדל כדי לא לשרוף subrequests.
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
        console.log("upsertVideosAndMetaDirect skip row without video id", JSON.stringify(raw || {}).slice(0, 500));
      }
      continue;
    }

    seen.add(vid);

    cleanRows.push({
      ...raw,
      vid,
      channel_int: raw?.channel_int,
      title: String(raw?.title || "").slice(0, 200) || "[untitled]",
      published_at: Number(raw?.published_at || 0) || 0,
      channel_language_code: raw?.channel_language_code || raw?.language_code || "",
      netfree_default_status: Number(raw?.netfree_default_status) === 0 ? 0 : 1
    });
  }

  const ids = cleanRows.map(r => r.vid).filter(Boolean);
  if (!ids.length) {
    return {
      videoRows: 0,
      metaRows: 0,
      tagRows: 0,
      skipped: (rows || []).length
    };
  }

  const existingRowsByVideoId = new Map();

  // בדיקה מרוכזת מראש: אם הסרטון כבר קיים ב-videos לא עושים לו UPSERT שוב.
  // זה חוסך constraint failed + existence check לכל סרטון, ובעיקר חוסך subrequests/CPU.
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const placeholders = part.map(() => "?").join(",");

    try {
      const existingRows = await env.DB.prepare(`
        SELECT id, video_id
        FROM videos
        WHERE video_id IN (${placeholders})
      `).bind(...part).all();

      for (const r of (existingRows?.results || [])) {
        if (r?.video_id) existingRowsByVideoId.set(String(r.video_id), r);
      }
    } catch (e) {
      console.log(`existing videos bulk check failed error=${String(e)}`);
    }
  }

  const metaMap = await fetchVideoMeta(env, ids);
  const writeFts = boolFromEnv(env.CRON_WRITE_FTS, false);
  const updateChannelLanguage = boolFromEnv(env.CRON_UPDATE_CHANNEL_LANGUAGE, false);
  const languageUpdateKeys = new Set();
  const languageUpdates = [];

  let videoRows = 0;
  let metaRows = 0;
  let tagRows = 0;
  let skipped = 0;

  function rememberLanguageUpdate(channelInt, languageCode, source){
    const lang = normalizeLangCode(languageCode);
    if(!channelInt || !isSupportedLang(lang)) return;

    const key = `${channelInt}|${lang}|${source || "video"}`;
    if(languageUpdateKeys.has(key)) return;

    languageUpdateKeys.add(key);
    languageUpdates.push({
      channel_int: channelInt,
      language_code: lang,
      language_source: source || "video"
    });
  }

  for (const row of cleanRows) {
    const vid = String(row.vid || "").trim();

    if (!vid) {
      skipped++;
      continue;
    }

    const meta = metaMap.get(vid) || null;
    const title = (meta?.title || row.title || "[untitled]").slice(0, 200);
    const publishedAt = toUnixSeconds(meta?.published_at_iso || "") || row.published_at || 0;
    const lang = inferVideoLanguage(meta || {}, row.channel_language_code || "");
    const safeLanguageCode = isSupportedLang(lang.language_code) ? normalizeLangCode(lang.language_code) : "";
    const safeLanguageSource = safeLanguageCode ? (lang.language_source || "") : "";
    const videoKind = normalizeVideoKindForDb(meta?.video_kind);
    let videoRowReady = false;

    const existingVideoRow = existingRowsByVideoId.get(vid) || null;

    if (existingVideoRow?.id) {
      // הסרטון כבר קיים. לא מעדכנים את videos שוב כדי לא ליפול על constraint/trigger.
      // אם הוא הגיע לכאן זה בגלל שחסר/צריך תיקון metadata, לכן ממשיכים ל-video_details.
      videoRowReady = true;
    } else {
      try {
        await env.DB.prepare(`
          INSERT INTO videos(
            video_id, channel_int, title, published_at,
            video_kind, duration_sec, view_count, like_count, comment_count, stats_fetched_at,
            language_code, language_source, netfree_status, netfree_discovered_at, updated_at
          )
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(video_id) DO NOTHING
        `).bind(
          vid,
          row.channel_int,
          title,
          publishedAt,
          videoKind,
          meta?.duration_sec ?? null,
          meta?.view_count ?? null,
          meta?.like_count ?? null,
          meta?.comment_count ?? null,
          meta ? ts : null,
          safeLanguageCode,
          safeLanguageSource,
          row.netfree_default_status,
          ts,
          ts
        ).run();

        if (safeLanguageCode) {
          rememberLanguageUpdate(row.channel_int, safeLanguageCode, safeLanguageSource);
        }

        videoRows++;
        videoRowReady = true;
      } catch (e) {
        skipped++;
        console.log(
          `video row insert failed channel_int=${row.channel_int} vid=${vid} ` +
          `title=${JSON.stringify(title).slice(0, 220)} error=${String(e)}`
        );

        // fallback אחרון בלבד: אם הבדיקה המרוכזת פספסה והסרטון כן קיים, עדיין נשמור metadata.
        try {
          const existing = await env.DB.prepare(`
            SELECT id
            FROM videos
            WHERE video_id = ?
            LIMIT 1
          `).bind(vid).first();

          if (existing?.id) {
            videoRowReady = true;
            console.log(`video row exists after insert failure; continuing metadata vid=${vid} rowid=${existing.id}`);
          }
        } catch (checkErr) {
          console.log(`video row existence check failed vid=${vid} error=${String(checkErr)}`);
        }

        if (!videoRowReady) {
          continue;
        }
      }
    }

    if (meta) {
      const detailStmts = videoDetailsStmts(env, vid, meta, ts);
      const ftsStmts = detailStmts.slice(-2);
      const tagStmts = detailStmts.slice(1, -2);

      try {
        await detailStmts[0].run();
        metaRows++;
      } catch (e) {
        console.log(
          `video_details upsert failed channel_int=${row.channel_int} vid=${vid} error=${String(e)}`
        );
        continue;
      }

      try {
        if (tagStmts.length) {
          tagRows += await runStatementsSequential(tagStmts);
        }
      } catch (e) {
        console.log(
          `video_tags index update failed channel_int=${row.channel_int} vid=${vid} error=${String(e)}`
        );
      }

      try {
        if (writeFts && ftsStmts.length) await env.DB.batch(ftsStmts);
      } catch (e) {
        console.log(
          `video_details_fts update failed channel_int=${row.channel_int} vid=${vid} error=${String(e)}`
        );
      }
    }
  }

  if (updateChannelLanguage) {
    for(const item of languageUpdates){
      try {
        const langStmts = channelVideoLanguageStmts(
          env,
          item.channel_int,
          item.language_code,
          item.language_source
        );

        if(langStmts.length) await env.DB.batch(langStmts);
      } catch (e) {
        console.log(
          `channel language update failed channel_int=${item.channel_int} ` +
          `lang=${item.language_code} error=${String(e)}`
        );
      }
    }
  }

  return {
    videoRows,
    metaRows,
    tagRows,
    skipped
  };
}


async function backfillSome(env, maxCalls=1){
  if(!env.YT_API_KEY) return 0;
  let totalImported = 0;

  const pageSize = intFromEnv(env.CRON_BACKFILL_PAGE_SIZE, 5, 1, 8);

  const rows = await env.DB.prepare(`
    SELECT cb.channel_int, cb.uploads_playlist_id, cb.next_page_token, c.language_code, c.netfree_default_status
    FROM channel_backfill cb
    JOIN channels c ON c.id = cb.channel_int
    WHERE cb.done=0 AND c.is_active=1
    ORDER BY cb.updated_at ASC, cb.channel_int ASC
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
      // שומרים על דף קטן כדי לא לעבור את מגבלת subrequests של Cloudflare/Turso.
      u.searchParams.set("maxResults", String(pageSize));
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
          published_at: toUnixSeconds(sn?.publishedAt || null) || 0,
          channel_language_code: r.language_code || "",
          netfree_default_status: r.netfree_default_status ?? 1
        });
      }

      if(videos.length){
        const videosToWrite = await filterVideosNeedingImportOrMeta(env, videos);

        const writeResult = videosToWrite.length
          ? await upsertVideosAndMetaDirect(env, videosToWrite, now)
          : {
              videoRows: 0,
              metaRows: 0,
              tagRows: 0,
              skipped: videos.length
            };

        totalImported += Math.max(Number(writeResult.videoRows || 0), Number(writeResult.metaRows || 0));

        console.log(
          `backfillSome page_items=${videos.length} ` +
          `to_write=${videosToWrite.length} ` +
          `video_rows=${writeResult.videoRows} ` +
          `meta_rows=${writeResult.metaRows} ` +
          `tag_rows=${writeResult.tagRows ?? 0} ` +
          `skipped=${writeResult.skipped} ` +
          `channel_int=${r.channel_int}`
        );
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

  return totalImported;
}

async function refreshMissingDetailsSome(env, limit=3){
  if(!env.YT_API_KEY) return;

  limit = Number(limit || 0);
  if(limit <= 0) return;

  const rows = await env.DB.prepare(`
    SELECT v.video_id
    FROM videos v
    LEFT JOIN video_details d ON d.video_id = v.video_id
    WHERE d.video_id IS NULL
    ORDER BY v.id DESC
    LIMIT ?
  `).bind(limit).all();

  const ids = (rows?.results || [])
    .map(r => String(r.video_id || "").trim())
    .filter(Boolean);

  if(!ids.length) return;

  const ts = nowSec();
  const metaMap = await fetchVideoMeta(env, ids);
  let detailsRows = 0;
  let statsRows = 0;
  let tagRows = 0;
  let missingFromYoutube = 0;
  const writeFts = boolFromEnv(env.CRON_WRITE_FTS, false);

  for(const vid of ids){
    const meta = metaMap.get(vid) || null;

    if(!meta){
      missingFromYoutube++;
      await env.DB.prepare(`
        UPDATE videos
        SET stats_fetched_at = COALESCE(stats_fetched_at, ?), updated_at = ?
        WHERE video_id = ?
      `).bind(ts, ts, vid).run();
      continue;
    }

    try {
      const videoKind = normalizeVideoKindForDb(meta.video_kind);
      await env.DB.prepare(`
        UPDATE videos
        SET
          title = CASE WHEN ? <> '' THEN ? ELSE title END,
          published_at = CASE WHEN ? > 0 THEN ? ELSE published_at END,
          video_kind = CASE WHEN ? IS NOT NULL THEN ? ELSE video_kind END,
          duration_sec = CASE WHEN ? IS NOT NULL THEN ? ELSE duration_sec END,
          view_count = CASE WHEN ? IS NOT NULL THEN ? ELSE view_count END,
          like_count = CASE WHEN ? IS NOT NULL THEN ? ELSE like_count END,
          comment_count = CASE WHEN ? IS NOT NULL THEN ? ELSE comment_count END,
          stats_fetched_at = ?,
          updated_at = ?
        WHERE video_id = ?
      `).bind(
        meta.title || "",
        meta.title || "",
        toUnixSeconds(meta.published_at_iso || "") || 0,
        toUnixSeconds(meta.published_at_iso || "") || 0,
        videoKind,
        videoKind,
        meta.duration_sec ?? null,
        meta.duration_sec ?? null,
        meta.view_count ?? null,
        meta.view_count ?? null,
        meta.like_count ?? null,
        meta.like_count ?? null,
        meta.comment_count ?? null,
        meta.comment_count ?? null,
        ts,
        ts,
        vid
      ).run();
      statsRows++;
    } catch (e) {
      console.log(`refreshMissingDetailsSome video update failed vid=${vid} error=${String(e)}`);
    }

    const detailStmts = videoDetailsStmts(env, vid, meta, ts);
    const ftsStmts = detailStmts.slice(-2);
    const tagStmts = detailStmts.slice(1, -2);

    try {
      // קודם שומרים video_details לבד, אחר כך video_tags, ובסוף FTS.
      await detailStmts[0].run();
      detailsRows++;
    } catch (e) {
      console.log(`refreshMissingDetailsSome video_details upsert failed vid=${vid} error=${String(e)}`);
      continue;
    }

    try {
      if(tagStmts.length) {
        tagRows += await runStatementsSequential(tagStmts);
      }
    } catch (e) {
      console.log(`refreshMissingDetailsSome video_tags update failed vid=${vid} error=${String(e)}`);
    }

    try {
      if(writeFts && ftsStmts.length) await env.DB.batch(ftsStmts);
    } catch (e) {
      console.log(`refreshMissingDetailsSome video_details_fts update failed vid=${vid} error=${String(e)}`);
    }
  }

  console.log(
    `refreshMissingDetailsSome checked=${ids.length} ` +
    `details_rows=${detailsRows} ` +
    `stats_rows=${statsRows} ` +
    `tag_rows=${tagRows} ` +
    `missing_from_youtube=${missingFromYoutube}`
  );
}


/** בדיקת פיד יומית (catch-up) */
async function catchUpFeeds(env, maxChannels=5){
  if(!env.YT_API_KEY) return;

  let lastId = parseInt(await getState(env, "feed_cursor", "0"), 10) || 0;

  async function loadRows(fromId){
    return env.DB.prepare(`
      SELECT id, channel_id, language_code, netfree_default_status
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
            published_at: e.published_at || 0,
            channel_language_code: ch.language_code || "",
            netfree_default_status: ch.netfree_default_status ?? 1
          });
        }

        if(videos.length){
          const videosToWrite = await filterVideosNeedingImportOrMeta(env, videos);

          if(!videosToWrite.length){
            console.log(
              `catchUpFeeds skipped existing videos ` +
              `checked=${videos.length} ` +
              `channel_int=${ch.id}`
            );
          } else {
            const writeResult = await upsertVideosAndMetaDirect(env, videosToWrite, now);
            console.log(
              `catchUpFeeds inserted new videos ` +
              `checked=${videos.length} ` +
              `to_write=${videosToWrite.length} ` +
              `video_rows=${writeResult.videoRows} ` +
              `meta_rows=${writeResult.metaRows} ` +
              `skipped=${writeResult.skipped} ` +
              `channel_int=${ch.id}`
            );
          }
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
  async fetch(request, env, ctx){
    env.DB = createDB(env);

    const url = new URL(request.url);
    if(url.pathname === "/" || url.pathname === "/health"){
      return new Response(JSON.stringify({
        ok: true,
        service: "youtube4-cron",
        message: "Cron worker is deployed. Scheduled jobs run from Cloudflare cron."
      }, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx){
    env.DB = createDB(env);
    console.log("youtube4-cron v14 safe-one-by-one-page1 2026-05-03");

    ctx.waitUntil((async ()=>{
      const started = nowSec();
      const writeCronState = boolFromEnv(env.CRON_WRITE_STATE, false);

      if(writeCronState){
        await setState(env, "cron_last_run", String(started));
      }

      let lastErr = "";
      const feedsPerRun = intFromEnv(env.CRON_FEEDS_PER_RUN, 0, 0, 5);

      if(feedsPerRun > 0){
        try { await catchUpFeeds(env, feedsPerRun); }
        catch (e) {
          if (!lastErr) lastErr = `catchUpFeeds: ${e?.stack || e}`;
          console.log(`catchUpFeeds error`, e);
        }
      }

      let backfillImported = 0;
      try { backfillImported = await backfillSome(env, intFromEnv(env.CRON_BACKFILL_CHANNELS, 1, 0, 1)); }
      catch (e) {
        if (!lastErr) lastErr = `backfillSome: ${e?.stack || e}`;
        console.log(`backfillSome error`, e);
      }

      // כדי לא להפיל את הקרון ממגבלת subrequests:
      // אם כבר הכנסנו סרטון מ-backfill, לא מריצים גם תיקון ישנים באותה ריצה.
      if(backfillImported > 0){
        console.log(`refreshMissingDetailsSome skipped because backfillImported=${backfillImported}`);
      } else {
        try { await refreshMissingDetailsSome(env, intFromEnv(env.CRON_REPAIR_META_PER_RUN, 0, 0, 10)); }
        catch (e) {
          if (!lastErr) lastErr = `refreshMissingDetailsSome: ${e?.stack || e}`;
          console.log(`refreshMissingDetailsSome error`, e);
        }
      }

      if(writeCronState){
        await setState(env, "cron_last_error", lastErr);
        if (!lastErr) await setState(env, "cron_last_ok", String(nowSec()));
      }
    })());
  }
};
