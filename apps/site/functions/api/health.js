import { getDB } from "../_db.js";
export async function onRequest({ env }) {
  env.DB = getDB(env);
  try {
    await env.DB.prepare("SELECT 1").first();
    return Response.json({ ok: true, db: true });
  } catch (e) {
    return Response.json({ ok: false, db: false, error: String(e) }, { status: 500 });
  }
}
