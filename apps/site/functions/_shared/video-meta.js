import { inferVideoLanguage } from "./language.js";

export { inferVideoLanguage };

export function nowSec(){
  return Math.floor(Date.now() / 1000);
}

export function parseIsoDurationSec(iso){
  const m = String(iso || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if(!m) return null;
  const days = parseInt(m[1] || "0", 10);
  const hours = parseInt(m[2] || "0", 10);
  const mins = parseInt(m[3] || "0", 10);
  const secs = parseInt(m[4] || "0", 10);
  return (((days * 24) + hours) * 60 + mins) * 60 + secs;
}

export function classifyVideoItem(it){
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

export function extractDurationSec(it){
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

export function extractHashtags(...texts){
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

export function buildVideoMeta(it){
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

async function ytJson(url){
  const r = await fetch(url);
  const t = await r.text();
  if(!r.ok) throw new Error(`YT ${r.status}: ${t.slice(0,200)}`);
  return JSON.parse(t);
}

export async function fetchVideoMeta(env, ids){
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

  for(const item of items){
    // הכנסה פשוטה ויציבה: בלי UNION, בלי json_each, בלי SQL דינמי.
    // הטריגר על video_tags יעדכן אוטומטית את tag_stats.
    stmts.push(env.DB.prepare(`
      INSERT OR IGNORE INTO video_tags(video_id, tag_type, tag_value, tag_norm, video_rowid)
      SELECT ?, ?, ?, ?, v.id
      FROM videos AS v
      WHERE v.video_id = ?
      LIMIT 1
    `).bind(videoId, item.type, item.value, item.norm, videoId));
  }

  return stmts;
}
export function videoDetailsStmts(env, videoId, meta, ts){
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
    ...videoTagIndexStmts(env, videoId, tags, hashtags),
    env.DB.prepare(`DELETE FROM video_details_fts WHERE video_id = ?`).bind(videoId),
    env.DB.prepare(`
      INSERT INTO video_details_fts(video_id, description, tags, hashtags)
      VALUES(?, ?, ?, ?)
    `).bind(videoId, description, tagsText, hashtagsText)
  ];
}

export function parseJsonArray(value){
  try {
    const arr = JSON.parse(value || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
