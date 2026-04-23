import { getDB } from "../_db.js";

export async function onRequest({ env, request }) {
  env.DB = env.DB || getDB(env);
  // מגיש את הדף כ-asset לפי ה-URL הנוכחי (/k9p1) בלי לעבור דרך /k9p1.html
  return env.ASSETS.fetch(request);
}
