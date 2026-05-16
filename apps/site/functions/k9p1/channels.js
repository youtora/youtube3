import { getDB } from "../_db.js";
import { netfreeDefaultStatusForPolicy, normalizeFilterPolicy, showInPublicChannelsForPolicy } from "../_shared/filter-policy.js";
// functions/admin/channels.js

function unauthorized() { return new Response("unauthorized", { status: 401 }); }
function nowSec() { return Math.floor(Date.now() / 1000); }
function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

export async function onRequest({ env, request }) {

  env.DB = getDB(env);
  if (request.method === "GET") {
    // קריאה אחת: רשימת ערוצים + מצב WebSub אם קיים
    const rows = await env.DB.prepare(`
      SELECT c.id,
             c.channel_id,
             c.title,
             c.thumbnail_url,
             c.banner_url,
             c.is_active,
             c.updated_at,
             c.country,
             c.default_language,
             c.branding_default_language,
             c.branding_country,
             c.branding_keywords,
             c.language_code,
             c.language_source,
             c.languages_json,
             c.netfree_default_status,
             c.show_in_public_channels,
             c.filter_policy,
             c.channel_meta_fetched_at,
             c.channel_meta_error,
             s.status AS websub_status,
             s.lease_expires_at,
             s.last_error
      FROM channels c
      LEFT JOIN subscriptions s ON s.channel_int = c.id
      ORDER BY c.id DESC
    `).all();

    return Response.json({ channels: rows.results || [] }, { headers: { "cache-control": "no-store" } });
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const action = (body.action || "").trim();
    const channel_id = (body.channel_id || "").trim();
    if (!channel_id) return new Response("missing channel_id", { status: 400 });

    if (!["purge", "set_netfree_status", "set_filter_policy"].includes(action)) {
      return new Response("unsupported action", { status: 400 });
    }

    const ch = await env.DB.prepare(`
      SELECT id, filter_policy, netfree_default_status
      FROM channels
      WHERE channel_id = ?
      LIMIT 1
    `).bind(channel_id).first();

    if (!ch?.id) return new Response("not found", { status: 404 });
    const channel_int = ch.id;

    if (action === "set_netfree_status" || action === "set_filter_policy") {
      const requestedPolicy = action === "set_filter_policy"
        ? body.filter_policy
        : (Number(body.netfree_default_status ?? body.status) === 1 ? 1 : 3);

      const filter_policy = normalizeFilterPolicy(requestedPolicy, 3);
      const previousPolicy = normalizeFilterPolicy(ch.filter_policy ?? (Number(ch.netfree_default_status) === 1 ? 1 : 3), 3);
      const previousWasOpenAll = previousPolicy === 1 || Number(ch.netfree_default_status) === 1;
      const netfree_default_status = netfreeDefaultStatusForPolicy(filter_policy);
      const show_in_public_channels = showInPublicChannelsForPolicy(filter_policy);
      const t = nowSec();

      const chUpdate = await env.DB.prepare(`
        UPDATE channels
        SET
          filter_policy = ?,
          netfree_default_status = ?,
          show_in_public_channels = ?,
          updated_at = ?
        WHERE id = ?
      `).bind(filter_policy, netfree_default_status, show_in_public_channels, t, channel_int).run();

      let videoUpdate;

      if (filter_policy === 1) {
        videoUpdate = await env.DB.prepare(`
          UPDATE videos
          SET
            netfree_status = CASE WHEN netfree_status = 4 THEN 4 ELSE 1 END,
            etrog_visible = CASE WHEN netfree_status = 4 THEN 0 ELSE 1 END,
            netfree_recheck_after = NULL,
            updated_at = ?
          WHERE channel_int = ?
        `).bind(t, channel_int).run();
      } else if (previousWasOpenAll) {
        videoUpdate = await env.DB.prepare(`
          UPDATE videos
          SET
            netfree_status = CASE WHEN netfree_status = 4 THEN 4 ELSE 0 END,
            etrog_visible = CASE
              WHEN netfree_status = 4 THEN 0
              WHEN ? = 2 THEN 1
              WHEN ? = 3 THEN 1
              WHEN ? = 4 THEN 0
              ELSE 0
            END,
            netfree_recheck_after = NULL,
            netfree_discovered_at = COALESCE(published_at, netfree_discovered_at, updated_at, ?),
            updated_at = ?
          WHERE channel_int = ?
        `).bind(filter_policy, filter_policy, filter_policy, t, t, channel_int).run();
      } else {
        videoUpdate = await env.DB.prepare(`
          UPDATE videos
          SET
            etrog_visible = CASE
              WHEN netfree_status = 4 THEN 0
              WHEN ? = 2 THEN 1
              WHEN ? = 3 AND netfree_status <> 2 THEN 1
              WHEN ? = 4 AND netfree_status = 1 THEN 1
              ELSE 0
            END,
            updated_at = ?
          WHERE channel_int = ?
        `).bind(filter_policy, filter_policy, filter_policy, t, channel_int).run();
      }

      return json({
        ok: true,
        action: "set_filter_policy",
        channel_id,
        filter_policy,
        previous_filter_policy: previousPolicy,
        netfree_default_status,
        show_in_public_channels,
        changed: {
          channels: chUpdate?.meta?.changes || 0,
          videos: videoUpdate?.meta?.changes || 0
        }
      });
    }

    // ⚠️ מחיקה מלאה: ילדים -> הורה (כדי לא להיתקע עם FK)
    // video_fts: אם הוא מוגדר עם טריגרים על videos, ייתכן שלא צריך למחוק ידנית.
    // כאן נעשה "best effort": אם אין table/אי אפשר למחוק - ממשיכים.
    let delFts = 0;
    try {
      const r = await env.DB.prepare(`
        DELETE FROM video_fts
        WHERE rowid IN (SELECT id FROM videos WHERE channel_int = ?)
      `).bind(channel_int).run();
      delFts = r?.meta?.changes || 0;
    } catch (_) {}

    let delVideoDetailsFts = 0;
    let delVideoDetailsFtsError = "";
    try {
      const r = await env.DB.prepare(`
        DELETE FROM video_details_fts
        WHERE video_id IN (
          SELECT video_id
          FROM videos
          WHERE channel_int = ?
        )
      `).bind(channel_int).run();
      delVideoDetailsFts = r?.meta?.changes || 0;
    } catch (e) {
      delVideoDetailsFtsError = String(e?.message || e || "");
    }

    let delVideoTags = 0;
    try {
      const r = await env.DB.prepare(`
        DELETE FROM video_tags
        WHERE video_id IN (
          SELECT video_id
          FROM videos
          WHERE channel_int = ?
        )
      `).bind(channel_int).run();
      delVideoTags = r?.meta?.changes || 0;
    } catch (_) {}

    let delVideoDetails = 0;
    try {
      const r = await env.DB.prepare(`
        DELETE FROM video_details
        WHERE video_id IN (
          SELECT video_id
          FROM videos
          WHERE channel_int = ?
        )
      `).bind(channel_int).run();
      delVideoDetails = r?.meta?.changes || 0;
    } catch (_) {}

    const delVideos = await env.DB.prepare(`
      DELETE FROM videos
      WHERE channel_int = ?
    `).bind(channel_int).run();

    const delPlaylists = await env.DB.prepare(`
      DELETE FROM playlists
      WHERE channel_int = ?
    `).bind(channel_int).run();

    const delSubs = await env.DB.prepare(`
      DELETE FROM subscriptions
      WHERE channel_int = ?
    `).bind(channel_int).run();

    const delBackfill = await env.DB.prepare(`
      DELETE FROM channel_backfill
      WHERE channel_int = ?
    `).bind(channel_int).run();

    try { await env.DB.prepare(`
      DELETE FROM channel_languages
      WHERE channel_int = ?
    `).bind(channel_int).run(); } catch (_) {}

    const delChannel = await env.DB.prepare(`
      DELETE FROM channels
      WHERE id = ?
    `).bind(channel_int).run();

    // ניקוי שאריות FTS יתומות.
    // זה חשוב בעיקר אם בעבר נמחקו videos/video_details אבל נשארו שורות ב־video_details_fts.
    // מחיקה לפי ערוץ לא תופסת שורות כאלה, כי כבר אין להן שורת videos שממנה אפשר לדעת את channel_int.
    let delOrphanVideoDetailsFts = 0;
    let delOrphanVideoDetailsFtsError = "";
    try {
      const r = await env.DB.prepare(`
        DELETE FROM video_details_fts
        WHERE rowid IN (
          SELECT f.rowid
          FROM video_details_fts f
          LEFT JOIN videos v ON v.video_id = f.video_id
          WHERE v.video_id IS NULL
        )
      `).run();
      delOrphanVideoDetailsFts = r?.meta?.changes || 0;
    } catch (e) {
      delOrphanVideoDetailsFtsError = String(e?.message || e || "");
    }

    return Response.json({
      ok: true,
      action: "purge",
      channel_id,
      deleted: {
        video_fts: delFts,
        video_details_fts: delVideoDetailsFts,
        orphan_video_details_fts: delOrphanVideoDetailsFts,
        video_tags: delVideoTags,
        video_details: delVideoDetails,
        videos: delVideos?.meta?.changes || 0,
        playlists: delPlaylists?.meta?.changes || 0,
        subscriptions: delSubs?.meta?.changes || 0,
        channel_backfill: delBackfill?.meta?.changes || 0,
        channels: delChannel?.meta?.changes || 0
      },
      errors: {
        video_details_fts: delVideoDetailsFtsError,
        orphan_video_details_fts: delOrphanVideoDetailsFtsError
      }
    }, { headers: { "cache-control": "no-store" } });
  }

  return new Response("use GET or POST", { status: 200 });
}
