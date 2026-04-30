const SUPPORTED_LANGS = new Set(["he", "en", "fr", "yi", "ru"]);

export function normalizeLangCode(code) {
  const raw = String(code || "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return "";

  const base = raw.split("-")[0];
  const map = {
    iw: "he",
    he: "he",
    heb: "he",
    en: "en",
    eng: "en",
    fr: "fr",
    fra: "fr",
    fre: "fr",
    yi: "yi",
    yid: "yi",
    ji: "yi",
    ru: "ru",
    rus: "ru",
  };

  return map[base] || base;
}

export function isSupportedLang(code) {
  return SUPPORTED_LANGS.has(normalizeLangCode(code));
}

export function normalizePublicLang(code, fallback = "he") {
  const lang = normalizeLangCode(code || fallback);
  return SUPPORTED_LANGS.has(lang) ? lang : fallback;
}

export function parseJsonObject(value) {
  try {
    const obj = JSON.parse(value || "{}");
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

export function parseJsonArray(value) {
  try {
    const arr = JSON.parse(value || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function pushLang(out, code) {
  const lang = normalizeLangCode(code);
  if (SUPPORTED_LANGS.has(lang) && !out.includes(lang)) out.push(lang);
}

export function languagesFromLocalizations(localizations) {
  const obj = localizations && typeof localizations === "object" ? localizations : parseJsonObject(localizations);
  const out = [];

  for (const key of Object.keys(obj)) {
    pushLang(out, key);
  }

  return out;
}

export function guessLanguageFromText(...texts) {
  const text = texts.map(v => String(v || "")).join(" ").trim();
  if (!text) return "";

  // זיהוי שמרני בלבד: כדי לא לסווג בטעות אנגלית/צרפתית מטקסט לטיני מעורב.
  const hebrew = (text.match(/[\u0590-\u05FF]/g) || []).length;
  const cyrillic = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;

  if (cyrillic >= 3 && cyrillic >= hebrew && cyrillic >= latin) return "ru";
  if (hebrew >= 3 && hebrew >= cyrillic) return "he";

  return "";
}

export function buildChannelLanguage({ snippet = {}, brandingChannel = {}, localizations = {} } = {}) {
  const languages = [];
  let language_code = "";
  let language_source = "";

  const candidates = [
    [snippet.defaultLanguage, "snippet.defaultLanguage"],
    [brandingChannel.defaultLanguage, "brandingSettings.channel.defaultLanguage"],
  ];

  for (const [code, source] of candidates) {
    const lang = normalizeLangCode(code);
    if (SUPPORTED_LANGS.has(lang)) {
      language_code = lang;
      language_source = source;
      pushLang(languages, lang);
      break;
    }
  }

  for (const lang of languagesFromLocalizations(localizations)) {
    pushLang(languages, lang);
  }

  if (!language_code && languages.length) {
    language_code = languages[0];
    language_source = "localizations";
  }

  if (!language_code) {
    const guessed = guessLanguageFromText(
      snippet.title,
      snippet.description,
      snippet.localized?.title,
      snippet.localized?.description,
      brandingChannel.title,
      brandingChannel.description,
      brandingChannel.keywords,
    );

    if (guessed) {
      language_code = guessed;
      language_source = "text_heuristic";
      pushLang(languages, guessed);
    }
  }

  return {
    language_code,
    language_source,
    languages,
    languages_json: JSON.stringify(languages),
  };
}

export function inferVideoLanguage(meta = {}, fallbackChannelLang = "") {
  const candidates = [
    [meta.default_audio_language, "default_audio_language"],
    [meta.default_language, "default_language"],
    [fallbackChannelLang, "channel_language"],
  ];

  for (const [code, source] of candidates) {
    const lang = normalizeLangCode(code);
    if (SUPPORTED_LANGS.has(lang)) {
      return { language_code: lang, language_source: source };
    }
  }

  const guessed = guessLanguageFromText(meta.title, meta.description);
  if (guessed) {
    return { language_code: guessed, language_source: "text_heuristic" };
  }

  return { language_code: "unknown", language_source: "unknown" };
}

export function channelLanguageStmts(DB, channel_int, languages, source = "") {
  const list = Array.isArray(languages) ? languages : parseJsonArray(languages);
  const unique = [];

  for (const code of list) {
    const lang = normalizeLangCode(code);
    if (SUPPORTED_LANGS.has(lang) && !unique.includes(lang)) unique.push(lang);
  }

  const stmts = [
    DB.prepare(`DELETE FROM channel_languages WHERE channel_int = ?`).bind(channel_int)
  ];

  for (const lang of unique) {
    stmts.push(DB.prepare(`
      INSERT OR IGNORE INTO channel_languages(channel_int, language_code, source)
      VALUES(?, ?, ?)
    `).bind(channel_int, lang, source || "detected"));
  }

  return stmts;
}

export function channelVideoLanguageStmts(DB, channel_int, language_code, source = "video") {
  const lang = normalizeLangCode(language_code);
  if (!channel_int || !SUPPORTED_LANGS.has(lang)) return [];

  const sourceText = source ? `video:${source}` : "video";
  const oneLangJson = JSON.stringify([lang]);
  const langJsonValue = JSON.stringify(lang);
  const langLike = `%"${lang}"%`;

  return [
    DB.prepare(`
      INSERT OR IGNORE INTO channel_languages(channel_int, language_code, source)
      VALUES(?, ?, ?)
    `).bind(channel_int, lang, sourceText),
    DB.prepare(`
      UPDATE channels
      SET
        language_code = CASE
          WHEN COALESCE(language_code, '') = '' THEN ?
          ELSE language_code
        END,
        language_source = CASE
          WHEN COALESCE(language_source, '') = '' THEN ?
          ELSE language_source
        END,
        languages_json = CASE
          WHEN COALESCE(languages_json, '') = '' OR languages_json = '[]' THEN ?
          WHEN languages_json LIKE ? THEN languages_json
          ELSE substr(languages_json, 1, length(languages_json) - 1) || ',' || ? || ']'
        END
      WHERE id = ?
    `).bind(lang, sourceText, oneLangJson, langLike, langJsonValue, channel_int)
  ];
}
