import { getDB } from "../_db.js";

export async function onRequest({ env }) {
  try {
    const DB = getDB(env);
    await DB.prepare("SELECT 1").first();
    return Response.json({ ok: true, db: true });
  } catch (e) {
    return Response.json({ ok: false, db: false, error: String(e) }, { status: 500 });
  }
}
