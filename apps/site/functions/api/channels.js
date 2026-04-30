import { getDB } from "../_db.js";
export async function onRequest({ env }) {
  env.DB = getDB(env);
  const rows = await env.DB.prepare(`
    SELECT
      id, channel_id, title, thumbnail_url,
      country, default_language, branding_default_language,
      topic_categories_json, channel_meta_fetched_at
    FROM channels
    WHERE is_active = 1
    ORDER BY id ASC
  `).all();

  const channels = (rows.results || []).map((ch) => {
    const { topic_categories_json, ...rest } = ch;
    return {
      ...rest,
      topic_categories: JSON.parse(topic_categories_json || "[]"),
    };
  });

  return Response.json({ channels });
}
