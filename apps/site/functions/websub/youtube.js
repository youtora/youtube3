import { getDB } from "../_db.js";
// functions/websub/youtube.js
import { fetchVideoMeta, videoDetailsStmts, nowSec, inferVideoLanguage } from "../_shared/video-meta.js";
import { channelVideoLanguageStmts } from "../_shared/language.js";

function canonicalTopicUrl(topic) {
  const t = (topic || "").trim();
  if (!t) return "";

  return t.replace(
    "https://www.youtube.com/feeds/videos.xml",
    "https://www.youtube.com/xml/feeds/videos.xml"
  );
}

function toUnixSeconds(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function decodeXml(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function matchText(s, re) {
  const m = (s || "").match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

function extractEntries(xml) {
  const out = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;

  while ((m = entryRe.exec(xml))) {
    const e = m[1];

    const videoId = matchText(e, /<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoId) continue;

    const channelId = matchText(e, /<yt:channelId>([^<]+)<\/yt:channelId>/) || null;
    const title = matchText(e, /<title>([^<]+)<\/title>/) || "";
    const published = matchText(e, /<published>([^<]+)<\/published>/);

    out.push({
      videoId,
      channelId,
      title,
      published_at: toUnixSeconds(published || null) ?? 0
    });
  }

  return out;
}

function channelIdFromTopic(topic) {
  const t = (topic || "").trim();
  const m = t.match(/[?&]channel_id=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function sha1HmacHex(secret, bodyU8) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, bodyU8);
  const b = new Uint8Array(sig);

  let hex = "";
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0");
  return hex;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug") === "1";

  if (request.method === "GET") {
    const mode = (url.searchParams.get("hub.mode") || "").trim();
    const topicRaw = (url.searchParams.get("hub.topic") || "").trim();
    const topic = canonicalTopicUrl(topicRaw);
    const challenge = (url.searchParams.get("hub.challenge") || "").trim();
    const verifyToken = (url.searchParams.get("hub.verify_token") || "").trim();
    const leaseSec = parseInt(url.searchParams.get("hub.lease_seconds") || "0", 10) || 0;

    if (!challenge) return new Response("missing hub.challenge", { status: 400 });

    if (!env.WEBSUB_VERIFY_TOKEN) {
      console.log("websub GET missing WEBSUB_VERIFY_TOKEN");
      return new Response("missing WEBSUB_VERIFY_TOKEN", { status: 500 });
    }

    if (verifyToken !== env.WEBSUB_VERIFY_TOKEN) {
      console.log("websub GET bad verify_token");
      return new Response("bad verify_token", { status: 403 });
    }

    const now = nowSec();
    const leaseExp = leaseSec ? (now + leaseSec) : null;

    const channelId = channelIdFromTopic(topic);
    const ch = channelId
      ? await env.DB.prepare(`SELECT id FROM channels WHERE channel_id=? LIMIT 1`).bind(channelId).first()
      : null;

    const channelInt = ch?.id ?? null;

    if (topic && channelInt) {
      await env.DB.prepare(`
        INSERT INTO subscriptions(topic_url, channel_int, status, lease_expires_at, last_subscribed_at, last_error)
        VALUES(?, ?, 'active', ?, ?, NULL)
        ON CONFLICT(topic_url) DO UPDATE SET
          channel_int        = excluded.channel_int,
          status             = 'active',
          lease_expires_at   = excluded.lease_expires_at,
          last_subscribed_at = excluded.last_subscribed_at,
          last_error         = NULL
      `).bind(topic, channelInt, leaseExp, now).run();
    } else {
      console.log("websub GET verified but channel_int missing", {
        mode,
        topic: topic ? topic.slice(0, 140) : null,
        channelId,
        channelInt
      });
    }

    console.log("websub GET verified", {
      topic: topic ? topic.slice(0, 140) : null,
      channelId,
      channelInt,
      leaseSec
    });

    return new Response(challenge, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  if (request.method === "POST") {
    const bodyBuf = await request.arrayBuffer();
    const bodyU8 = new Uint8Array(bodyBuf);

    const topicHdrRaw = (request.headers.get("x-hub-topic") || "").trim();
    const topicHdr = canonicalTopicUrl(topicHdrRaw);
    const sigHdr = (request.headers.get("x-hub-signature") || "").trim().toLowerCase();

    console.log("websub POST hit", {
      hasSig: !!sigHdr,
      topic: topicHdr ? topicHdr.slice(0, 140) : null,
      len: bodyU8.byteLength
    });

    if (!env.WEBSUB_SECRET) {
      console.log("websub POST missing WEBSUB_SECRET");
      return new Response("missing WEBSUB_SECRET", { status: 500 });
    }

    const m = sigHdr.match(/^sha1=([0-9a-f]{40})$/i);
    if (!m) return new Response("bad signature", { status: 403 });

    const got = m[1].toLowerCase();
    const exp = await sha1HmacHex(env.WEBSUB_SECRET, bodyU8);
    if (got !== exp) return new Response("bad signature", { status: 403 });

    const xml = new TextDecoder("utf-8").decode(bodyU8);
    const entries = extractEntries(xml);

    if (!entries.length) {
      if (debug) return json({ ok: true, entries: 0, saved: 0 });
      return new Response(null, { status: 204 });
    }

    let channelInt = null;
    let channelLanguageCode = "";
    let netfreeDefaultStatus = 1;

    if (topicHdr) {
      const sub = await env.DB.prepare(`
        SELECT s.channel_int, c.language_code, c.netfree_default_status
        FROM subscriptions s
        LEFT JOIN channels c ON c.id = s.channel_int
        WHERE topic_url=?
        LIMIT 1
      `).bind(topicHdr).first();

      channelInt = sub?.channel_int ?? null;
      channelLanguageCode = sub?.language_code || "";
      netfreeDefaultStatus = sub?.netfree_default_status ?? 1;
    }

    if (!channelInt) {
      const channelId = channelIdFromTopic(topicHdr) || (entries.find(e => e.channelId)?.channelId || null);

      if (channelId) {
        const ch = await env.DB.prepare(`
          SELECT id, language_code, netfree_default_status
          FROM channels
          WHERE channel_id=?
          LIMIT 1
        `).bind(channelId).first();

        channelInt = ch?.id ?? null;
        channelLanguageCode = ch?.language_code || channelLanguageCode || "";
        netfreeDefaultStatus = ch?.netfree_default_status ?? netfreeDefaultStatus;
      }
    }

    if (!channelInt) {
      console.log("websub POST no channel_int (skip)", {
        topic: topicHdr ? topicHdr.slice(0, 140) : null,
        entries: entries.length
      });

      if (debug) return json({ ok: false, reason: "no channel_int", entries: entries.length, topic: topicHdr || null });
      return new Response(null, { status: 204 });
    }

    const now = nowSec();
    const videoMeta = await fetchVideoMeta(env, entries.map(e => e.videoId));
    const stmts = [];

    for (const e of entries) {
      const meta = videoMeta.get(e.videoId) || {};
      const title = (meta.title || e.title || "").slice(0, 200);
      const videoKind = meta.video_kind ?? null;
      const durationSec = meta.duration_sec ?? null;
      const viewCount = meta.view_count ?? null;
      const likeCount = meta.like_count ?? null;
      const commentCount = meta.comment_count ?? null;
      const statsFetchedAt = videoMeta.has(e.videoId) ? now : null;
      const lang = inferVideoLanguage(meta, channelLanguageCode);

      stmts.push(env.DB.prepare(`
        INSERT INTO videos(
          video_id, channel_int, title, published_at,
          video_kind, duration_sec, view_count, like_count, comment_count, stats_fetched_at,
          language_code, language_source, netfree_status, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          channel_int      = excluded.channel_int,
          title            = excluded.title,
          published_at     = CASE WHEN excluded.published_at > 0 THEN excluded.published_at ELSE videos.published_at END,
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
          OR (excluded.published_at > 0 AND videos.published_at != excluded.published_at)
          OR (excluded.video_kind IS NOT NULL AND COALESCE(videos.video_kind, '') != excluded.video_kind)
          OR (excluded.duration_sec IS NOT NULL AND COALESCE(videos.duration_sec, -1) != excluded.duration_sec)
          OR (excluded.view_count IS NOT NULL AND COALESCE(videos.view_count, -1) != excluded.view_count)
          OR (excluded.like_count IS NOT NULL AND COALESCE(videos.like_count, -1) != excluded.like_count)
          OR (excluded.comment_count IS NOT NULL AND COALESCE(videos.comment_count, -1) != excluded.comment_count)
          OR (excluded.language_code IS NOT NULL AND COALESCE(videos.language_code,'') != excluded.language_code)
      `).bind(e.videoId, channelInt, title, e.published_at ?? 0, videoKind, durationSec, viewCount, likeCount, commentCount, statsFetchedAt, lang.language_code, lang.language_source, netfreeDefaultStatus, now));

      stmts.push(...channelVideoLanguageStmts(env.DB, channelInt, lang.language_code, lang.language_source));

      if (videoMeta.has(e.videoId)) {
        stmts.push(...videoDetailsStmts(env, e.videoId, meta, now));
      }
    }

    if (stmts.length) await env.DB.batch(stmts);

    console.log("websub POST saved", { channelInt, entries: entries.length, first: entries[0]?.videoId || null });

    if (debug) return json({ ok: true, channelInt, entries: entries.length, first: entries[0]?.videoId || null });
    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
