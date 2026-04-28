export async function onRequest({ env, request }) {
  // מגיש את הדף כ-asset לפי ה-URL הנוכחי (/k9p1) בלי לעבור דרך /k9p1.html
  return env.ASSETS.fetch(request);
}
