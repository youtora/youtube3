import { getDB } from "../_db.js";

function unauthorized() { return new Response("unauthorized", { status: 401 }); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function toUnixSeconds(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function ytJson(url) {
  const r = await fetch(url);
  const t = await r.text();
  if (!r.ok) throw new Error(`YT ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

function isChannelId(value) {
  return /^UC[a-zA-Z0-9_-]{22}$/.test(String(value || "").trim());
}

function tryExtractChannelId(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const directMatch = text.match(/\bUC[a-zA-Z0-9_-]{22}\b/);
  if (directMatch) return directMatch[0];

  try {
    const url = new URL(text);
    const parts = url.pathname.split("/").filter(Boolean);
    const channelIndex = parts.findIndex((p) => p.toLowerCase() === "channel");

    if (channelIndex !== -1 && parts[channelIndex + 1] && isChannelId(parts[channelIndex + 1])) {
      return parts[channelIndex + 1];
    }

    const qId = url.searchParams.get("channel_id");
    if (qId && isChannelId(qId)) return qId;
  } catch {}

  return null;
}

function normalizeYoutubeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  if (/^@[-a-zA-Z0-9._]+$/.test(text)) {
    return `https://www.youtube.com/${text}`;
  }

  if (/^(youtube\.com|www\.youtube\.com|m\.youtube\.com)\//i.test(text)) {
    return `https://${text}`;
  }

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();

    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      return url.toString();
    }
  } catch {}

  return null;
}

function extractChannelIdFromHtml(html) {
  const patterns = [
    /"externalId":"(UC[a-zA-Z0-9_-]{22})"/,
    /"channelId":"(UC[a-zA-Z0-9_-]{22})"/,
    /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[a-zA-Z0-9_-]{22})["']/i,
    /<meta[^>]+content=["'](UC[a-zA-Z0-9_-]{22})["'][^>]+itemprop=["']channelId["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})\/?["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']https?:\/\/(?:www\.)?youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})\/?["']/i,
  ];

  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }

  return null;
}

async function resolveChannelIdFromInput(rawInput) {
  const direct = tryExtractChannelId(rawInput);
  if (direct) {
    return { channel_id: direct, resolved_via: "direct" };
  }

  const url = normalizeYoutubeUrl(rawInput);
  if (!url) {
    throw new Error("unrecognized channel input");
  }

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; YoutoraBot/1.0)",
      "accept-language": "en-US,en;q=0.9"
    }
  });

  const html = await res.text();
  if (!res.ok) {
    throw new Error(`failed to resolve channel url: ${res.status}`);
  }

  const channel_id = extractChannelIdFromHtml(html);
  if (!channel_id) {
    throw new Error("could not extract channel_id from page");
  }

  return { channel_id, resolved_via: "html" };
}

/** מוציא VIDEO_ID מתוך URL של ytimg, כדי לשמור רק מזהה */
function extractVideoIdFromThumbUrl(url) {
  if (!url) return null;
  const m = url.match(/\/vi(?:_webp)?\/([a-zA-Z0-9_-]{11})\//);
  return m ? m[1] : null;
}

function pickPlaylistThumbVideoId(thumbnails) {
  if (!thumbnails) return null;
  const urls = [
    thumbnails.medium?.url,
    thumbnails.default?.url,
    thumbnails.high?.url,
    thumbnails.maxres?.url,
  ].filter(Boolean);

  for (const u of urls) {
    const id = extractVideoIdFromThumbUrl(u);
    if (id) return id;
  }
  return null;
}

async function importPlaylistsForChannel({ env, DB, channel_int, channel_id, max_pages = 10 }) {
  if (!env.YT_API_KEY) return { ok: false, reason: "missing YT_API_KEY", imported: 0 };

  let pageToken = null;
  let imported = 0;

  for (let page = 0; page < max_pages; page++) {
    const url =
      `https://www.googleapis.com/youtube/v3/playlists` +
      `?part=snippet,contentDetails&maxResults=50` +
      `&channelId=${encodeURIComponent(channel_id)}` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ``) +
      `&key=${encodeURIComponent(env.YT_API_KEY)}`;

    const data = await ytJson(url);
    const items = data?.items || [];
    if (!items.length && !data?.nextPageToken) break;

    const stmts = [];
    const now = nowSec();

    for (const it of items) {
      const playlist_id = it?.id || null;
      if (!playlist_id) continue;

      const title = (it?.snippet?.title || "").slice(0, 200) || null;
      const published_at = toUnixSeconds(it?.snippet?.publishedAt || null);
      const item_count = Number.isFinite(it?.contentDetails?.itemCount)
        ? it.contentDetails.itemCount
        : null;

      const thumb_video_id = pickPlaylistThumbVideoId(it?.snippet?.thumbnails);

      stmts.push(
        DB.prepare(`
          INSERT INTO playlists(playlist_id, channel_int, title, thumb_video_id, published_at, item_count, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(playlist_id) DO UPDATE SET
            channel_int    = excluded.channel_int,
            title          = COALESCE(excluded.title, playlists.title),
            thumb_video_id = COALESCE(excluded.thumb_video_id, playlists.thumb_video_id),
            published_at   = COALESCE(excluded.published_at, playlists.published_at),
            item_count     = COALESCE(excluded.item_count, playlists.item_count),
            updated_at     = excluded.updated_at
        `).bind(playlist_id, channel_int, title, thumb_video_id, published_at, item_count, now)
      );

      imported++;
    }

    if (stmts.length) await DB.batch(stmts);

    pageToken = data?.nextPageToken || null;
    if (!pageToken) break;
  }

  return { ok: true, imported };
}

