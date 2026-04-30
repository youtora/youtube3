import { getDB } from "../_db.js";
import { fetchVideoMeta, videoDetailsStmts, nowSec, inferVideoLanguage } from "../_shared/video-meta.js";

function clamp(n, a, b){
  return Math.max(a, Math.min(b, n));
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  if (request.method !== "POST") return new Response("use POST", { status: 200 });
  if (!env.YT_API_KEY) return Response.json({ ok:false, error:"missing YT_API_KEY" }, { status: 500 });

  const body = await request.json().catch(() => ({}));
  const limit = clamp(parseInt(body.limit || "250", 10), 1, 1000);
  const maxAgeHours = clamp(parseInt(body.max_age_hours || "72", 10), 1, 24 * 30);
  const includeFresh = body.include_fresh === true;
  const staleBefore = nowSec() - (maxAgeHours * 3600);

  const rows = includeFresh
    ? await env.DB.prepare(`
        SELECT video_id, language_code
        FROM videos
        ORDER BY COALESCE(stats_fetched_at, 0) ASC, id ASC
        LIMIT ?
      `).bind(limit).all()
    : await env.DB.prepare(`
        SELECT v.video_id, v.language_code
        FROM videos v
        LEFT JOIN video_details d ON d.video_id = v.video_id
        WHERE d.video_id IS NULL
           OR v.stats_fetched_at IS NULL
           OR v.stats_fetched_at < ?
        ORDER BY COALESCE(v.stats_fetched_at, 0) ASC, v.id ASC
        LIMIT ?
      `).bind(staleBefore, limit).all();

  const sourceRows = rows.results || [];
  const currentLangById = new Map(sourceRows.map(r => [r.video_id, r.language_code || ""]));
  const ids = sourceRows.map(r => r.video_id).filter(Boolean);
  if (!ids.length) {
    return Response.json({ ok:true, checked:0, updated:0, api_calls:0 }, { headers:{ "cache-control":"no-store" } });
  }

  const metaMap = await fetchVideoMeta(env, ids);
  const ts = nowSec();
  const stmts = [];

  for (const id of ids) {
    const meta = metaMap.get(id);
    if (!meta) continue;

    const lang = inferVideoLanguage(meta, currentLangById.get(id) || "");

    stmts.push(env.DB.prepare(`
      UPDATE videos
      SET
        title            = COALESCE(NULLIF(?, ''), title),
        video_kind       = CASE WHEN ? IS NOT NULL THEN ? ELSE video_kind END,
        duration_sec     = CASE WHEN ? IS NOT NULL THEN ? ELSE duration_sec END,
        view_count       = CASE WHEN ? IS NOT NULL THEN ? ELSE view_count END,
        like_count       = CASE WHEN ? IS NOT NULL THEN ? ELSE like_count END,
        comment_count    = CASE WHEN ? IS NOT NULL THEN ? ELSE comment_count END,
        stats_fetched_at = ?,
        language_code    = CASE WHEN ? IS NOT NULL AND ? <> '' THEN ? ELSE language_code END,
        language_source  = CASE WHEN ? IS NOT NULL AND ? <> '' THEN ? ELSE language_source END,
        updated_at       = ?
      WHERE video_id = ?
    `).bind(
      meta.title || "",
      meta.video_kind ?? null, meta.video_kind ?? null,
      meta.duration_sec ?? null, meta.duration_sec ?? null,
      meta.view_count ?? null, meta.view_count ?? null,
      meta.like_count ?? null, meta.like_count ?? null,
      meta.comment_count ?? null, meta.comment_count ?? null,
      ts,
      lang.language_code, lang.language_code, lang.language_code,
      lang.language_source, lang.language_source, lang.language_source,
      ts,
      id
    ));

    stmts.push(...videoDetailsStmts(env, id, meta, ts));
  }

  if (stmts.length) await env.DB.batch(stmts);

  return Response.json({
    ok: true,
    checked: ids.length,
    updated: metaMap.size,
    api_calls: Math.ceil(ids.length / 50),
    max_age_hours: maxAgeHours
  }, { headers:{ "cache-control":"no-store" } });
}
