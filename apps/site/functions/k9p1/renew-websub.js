import { getDB } from "../_db.js";
// functions/admin/renew-websub.js

function unauthorized() { return new Response("unauthorized", { status: 401 }); }
function nowSec() { return Math.floor(Date.now() / 1000); }

async function subscribeTopic({ env, request, topic_url, channel_int }) {
  const t = nowSec();
  const origin = (env.PUBLIC_ORIGIN || new URL(request.url).origin).replace(/\/$/, "");
  const callback = `${origin}/websub/youtube`;
  const hub = "https://pubsubhubbub.appspot.com/subscribe";

  if (!env.WEBSUB_VERIFY_TOKEN) {
    return { ok: false, topic_url, status: null, last_error: "missing WEBSUB_VERIFY_TOKEN" };
  }

  const params = new URLSearchParams();
  params.set("hub.mode", "subscribe");
  params.set("hub.callback", callback);
  params.set("hub.topic", topic_url);
  params.set("hub.verify", "async");
  params.set("hub.verify_token", env.WEBSUB_VERIFY_TOKEN);

  if (env.WEBSUB_SECRET) params.set("hub.secret", env.WEBSUB_SECRET);

  const res = await fetch(hub, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const last_error = res.ok ? null : `hub subscribe failed: ${res.status}`;

  await env.DB.prepare(`
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
  `).bind(topic_url, channel_int, t, last_error).run();

  return { ok: res.ok, topic_url, status: res.status, last_error };
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  if (request.method !== "POST") return new Response("use POST", { status: 200 });


  const body = await request.json().catch(() => ({}));
  const force = !!body.force;

  // ברירת מחדל: נחדש אם נשאר פחות מ-2 ימים
  const min_remaining_days = Math.min(Math.max(parseInt(body.min_remaining_days || "2", 10), 0), 30);
  const min_remaining = min_remaining_days * 24 * 3600;

  const limit = Math.min(Math.max(parseInt(body.limit || "200", 10), 1), 2000);
  const t = nowSec();

  const subs = await env.DB.prepare(`
    SELECT topic_url, channel_int, status, lease_expires_at
    FROM subscriptions
    ORDER BY COALESCE(lease_expires_at, 0) ASC
    LIMIT ?
  `).bind(limit).all();

  const rows = subs?.results || [];
  const due = [];
  for (const r of rows) {
    const exp = Number.isFinite(r.lease_expires_at) ? r.lease_expires_at : 0;
    const isDue = !exp || exp <= (t + min_remaining) || r.status !== "active";
    if (force || isDue) due.push(r);
  }

  const results = [];
  let ok = 0;
  let fail = 0;

  for (const r of due) {
    const out = await subscribeTopic({
      env,
      request,
      topic_url: r.topic_url,
      channel_int: r.channel_int
    });

    results.push(out);
    if (out.ok) ok++;
    else fail++;
  }

  return Response.json({
    ok: true,
    now: t,
    checked: rows.length,
    renewed: due.length,
    ok_count: ok,
    fail_count: fail,
    results
  });
}