async function subscribeWebSub({ env, DB, request, channel_id, channel_int }) {
  const t = nowSec();
  const origin = new URL(request.url).origin;
  const callback = `${origin}/websub/youtube`;
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${encodeURIComponent(channel_id)}`;
  const hub = "https://pubsubhubbub.appspot.com/subscribe";

  const existing = await DB.prepare(`
    SELECT status, lease_expires_at
    FROM subscriptions
    WHERE topic_url=?
  `).bind(topic).first();

  const MIN_REMAINING = 2 * 24 * 3600;
  if (existing?.status === "active" && Number.isFinite(existing?.lease_expires_at) && existing.lease_expires_at > t + MIN_REMAINING) {
    return { ok: true, skipped: true, reason: "already active", topic, hub_status: null };
  }

  const params = new URLSearchParams();
  params.set("hub.mode", "subscribe");
  params.set("hub.callback", callback);
  params.set("hub.topic", topic);
  params.set("hub.verify", "async");

  if (!env.WEBSUB_VERIFY_TOKEN) {
    const last_error = "missing WEBSUB_VERIFY_TOKEN";

    await DB.prepare(`
      INSERT INTO subscriptions(topic_url, channel_int, status, last_subscribed_at, last_error)
      VALUES(?, ?, 'pending', ?, ?)
      ON CONFLICT(topic_url) DO UPDATE SET
        channel_int = excluded.channel_int,
        status = CASE
          WHEN subscriptions.status='active' THEN 'active'
          ELSE 'pending'
        END,
        last_subscribed_at = excluded.last_subscribed_at,
        last_error = excluded.last_error
    `).bind(topic, channel_int, t, last_error).run();

    return { ok: false, skipped: false, reason: last_error, topic, hub_status: null, last_error };
  }
  params.set("hub.verify_token", env.WEBSUB_VERIFY_TOKEN);

  if (env.WEBSUB_SECRET) params.set("hub.secret", env.WEBSUB_SECRET);

  const res = await fetch(hub, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const last_error = res.ok ? null : `hub subscribe failed: ${res.status}`;

  await DB.prepare(`
    INSERT INTO subscriptions(topic_url, channel_int, status, last_subscribed_at, last_error)
    VALUES(?, ?, 'pending', ?, ?)
    ON CONFLICT(topic_url) DO UPDATE SET
      channel_int = excluded.channel_int,
      status = CASE
        WHEN subscriptions.status='active' THEN 'active'
        ELSE 'pending'
      END,
      last_subscribed_at = excluded.last_subscribed_at,
      last_error = excluded.last_error
  `).bind(topic, channel_int, t, last_error).run();

  return { ok: res.ok, skipped: false, topic, hub_status: res.status, last_error };
}

export async function onRequest({ env, request }) {
  const DB = getDB(env);
  const runtimeEnv = { ...env, DB };
  if (request.method !== "POST") return new Response("use POST", { status: 200 });

  const body = await request.json().catch(() => ({}));
  const raw_input = String(body.raw_input || "").trim();
  const requested_channel_id = String(body.channel_id || "").trim();
  const playlists_pages = Math.min(Math.max(parseInt(body.playlists_pages || "10", 10), 1), 30);

  let resolved;
  try {
    resolved = await resolveChannelIdFromInput(requested_channel_id || raw_input);
  } catch (err) {
    return Response.json({
      ok: false,
      error: String(err?.message || err || "failed to resolve channel"),
      input: requested_channel_id || raw_input || null
    }, { status: 400 });
  }

  const channel_id = resolved.channel_id;
  const resolved_via = resolved.resolved_via;

  if (!channel_id) {
    return Response.json({ ok: false, error: "missing channel_id" }, { status: 400 });
  }

  const t = nowSec();
  let title = null, thumb = null, uploads = null;

  if (env.YT_API_KEY) {
    const data = await ytJson(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&id=${encodeURIComponent(channel_id)}&key=${encodeURIComponent(env.YT_API_KEY)}`
    );
    const item = data?.items?.[0];
    title = item?.snippet?.title || null;
    thumb =
      item?.snippet?.thumbnails?.default?.url ||
      item?.snippet?.thumbnails?.medium?.url ||
      item?.snippet?.thumbnails?.high?.url ||
      null;
    uploads = item?.contentDetails?.relatedPlaylists?.uploads || null;
  }

  await DB.prepare(`
    INSERT INTO channels(channel_id, title, thumbnail_url, is_active, created_at, updated_at)
    VALUES(?, ?, ?, 1, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      title = COALESCE(excluded.title, channels.title),
      thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
      is_active = 1,
      updated_at = excluded.updated_at
  `).bind(channel_id, title, thumb, t, t).run();

  const ch = await DB.prepare(`SELECT id FROM channels WHERE channel_id=?`).bind(channel_id).first();
  if (!ch) return new Response("failed to load channel row", { status: 500 });
  const channel_int = ch.id;

  await DB.prepare(`
    INSERT INTO channel_backfill(channel_int, uploads_playlist_id, next_page_token, done, imported_count, updated_at)
    VALUES(?, ?, NULL, 0, 0, ?)
    ON CONFLICT(channel_int) DO UPDATE SET
      uploads_playlist_id = COALESCE(excluded.uploads_playlist_id, channel_backfill.uploads_playlist_id),
      updated_at = excluded.updated_at
  `).bind(channel_int, uploads, t).run();

  const websub = await subscribeWebSub({ env: runtimeEnv, DB, request, channel_id, channel_int });

  const playlists = await importPlaylistsForChannel({
    env: runtimeEnv,
    DB,
    channel_int,
    channel_id,
    max_pages: playlists_pages
  });

  return Response.json({
    ok: true,
    input: requested_channel_id || raw_input || channel_id,
    channel_id,
    resolved_via,
    channel_int,
    title,
    uploads_playlist_id: uploads,
    websub,
    playlists
  });
}
