import { getDB } from "../_db.js";
import { normalizePublicLang } from "../_shared/language.js";

function parseJson(value, fallback) {
  try { return JSON.parse(value || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function splitLanguages(value) {
  return String(value || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function channelRow(ch) {
  const { topic_categories_json, languages_json, indexed_languages, ...rest } = ch;
  const languagesFromIndex = splitLanguages(indexed_languages);
  return {
    ...rest,
    topic_categories: parseJson(topic_categories_json || "[]", []),
    languages: languagesFromIndex.length ? languagesFromIndex : parseJson(languages_json || "[]", []),
  };
}

export async function onRequest({ env, request }) {
  env.DB = getDB(env);
  const url = new URL(request.url);
  const lang = normalizePublicLang(url.searchParams.get("lang") || "he", "he");

  const rows = await env.DB.prepare(`
    SELECT
      c.id, c.channel_id, c.title, c.thumbnail_url, c.banner_url,
      c.country, c.default_language, c.branding_default_language, c.branding_keywords,
      c.language_code, c.language_source, c.languages_json,
      c.topic_categories_json, c.channel_meta_fetched_at,
      GROUP_CONCAT(all_cl.language_code) AS indexed_languages
    FROM channel_languages AS cl INDEXED BY idx_channel_languages_lookup
    JOIN channels AS c
      ON c.id = cl.channel_int
    LEFT JOIN channel_languages AS all_cl
      ON all_cl.channel_int = c.id
    WHERE c.is_active = 1
      AND c.show_in_public_channels = 1
      AND cl.language_code = ?
    GROUP BY c.id
    ORDER BY c.title COLLATE NOCASE ASC, c.id ASC
  `).bind(lang).all();

  const channels = (rows.results || []).map(channelRow);

  return Response.json(
    { channels, lang },
    { headers: { "cache-control": "public, max-age=120" } }
  );
}
