import { getDB } from "../_db.js";

export async function onRequest({ env }) {
  const DB = getDB(env);
  const rows = await DB.prepare(`
    SELECT id, channel_id, title, thumbnail_url
    FROM channels
    WHERE is_active = 1
    ORDER BY id ASC
  `).all();

  return Response.json({ channels: rows.results });
}
