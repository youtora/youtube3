import { getDB } from "../_db.js";
import { fetchVideoMeta as fetchFullVideoMeta, videoDetailsStmts, inferVideoLanguage } from "../_shared/video-meta.js";
import { buildChannelLanguage, channelLanguageStmts } from "../_shared/language.js";

function unauthorized() { return new Response("unauthorized", { status: 401 }); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function toUnixSeconds(iso) {
  const ms = Date.parse(iso || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function safeJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch (_) {
    return JSON.stringify(fallback);
  }
}

function pickBestThumbnail(thumbnails) {
  return thumbnails?.high?.url ||
    thumbnails?.medium?.url ||
    thumbnails?.default?.url ||
    null;
}

const YOUTUBE_DESKTOP_BANNER_SUFFIX = "=w1707-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj";

function formatChannelBannerUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  if (raw.includes("yt3.googleusercontent.com/") && !raw.includes("=w") && !raw.includes("-fcrop64=")) {
    return raw + YOUTUBE_DESKTOP_BANNER_SUFFIX;
  }

  return raw;
}

function buildChannelMeta(item) {
  const sn = item?.snippet || {};
  const brandingChannel = item?.brandingSettings?.channel || {};
  const brandingImage = item?.brandingSettings?.image || {};
  const topics = item?.topicDetails || {};
  const langMeta = buildChannelLanguage({ snippet: sn, brandingChannel, localizations: item?.localizations || {} });

  return {
    title: sn.title || null,
    description: sn.description || "",
    custom_url: sn.customUrl || "",
    published_at: toUnixSeconds(sn.publishedAt || null),
    thumbnail_url: pickBestThumbnail(sn.thumbnails),
    banner_url: formatChannelBannerUrl(
      brandingImage.bannerExternalUrl ||
      brandingImage.bannerTvImageUrl ||
      brandingImage.bannerTabletExtraHdImageUrl ||
      brandingImage.bannerMobileExtraHdImageUrl ||
      brandingImage.bannerImageUrl ||
      ""
    ),
    country: sn.country || brandingChannel.country || "",
    default_language: sn.defaultLanguage || brandingChannel.defaultLanguage || "",
    localized_title: sn.localized?.title || "",
    localized_description: sn.localized?.description || "",
    uploads_playlist_id: item?.contentDetails?.relatedPlaylists?.uploads || null,

    branding_title: brandingChannel.title || "",
    branding_description: brandingChannel.description || "",
    branding_keywords: brandingChannel.keywords || "",
    branding_default_language: brandingChannel.defaultLanguage || "",
    branding_country: brandingChannel.country || "",
    unsubscribed_trailer: brandingChannel.unsubscribedTrailer || "",

    topic_categories_json: safeJson(topics.topicCategories || [], []),
    topic_ids_json: safeJson(topics.topicIds || [], []),
    localizations_json: safeJson(item?.localizations || {}, {}),
    language_code: langMeta.language_code,
    language_source: langMeta.language_source,
    languages_json: langMeta.languages_json,
    languages: langMeta.languages,
  };
}

async function fetchChannelMeta(env, channel_id) {
  if (!env.YT_API_KEY) return { ok: false, error: "missing YT_API_KEY", meta: null };

  const u = new URL("https://www.googleapis.com/youtube/v3/channels");
  u.searchParams.set("part", "snippet,contentDetails,brandingSettings,topicDetails,localizations");
  u.searchParams.set("id", channel_id);
  u.searchParams.set("key", env.YT_API_KEY);

  const data = await ytJson(u.toString());
  const item = data?.items?.[0];
  if (!item) return { ok: false, error: "channel not found in YouTube API", meta: null };

  return { ok: true, error: "", meta: buildChannelMeta(item) };
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

function extractDurationSec(it) {
  const sec = parseIsoDurationSec(it?.contentDetails?.duration || "");
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

function buildVideoMeta(it) {
  return {
    video_kind: classifyVideoItem(it),
    duration_sec: extractDurationSec(it),
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

async function importRecentVideosForChannel({ env, DB, channel_int, uploads_playlist_id, channel_language_code = "", max_pages = 2 }) {
  if (!env.YT_API_KEY) return { ok: false, reason: "missing YT_API_KEY", imported: 0, next_page_token: null, done: 0 };
  if (!uploads_playlist_id) return { ok: false, reason: "missing uploads playlist", imported: 0, next_page_token: null, done: 1 };

  let pageToken = null;
  let imported = 0;

  for (let page = 0; page < max_pages; page++) {
    const u = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    u.searchParams.set("part", "snippet,contentDetails");
    u.searchParams.set("playlistId", uploads_playlist_id);
    u.searchParams.set("maxResults", "50");
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    u.searchParams.set("key", env.YT_API_KEY);

    const data = await ytJson(u.toString());
    const items = data?.items || [];
    const metaMap = await fetchFullVideoMeta(env, items.map((it) => it?.contentDetails?.videoId).filter(Boolean));
    const stmts = [];
    const now = nowSec();

    for (const it of items) {
      const vid = it?.contentDetails?.videoId || null;
      if (!vid) continue;

      const sn = it?.snippet || {};
      const meta = metaMap.get(vid) || {};
      const title = (meta.title || sn?.title || "").slice(0, 200);
      const published_at = toUnixSeconds(meta.published_at_iso || sn?.publishedAt || null) ?? 0;
      const video_kind = meta.video_kind ?? null;
      const duration_sec = meta.duration_sec ?? null;
      const view_count = meta.view_count ?? null;
      const like_count = meta.like_count ?? null;
      const comment_count = meta.comment_count ?? null;
      const stats_fetched_at = metaMap.has(vid) ? now : null;
      const lang = inferVideoLanguage(meta, channel_language_code);

      stmts.push(DB.prepare(`
        INSERT INTO videos(
          video_id, channel_int, title, published_at,
          video_kind, duration_sec, view_count, like_count, comment_count, stats_fetched_at,
          language_code, language_source, updated_at
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(video_id) DO UPDATE SET
          channel_int=excluded.channel_int,
          title=excluded.title,
          published_at=CASE WHEN excluded.published_at > 0 THEN excluded.published_at ELSE videos.published_at END,
          video_kind=CASE WHEN excluded.video_kind IS NOT NULL THEN excluded.video_kind ELSE videos.video_kind END,
          duration_sec=CASE WHEN excluded.duration_sec IS NOT NULL THEN excluded.duration_sec ELSE videos.duration_sec END,
          view_count=CASE WHEN excluded.view_count IS NOT NULL THEN excluded.view_count ELSE videos.view_count END,
          like_count=CASE WHEN excluded.like_count IS NOT NULL THEN excluded.like_count ELSE videos.like_count END,
          comment_count=CASE WHEN excluded.comment_count IS NOT NULL THEN excluded.comment_count ELSE videos.comment_count END,
          stats_fetched_at=CASE WHEN excluded.stats_fetched_at IS NOT NULL THEN excluded.stats_fetched_at ELSE videos.stats_fetched_at END,
          language_code=CASE WHEN excluded.language_code IS NOT NULL AND excluded.language_code <> '' THEN excluded.language_code ELSE videos.language_code END,
          language_source=CASE WHEN excluded.language_source IS NOT NULL AND excluded.language_source <> '' THEN excluded.language_source ELSE videos.language_source END,
          updated_at=excluded.updated_at
      `).bind(
        vid, channel_int, title, published_at,
        video_kind, duration_sec, view_count, like_count, comment_count, stats_fetched_at,
        lang.language_code, lang.language_source, now
      ));

      if (metaMap.has(vid)) {
        stmts.push(...videoDetailsStmts(env, vid, meta, now));
      }

      imported++;
    }

    if (stmts.length) await DB.batch(stmts);

    pageToken = data?.nextPageToken || null;
    if (!pageToken) break;
  }

  return {
    ok: true,
    imported,
    next_page_token: pageToken,
    done: pageToken ? 0 : 1,
  };
}

async function subscribeWebSub({ env, DB, request, channel_id, channel_int }) {
  const t = nowSec();
  // כמו בקוד הישן: תמיד להשתמש בדומיין שממנו בוצעה הקריאה.
  // זה מונע מצב שבו WEBSUB_CALLBACK_URL ישן/שגוי גורם להרשמות להישאר pending.
  const origin = new URL(request.url).origin;
  const callback = `${origin}/websub/youtube`;
  const topic = `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${encodeURIComponent(channel_id)}`;
  // כמו בקוד הישן: Hub הרשמי של YouTube/WebSub.
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
  env.DB = DB;
  const runtimeEnv = { ...env, DB };
  if (request.method !== "POST") return new Response("use POST", { status: 200 });

  const body = await request.json().catch(() => ({}));
  const raw_input = String(body.raw_input || "").trim();
  const requested_channel_id = String(body.channel_id || "").trim();
  const playlists_pages = Math.min(Math.max(parseInt(body.playlists_pages || "10", 10), 1), 30);
  const videos_pages = Math.min(Math.max(parseInt(body.videos_pages || "2", 10), 0), 10);

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
  const channelMetaResult = await fetchChannelMeta(runtimeEnv, channel_id).catch((error) => ({
    ok: false,
    error: String(error?.message || error),
    meta: null,
  }));

  const meta = channelMetaResult.meta || {};
  const title = meta.title || null;
  const thumb = meta.thumbnail_url || null;
  const uploads = meta.uploads_playlist_id || null;
  const metaError = channelMetaResult.ok ? "" : (channelMetaResult.error || "failed to fetch channel metadata");

  await DB.prepare(`
    INSERT INTO channels(
      channel_id, title, thumbnail_url, is_active, created_at, updated_at,
      description, custom_url, published_at, country, default_language,
      localized_title, localized_description, banner_url,
      branding_title, branding_description, branding_keywords,
      branding_default_language, branding_country, unsubscribed_trailer,
      topic_categories_json, topic_ids_json, localizations_json,
      channel_meta_fetched_at, channel_meta_error,
      language_code, language_source, languages_json
    )
    VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      title = COALESCE(excluded.title, channels.title),
      thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
      is_active = 1,
      updated_at = excluded.updated_at,
      description = excluded.description,
      custom_url = excluded.custom_url,
      published_at = COALESCE(excluded.published_at, channels.published_at),
      country = excluded.country,
      default_language = excluded.default_language,
      localized_title = excluded.localized_title,
      localized_description = excluded.localized_description,
      banner_url = excluded.banner_url,
      branding_title = excluded.branding_title,
      branding_description = excluded.branding_description,
      branding_keywords = excluded.branding_keywords,
      branding_default_language = excluded.branding_default_language,
      branding_country = excluded.branding_country,
      unsubscribed_trailer = excluded.unsubscribed_trailer,
      topic_categories_json = excluded.topic_categories_json,
      topic_ids_json = excluded.topic_ids_json,
      localizations_json = excluded.localizations_json,
      channel_meta_fetched_at = excluded.channel_meta_fetched_at,
      channel_meta_error = excluded.channel_meta_error
      , language_code = excluded.language_code
      , language_source = excluded.language_source
      , languages_json = excluded.languages_json
  `).bind(
    channel_id,
    title,
    thumb,
    t,
    t,
    meta.description || "",
    meta.custom_url || "",
    meta.published_at ?? null,
    meta.country || "",
    meta.default_language || "",
    meta.localized_title || "",
    meta.localized_description || "",
    meta.banner_url || "",
    meta.branding_title || "",
    meta.branding_description || "",
    meta.branding_keywords || "",
    meta.branding_default_language || "",
    meta.branding_country || "",
    meta.unsubscribed_trailer || "",
    meta.topic_categories_json || "[]",
    meta.topic_ids_json || "[]",
    meta.localizations_json || "{}",
    t,
    metaError,
    meta.language_code || "",
    meta.language_source || "",
    meta.languages_json || "[]"
  ).run();

  const ch = await DB.prepare(`SELECT id FROM channels WHERE channel_id=?`).bind(channel_id).first();
  if (!ch) return new Response("failed to load channel row", { status: 500 });
  const channel_int = ch.id;

  if (meta.languages_json) {
    const langStmts = channelLanguageStmts(DB, channel_int, meta.languages || meta.languages_json, meta.language_source || "detected");
    if (langStmts.length) await DB.batch(langStmts);
  }

  await DB.prepare(`
    INSERT INTO channel_backfill(channel_int, uploads_playlist_id, next_page_token, done, imported_count, updated_at)
    VALUES(?, ?, NULL, 0, 0, ?)
    ON CONFLICT(channel_int) DO UPDATE SET
      uploads_playlist_id = COALESCE(excluded.uploads_playlist_id, channel_backfill.uploads_playlist_id),
      done = 0,
      updated_at = excluded.updated_at
  `).bind(channel_int, uploads, t).run();

  const warnings = [];

  let websub = { ok: false, skipped: true, reason: "not attempted" };
  try {
    websub = await subscribeWebSub({ env: runtimeEnv, DB, request, channel_id, channel_int });
    if (!websub?.ok && !websub?.skipped) warnings.push({ step: "websub", detail: websub });
  } catch (error) {
    websub = { ok: false, skipped: false, reason: String(error?.message || error) };
    warnings.push({ step: "websub", error: websub.reason });
  }

  let playlists = { ok: false, imported: 0, reason: "not attempted" };
  try {
    playlists = await importPlaylistsForChannel({
      env: runtimeEnv,
      DB,
      channel_int,
      channel_id,
      max_pages: playlists_pages
    });
    if (!playlists?.ok) warnings.push({ step: "playlists", detail: playlists });
  } catch (error) {
    playlists = { ok: false, imported: 0, reason: String(error?.message || error) };
    warnings.push({ step: "playlists", error: playlists.reason });
  }

  let videos = { ok: false, imported: 0, reason: "not attempted", next_page_token: null, done: uploads ? 0 : 1 };
  if (videos_pages > 0) {
    try {
      videos = await importRecentVideosForChannel({
        env: runtimeEnv,
        DB,
        channel_int,
        uploads_playlist_id: uploads,
        channel_language_code: meta.language_code || "",
        max_pages: videos_pages,
      });
      if (!videos?.ok) warnings.push({ step: "videos", detail: videos });
    } catch (error) {
      videos = { ok: false, imported: 0, reason: String(error?.message || error), next_page_token: null, done: uploads ? 0 : 1 };
      warnings.push({ step: "videos", error: videos.reason });
    }
  }

  if (videos?.ok) {
    await DB.prepare(`
      UPDATE channel_backfill
      SET next_page_token=?,
          done=?,
          imported_count=?,
          updated_at=?
      WHERE channel_int=?
    `).bind(
      videos.next_page_token || null,
      videos.done ? 1 : 0,
      videos.imported || 0,
      nowSec(),
      channel_int
    ).run();
  }

  return Response.json({
    ok: true,
    input: requested_channel_id || raw_input || channel_id,
    channel_id,
    resolved_via,
    channel_int,
    title,
    uploads_playlist_id: uploads,
    channel_meta: {
      ok: channelMetaResult.ok,
      error: metaError || null,
      description_len: (meta.description || "").length,
      custom_url: meta.custom_url || "",
      country: meta.country || "",
      default_language: meta.default_language || "",
      branding_default_language: meta.branding_default_language || "",
      branding_country: meta.branding_country || "",
      has_branding_keywords: Boolean(meta.branding_keywords),
      topic_categories_count: JSON.parse(meta.topic_categories_json || "[]").length,
      localizations_count: Object.keys(JSON.parse(meta.localizations_json || "{}")).length,
      language_code: meta.language_code || "",
      language_source: meta.language_source || "",
      languages: meta.languages || [],
    },
    websub,
    playlists,
    videos,
    warnings,
  });
}
