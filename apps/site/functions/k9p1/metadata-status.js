import { getDB } from "../_db.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store"
    }
  });
}

export async function onRequest({ env }) {
  try {
    env.DB = getDB(env);

    const totals = await env.DB.prepare(`
      SELECT
        COUNT(*) AS videos_total,
        SUM(CASE WHEN d.video_id IS NOT NULL THEN 1 ELSE 0 END) AS with_details,
        SUM(CASE WHEN d.video_id IS NULL THEN 1 ELSE 0 END) AS missing_details,
        SUM(CASE WHEN v.stats_fetched_at IS NOT NULL THEN 1 ELSE 0 END) AS with_stats
      FROM videos v
      LEFT JOIN video_details d ON d.video_id = v.video_id
    `).first();

    const tableCounts = await env.DB.prepare(`
      SELECT 'videos' AS table_name, COUNT(*) AS count FROM videos
      UNION ALL
      SELECT 'video_details', COUNT(*) FROM video_details
      UNION ALL
      SELECT 'video_tags', COUNT(*) FROM video_tags
      UNION ALL
      SELECT 'video_fts', COUNT(*) FROM video_fts
      UNION ALL
      SELECT 'video_details_fts', COUNT(*) FROM video_details_fts
    `).all();

    const latest = await env.DB.prepare(`
      SELECT
        v.id,
        v.video_id,
        v.title,
        v.published_at,
        v.stats_fetched_at,
        CASE WHEN d.video_id IS NULL THEN 0 ELSE 1 END AS has_details,
        LENGTH(COALESCE(d.description, '')) AS description_len,
        d.updated_at AS details_updated_at
      FROM videos v
      LEFT JOIN video_details d ON d.video_id = v.video_id
      ORDER BY v.id DESC
      LIMIT 20
    `).all();

    const latestDetails = await env.DB.prepare(`
      SELECT
        d.video_id,
        v.id,
        v.title,
        d.updated_at,
        v.stats_fetched_at,
        LENGTH(COALESCE(d.description, '')) AS description_len
      FROM video_details d
      LEFT JOIN videos v ON v.video_id = d.video_id
      ORDER BY COALESCE(d.updated_at, 0) DESC
      LIMIT 20
    `).all();

    return json({
      ok: true,
      totals: totals || {},
      table_counts: tableCounts.results || [],
      latest_videos: latest.results || [],
      latest_details: latestDetails.results || []
    });
  } catch (error) {
    return json({
      ok: false,
      route: "/k9p1/metadata-status",
      error: String(error?.message || error),
      stack: String(error?.stack || "").slice(0, 2000)
    }, 500);
  }
}
