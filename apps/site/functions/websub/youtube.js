import { getDB } from "../_db.js";

// functions/websub/youtube.js

function nowSec() {
  return Math.floor(Date.now() / 1000);
}
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

function parseIsoDurationSec(iso) {
  const m = String(iso || "").match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const days = parseInt(m[1] || "0", 10);
  const hours = parseInt(m[2] || "0", 10);
  const mins = parseInt(m[3] || "0", 10);
  const secs = parseInt(m[4] || "0", 10);
  return (((days * 24) + hours) * 60 + mins) * 60 + secs;
}



function classifyVideoItem(it) {
  if (it?.liveStreamingDetails) return "L";

  const sec = parseIsoDurationSec(it?.contentDetails?.duration || "");
  if (!(Number.isFinite(sec) && sec > 0 && sec <= 180)) return "";

  const w = Number(it?.player?.embedWidth || 0);
  const h = Number(it?.player?.embedHeight || 0);

  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > w) {
    return "S";
  }

  return "";
}

async function ytJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`YT ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

function extractDurationSec(it) {
  const sec = parseIsoDurationSec(it?.contentDetails?.duration || "");
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

function buildVideoMeta(it) {
  return {
    video_kind: classifyVideoItem(it),
    duration_sec: extractDurationSec(it)
  };
}

async function fetchVideoMeta(env, ids) {
  const out = new Map();
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!env.YT_API_KEY || !uniq.length) return out;

  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const u = new URL("https://www.googleapis.com/youtube/v3/videos");
    u.searchParams.set("part", "contentDetails,liveStreamingDetails,player");
    u.searchParams.set("id", chunk.join(","));
    u.searchParams.set("maxResults", String(chunk.length));
    u.searchParams.set("maxWidth", "8192");
    u.searchParams.set("maxHeight", "8192");
    u.searchParams.set("key", env.YT_API_KEY);

    const data = await ytJson(u.toString());
    for (const it of (data?.items || [])) {
      if (it?.id) out.set(it.id, buildVideoMeta(it));
    }
  }

  return out;
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
  const DB = getDB(env);
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
      ? await DB.prepare(`SELECT id FROM channels WHERE channel_id=? LIMIT 1`).bind(channelId).first()
      : null;

    const channelInt = ch?.id ?? null;

    if (topic && channelInt) {
      await DB.prepare(`
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

    if (topicHdr) {
      const sub = await DB.prepare(`
        SELECT channel_int
        FROM subscriptions
        WHERE topic_url=?
        LIMIT 1
      `).bind(topicHdr).first();

      channelInt = sub?.channel_int ?? null;
    }

    if (!channelInt) {
      const channelId = channelIdFromTopic(topicHdr) || (entries.find(e => e.channelId)?.channelId || null);

      if (channelId) {
        const ch = await DB.prepare(`
          SELECT id
          FROM channels
          WHERE channel_id=?
          LIMIT 1
        `).bind(channelId).first();

        channelInt = ch?.id ?? null;
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
      const title = (e.title || "").slice(0, 200);
      const meta = videoMeta.get(e.videoId) || {};
      const videoKind = meta.video_kind ?? null;
      const durationSec = meta.duration_sec ?? null;
      stmts.push(DB.prepare(`
        INSERT INTO videos(video_id, channel_int, title, published_at, video_kind, duration_sec, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          channel_int   = excluded.channel_int,
          title         = excluded.title,
          published_at  = CASE WHEN excluded.published_at > 0 THEN excluded.published_at ELSE videos.published_at END,
          video_kind    = CASE WHEN excluded.video_kind IS NOT NULL THEN excluded.video_kind ELSE videos.video_kind END,
          duration_sec  = CASE WHEN excluded.duration_sec IS NOT NULL THEN excluded.duration_sec ELSE videos.duration_sec END,
          updated_at    = excluded.updated_at
        WHERE
          videos.channel_int IS NOT excluded.channel_int
          OR videos.title IS NOT excluded.title
          OR (excluded.published_at > 0 AND videos.published_at != excluded.published_at)
          OR (excluded.video_kind IS NOT NULL AND COALESCE(videos.video_kind, '') != excluded.video_kind)
          OR (excluded.duration_sec IS NOT NULL AND COALESCE(videos.duration_sec, -1) != excluded.duration_sec)
      `).bind(e.videoId, channelInt, title, e.published_at ?? 0, videoKind, durationSec, now));
    }

    if (stmts.length) await DB.batch(stmts);

    console.log("websub POST saved", { channelInt, entries: entries.length, first: entries[0]?.videoId || null });

    if (debug) return json({ ok: true, channelInt, entries: entries.length, first: entries[0]?.videoId || null });
    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
