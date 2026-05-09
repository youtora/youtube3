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

function errorText(error) {
  return String(error?.message || error || "");
}

function isOptionalLanguageStoreError(error) {
  const msg = errorText(error).toLowerCase();
  return msg.includes("channel_languages") && (
    msg.includes("no such table") ||
    msg.includes("no such index") ||
    msg.includes("not found") ||
    msg.includes("does not exist")
  );
}

function publicChannelWhereSql() {
  return `
    c.is_active = 1
    AND (
      COALESCE(c.show_in_public_channels, 1) = 1
      OR EXISTS (
        SELECT 1
        FROM videos v
        WHERE v.channel_int = c.id
          AND v.netfree_status = 1
        LIMIT 1
      )
    )
  `;
}

async function loadChannelsWithLanguageIndex(DB, lang, langLike) {
  return DB.prepare(`
    SELECT
      c.id, c.channel_id, c.title, c.thumbnail_url, c.banner_url,
      c.country, c.default_language, c.branding_default_language, c.branding_keywords,
      c.language_code, c.language_source, c.languages_json,
      c.topic_categories_json, c.channel_meta_fetched_at,
      GROUP_CONCAT(DISTINCT all_cl.language_code) AS indexed_languages
    FROM channels AS c
    LEFT JOIN channel_languages AS all_cl
      ON all_cl.channel_int = c.id
    WHERE ${publicChannelWhereSql()}
      AND (
        EXISTS (
          SELECT 1
          FROM channel_languages AS cl
          WHERE cl.channel_int = c.id
            AND cl.language_code = ?
          LIMIT 1
        )
        OR c.language_code = ?
        OR c.languages_json LIKE ?
        OR EXISTS (
          SELECT 1
          FROM videos v_lang
          WHERE v_lang.channel_int = c.id
            AND v_lang.netfree_status = 1
            AND v_lang.language_code = ?
          LIMIT 1
        )
        OR (
          ? = 'he'
          AND COALESCE(c.language_code, '') IN ('', 'unknown')
          AND NOT EXISTS (
            SELECT 1
            FROM channel_languages AS any_cl
            WHERE any_cl.channel_int = c.id
            LIMIT 1
          )
        )
      )
    GROUP BY c.id
    ORDER BY c.title COLLATE NOCASE ASC, c.id ASC
  `).bind(lang, lang, langLike, lang, lang).all();
}

async function loadChannelsWithoutLanguageIndex(DB, lang, langLike) {
  return DB.prepare(`
    SELECT
      c.id, c.channel_id, c.title, c.thumbnail_url, c.banner_url,
      c.country, c.default_language, c.branding_default_language, c.branding_keywords,
      c.language_code, c.language_source, c.languages_json,
      c.topic_categories_json, c.channel_meta_fetched_at,
      '' AS indexed_languages
    FROM channels AS c
    WHERE ${publicChannelWhereSql()}
      AND (
        c.language_code = ?
        OR c.languages_json LIKE ?
        OR EXISTS (
          SELECT 1
          FROM videos v_lang
          WHERE v_lang.channel_int = c.id
            AND v_lang.netfree_status = 1
            AND v_lang.language_code = ?
          LIMIT 1
        )
        OR (
          ? = 'he'
          AND COALESCE(c.language_code, '') IN ('', 'unknown')
        )
      )
    ORDER BY c.title COLLATE NOCASE ASC, c.id ASC
  `).bind(lang, langLike, lang, lang).all();
}

async function loadChannelsBaseFallback(DB) {
  return DB.prepare(`
    SELECT
      id, channel_id, title, thumbnail_url,
      '' AS banner_url,
      '' AS country,
      '' AS default_language,
      '' AS branding_default_language,
      '' AS branding_keywords,
      '' AS language_code,
      '' AS language_source,
      '[]' AS languages_json,
      '[]' AS topic_categories_json,
      NULL AS channel_meta_fetched_at,
      '' AS indexed_languages
    FROM channels
    WHERE is_active = 1
    ORDER BY id ASC
  `).all();
}

export async function onRequest({ env, request }) {
  const DB = getDB(env);
  env.DB = DB;
  const url = new URL(request.url);
  const lang = normalizePublicLang(url.searchParams.get("lang") || "he", "he");
  const langLike = `%"${lang}"%`;

  let rows;
  let fallback = "";

  try {
    rows = await loadChannelsWithLanguageIndex(DB, lang, langLike);
  } catch (error) {
    if (!isOptionalLanguageStoreError(error)) throw error;
    fallback = "without_channel_languages";

    try {
      rows = await loadChannelsWithoutLanguageIndex(DB, lang, langLike);
    } catch (_) {
      fallback = "base_channels_only";
      rows = await loadChannelsBaseFallback(DB);
    }
  }

  const channels = (rows.results || []).map(channelRow);

  return Response.json(
    { channels, lang, fallback: fallback || undefined },
    { headers: { "cache-control": "public, max-age=30" } }
  );
}
