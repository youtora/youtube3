import { getDB } from "./_db.js";
import { parseJsonArray } from "./_shared/video-meta.js";

export async function onRequest(context) {
  const { request, env } = context;
  env.DB = getDB(env);
  const currentUrl = new URL(request.url);
  const normalizedPath = normalizePath(currentUrl.pathname);

  if (request.method !== "GET") return env.ASSETS.fetch(request);

  if (normalizedPath !== currentUrl.pathname && !currentUrl.pathname.includes(".")) {
    const target = new URL(currentUrl.toString());
    target.pathname = normalizedPath;
    return Response.redirect(target.toString(), 301);
  }

  const oldHashtagMatch = normalizedPath.match(/^\/tag\/([^/]+)$/);
  if (oldHashtagMatch && currentUrl.searchParams.get("type") === "hashtag") {
    const target = new URL(currentUrl.toString());
    target.pathname = `/hashtag/${oldHashtagMatch[1]}`;
    target.searchParams.delete("type");
    return Response.redirect(target.toString(), 301);
  }

  if (normalizedPath === "/robots.txt") return serveRobots(currentUrl);

  if (normalizedPath === "/sitemap.xml") {
    return getCachedXml(request, 3600, () => serveSitemapIndex(env, currentUrl));
  }

  if (normalizedPath === "/sitemap-static.xml") {
    return getCachedXml(request, 3600, () => serveStaticSitemap(currentUrl));
  }

  if (normalizedPath === "/sitemap-videos.xml") {
    return getCachedXml(request, 3600, () => serveVideosSitemapIndex(env, currentUrl));
  }

  const videoSitemapMatch = normalizedPath.match(/^\/sitemap-videos-(\d+)\.xml$/);
  if (videoSitemapMatch) {
    return getCachedXml(request, 3600, () =>
      serveVideosSitemapPage(env, currentUrl, Number(videoSitemapMatch[1]))
    );
  }

  if (normalizedPath === "/sitemap-channels.xml") {
    return getCachedXml(request, 3600, () => serveChannelsSitemap(env, currentUrl));
  }

  if (normalizedPath === "/sitemap-playlists.xml") {
    return getCachedXml(request, 3600, () => servePlaylistsSitemap(env, currentUrl));
  }
  if (normalizedPath.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (normalizedPath.includes(".")) return env.ASSETS.fetch(request);

  const url = new URL(currentUrl.toString());
  url.pathname = normalizedPath;

  let route = null;
  try {
    route = await resolveRoute({ url, env });
  } catch (err) {
    console.error("resolveRoute failed", normalizedPath, err);
  }

  if (!route?.found) {
    if (!isLikelySpaRoute(normalizedPath)) {
      return serveNotFound(env, request, url);
    }

    route = {
      found: true,
      meta: buildFallbackMeta({ url, path: normalizedPath }),
    };
  }

  let indexRes;
  let rewritten;
  try {
    indexRes = await env.ASSETS.fetch(new Request(new URL("/", url), request));
    rewritten = rewriteIndex(indexRes, route.meta);
  } catch (err) {
    console.error("rewriteIndex failed", normalizedPath, err);
    return env.ASSETS.fetch(new Request(new URL("/", url), request));
  }
  const out = new Response(rewritten.body, {
    status: 200,
    statusText: rewritten.statusText,
    headers: rewritten.headers,
  });

  out.headers.set("Content-Type", "text/html; charset=UTF-8");
  out.headers.set("Cache-Control", route.meta.robots?.includes("noindex") ? "public, max-age=60" : "public, max-age=300");
  if (route.meta.robots) out.headers.set("X-Robots-Tag", route.meta.robots);
  return out;
}

function rewriteIndex(response, meta) {
  const image = normalizeUrl(meta.image || "/default-og.png", meta.origin || meta.canonical || "");
  const description = meta.description || "Youtora - ספריית וידאו ופלייליסטים מתעדכנת.";
  const title = meta.title || "Youtora";
  const canonical = meta.canonical || meta.url || meta.origin || "/";
  const robots = meta.robots || "index,follow,max-image-preview:large";
  const ogType = meta.type || "website";
  const jsonLd = meta.jsonLd ? `<script id="structured-data" type="application/ld+json">${escJson(meta.jsonLd)}</script>` : `<script id="structured-data" type="application/ld+json"></script>`;
  let titleWritten = false;

  return new HTMLRewriter()
    .on("title", {
      text(text) {
        if (!titleWritten) {
          text.replace(title);
          titleWritten = true;
        } else {
          text.remove();
        }
      },
    })
    .on('meta[name="description"]', setAttr("content", description))
    .on('meta[name="robots"]', setAttr("content", robots))
    .on('link[rel="canonical"]', setAttr("href", canonical))
    .on('meta[property="og:type"]', setAttr("content", ogType))
    .on('meta[property="og:site_name"]', setAttr("content", "Youtora"))
    .on('meta[property="og:title"]', setAttr("content", title))
    .on('meta[property="og:description"]', setAttr("content", description))
    .on('meta[property="og:image"]', setAttr("content", image))
    .on('meta[property="og:url"]', setAttr("content", canonical))
    .on('meta[name="twitter:card"]', setAttr("content", "summary_large_image"))
    .on('meta[name="twitter:title"]', setAttr("content", title))
    .on('meta[name="twitter:description"]', setAttr("content", description))
    .on('meta[name="twitter:image"]', setAttr("content", image))
    .on('script#structured-data', {
      element(el) {
        el.replace(jsonLd, { html: true });
      },
    })
    .on("div#page", {
      element(el) {
        if (meta.pageHtml) {
          el.setInnerContent(meta.pageHtml, { html: true });
        }
      },
    })
    .transform(response);
}

function setAttr(name, value) {
  return {
    element(el) {
      el.setAttribute(name, value || "");
    },
  };
}
const VIDEO_SITEMAP_PAGE_SIZE = 5000;

async function getCachedXml(request, ttlSeconds, producer) {
  try {
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const response = await producer();
    const out = new Response(response.body, response);
    out.headers.set("Cache-Control", `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`);

    try {
      await cache.put(cacheKey, out.clone());
    } catch (err) {
      console.error("cache.put failed", request.url, err);
    }

    return out;
  } catch (err) {
    console.error("getCachedXml failed", request.url, err);
    return producer();
  }
}

function xmlTextResponse(body, maxAge = 900) {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=UTF-8",
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  });
}

async function serveRobots(url) {
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${url.origin}/sitemap.xml`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

async function serveSitemapIndex(env, url) {
  const now = new Date().toISOString();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${xml(url.origin + "/sitemap-static.xml")}</loc><lastmod>${xml(now)}</lastmod></sitemap>
  <sitemap><loc>${xml(url.origin + "/sitemap-videos.xml")}</loc><lastmod>${xml(now)}</lastmod></sitemap>
  <sitemap><loc>${xml(url.origin + "/sitemap-channels.xml")}</loc><lastmod>${xml(now)}</lastmod></sitemap>
  <sitemap><loc>${xml(url.origin + "/sitemap-playlists.xml")}</loc><lastmod>${xml(now)}</lastmod></sitemap>
</sitemapindex>`;
  return xmlResponse(body, 900);
}

async function serveStaticSitemap(url) {
  const entries = [
    { loc: `${url.origin}/` },
    { loc: `${url.origin}/shorts` },
    { loc: `${url.origin}/live` },
    { loc: `${url.origin}/channels` },
    { loc: `${url.origin}/playlists` },
  ];
  return xmlResponse(buildUrlSet(entries), 900);
}

async function serveVideosSitemapIndex(env, url) {
  const countRow = await firstRow(env.DB, `
    SELECT COUNT(*) AS total
    FROM videos
    WHERE netfree_status = 1
  `, []);

  const total = Number(countRow?.total || 0);
  const pages = Math.max(1, Math.ceil(total / VIDEO_SITEMAP_PAGE_SIZE));

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${Array.from({ length: pages }, (_, i) => {
  const page = i + 1;
  return `  <sitemap><loc>${xml(url.origin + `/sitemap-videos-${page}.xml`)}</loc></sitemap>`;
}).join("\n")}
</sitemapindex>`;

  return xmlResponse(body, 900);
}

async function serveVideosSitemapPage(env, url, pageNumber) {
  const page = Math.max(1, Number(pageNumber || 1));
  const offset = (page - 1) * VIDEO_SITEMAP_PAGE_SIZE;

  const rows = await safeAll(env.DB, `
    SELECT video_id, published_at
    FROM videos
    WHERE netfree_status = 1
    ORDER BY published_at DESC
    LIMIT ? OFFSET ?
  `, [VIDEO_SITEMAP_PAGE_SIZE, offset]);

  if (!rows.length && page > 1) {
    return new Response("Not found", { status: 404 });
  }

  const entries = rows
    .filter((row) => row?.video_id)
    .map((row) => ({
      loc: `${url.origin}/${encodeURIComponent(row.video_id)}`,
      lastmod: toIsoDate(row.published_at),
    }));

  return xmlResponse(buildUrlSet(entries), 900);
}

async function serveChannelsSitemap(env, url) {
  const rows = await safeAll(env.DB, `
    SELECT channel_id, updated_at
    FROM channels
    ORDER BY updated_at DESC, channel_id ASC
    LIMIT 50000
  `, []);

  const entries = rows
    .filter((row) => row?.channel_id)
    .map((row) => ({
      loc: `${url.origin}/${encodeURIComponent(row.channel_id)}/videos`,
      lastmod: toIsoDate(row.updated_at),
    }));

  return xmlResponse(buildUrlSet(entries), 900);
}

async function servePlaylistsSitemap(env, url) {
  const rows = await safeAll(env.DB, `
    SELECT playlist_id, updated_at
    FROM playlists
    ORDER BY updated_at DESC, playlist_id ASC
    LIMIT 50000
  `, []);

  const entries = rows
    .filter((row) => row?.playlist_id)
    .map((row) => ({
      loc: `${url.origin}/${encodeURIComponent(row.playlist_id)}`,
      lastmod: toIsoDate(row.updated_at),
    }));

  return xmlResponse(buildUrlSet(entries), 900);
}

function isLikelySpaRoute(path) {
  if (path === "/" || path === "/videos" || path === "/shorts" || path === "/live" || path === "/channels" || path === "/playlists" || path === "/search") {
    return true;
  }

  if (/^\/hashtag(?:\/[^/]+)?$/.test(path)) return true;
  if (/^\/tag(?:\/[^/]+)?$/.test(path)) return true;
  if (/^\/([A-Za-z0-9_-]{11})$/.test(path)) return true;
  if (/^\/(PL[A-Za-z0-9_-]+)$/.test(path)) return true;
  if (/^\/(UC[A-Za-z0-9_-]{10,})(?:\/(videos|shorts|live|playlists))?$/.test(path)) return true;

  return false;
}

function buildFallbackMeta({ url, path }) {
  const staticMeta = getStaticMeta({ path, url });
  if (staticMeta) {
    return {
      ...staticMeta,
      origin: url.origin,
      url: url.toString(),
    };
  }

  const origin = url.origin;
  const canonical = `${origin}${path}`;

  if (/^\/([A-Za-z0-9_-]{11})$/.test(path)) {
    return {
      origin,
      url: url.toString(),
      canonical,
      type: "video.other",
      title: "Youtora | סרטון",
      description: "צפייה בסרטון ב־Youtora.",
      image: `${origin}/default-og.png`,
      robots: "index,follow,max-image-preview:large",
    };
  }

  if (/^\/(PL[A-Za-z0-9_-]+)$/.test(path)) {
    return {
      origin,
      url: url.toString(),
      canonical,
      type: "website",
      title: "Youtora | פלייליסט",
      description: "פלייליסט לצפייה ב־Youtora.",
      image: `${origin}/default-og.png`,
      robots: "index,follow,max-image-preview:large",
    };
  }

  if (/^\/(UC[A-Za-z0-9_-]{10,})(?:\/(videos|shorts|live|playlists))?$/.test(path)) {
    return {
      origin,
      url: url.toString(),
      canonical,
      type: "website",
      title: "Youtora | ערוץ",
      description: "עמוד ערוץ ב־Youtora.",
      image: `${origin}/default-og.png`,
      robots: "index,follow,max-image-preview:large",
    };
  }

  const hashtagMatch = path.match(/^\/hashtag(?:\/([^/]+))?$/);
  if (hashtagMatch) {
    const rawTag = hashtagMatch[1] ? decodeURIComponent(hashtagMatch[1]).trim().replace(/^#+/, "") : "";
    const display = rawTag ? `#${rawTag}` : "האשטג";
    return {
      origin,
      url: url.toString(),
      canonical: rawTag ? `${origin}/hashtag/${encodeURIComponent(rawTag)}` : `${origin}/hashtag`,
      type: "website",
      title: `${display} | Youtora`,
      description: rawTag ? `כל הסרטונים עם האשטג ${display} ב־Youtora.` : "סרטונים לפי האשטגים ב־Youtora.",
      image: `${origin}/default-og.png`,
      robots: "index,follow,max-image-preview:large",
    };
  }

  const tagMatch = path.match(/^\/tag(?:\/([^/]+))?$/);
  if (tagMatch) {
    const rawTag = tagMatch[1] ? decodeURIComponent(tagMatch[1]).trim().replace(/^#+/, "") : "";
    const isOldHashtag = url.searchParams.get("type") === "hashtag";
    const display = rawTag ? (isOldHashtag ? `#${rawTag}` : rawTag) : (isOldHashtag ? "האשטג" : "תגית");
    return {
      origin,
      url: url.toString(),
      canonical: rawTag
        ? isOldHashtag
          ? `${origin}/hashtag/${encodeURIComponent(rawTag)}`
          : `${origin}/tag/${encodeURIComponent(rawTag)}`
        : isOldHashtag
          ? `${origin}/hashtag`
          : `${origin}/tag`,
      type: "website",
      title: `${display} | Youtora`,
      description: rawTag
        ? `כל הסרטונים עם ${isOldHashtag ? "האשטג" : "תגית"} ${display} ב־Youtora.`
        : `סרטונים לפי ${isOldHashtag ? "האשטגים" : "תגיות"} ב־Youtora.`,
      image: `${origin}/default-og.png`,
      robots: "index,follow,max-image-preview:large",
    };
  }

  return {
    origin,
    url: url.toString(),
    canonical,
    type: "website",
    title: "Youtora",
    description: "ספריית וידאו ופלייליסטים מתעדכנת.",
    image: `${origin}/default-og.png`,
    robots: "index,follow,max-image-preview:large",
  };
}

async function serveNotFound(env, request, url) {
  const res404 = await env.ASSETS.fetch(new Request(new URL("/404.html", url), request));
  const out = new Response(res404.body, {
    status: 404,
    statusText: "Not Found",
    headers: res404.headers,
  });
  out.headers.set("Content-Type", "text/html; charset=UTF-8");
  out.headers.set("Cache-Control", "public, max-age=60");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}

async function resolveRoute({ url, env }) {
  const path = url.pathname;
  const origin = url.origin;
  const qs = url.searchParams;

  const staticMeta = getStaticMeta({ path, url });
  if (staticMeta) return { found: true, meta: { ...staticMeta, origin, url: url.toString() } };

  const mVideo = path.match(/^\/([A-Za-z0-9_-]{11})$/);
  if (mVideo) {
    const id = mVideo[1];
    const row = await firstRow(env.DB, `
      SELECT
        v.video_id,
        v.title,
        v.published_at,
        v.channel_int,
        v.language_code,
        v.video_kind,
        v.duration_sec,
        v.view_count,
        v.like_count,
        v.comment_count,
        c.channel_id,
        c.title AS channel_title,
        d.description AS video_description,
        d.tags_json,
        d.hashtags_json
      FROM videos v
      JOIN channels c ON c.id = v.channel_int
      LEFT JOIN video_details d ON d.video_id = v.video_id
      WHERE v.video_id = ?
        AND v.netfree_status = 1
      LIMIT 1
    `, [id]);
    if (!row) return { found: false };

    const videoId = String(row.video_id || "").trim();
    if (!videoId) return { found: false };

    const related = await safeAll(env.DB, `
      SELECT
        v.video_id,
        v.title,
        v.published_at,
        v.duration_sec
      FROM videos v INDEXED BY idx_videos_public_channel_kind_lang_latest_cover
      WHERE v.channel_int = ?
        AND v.netfree_status = 1
        AND v.video_kind = ?
        AND v.language_code = ?
        AND v.video_id <> ?
      ORDER BY v.published_at DESC, v.id DESC
      LIMIT 12
    `, [
      row.channel_int,
      normalizeVideoKind(row.video_kind),
      String(row.language_code || "he").trim() || "he",
      videoId
    ]);

    const title = String(row.title || videoId).trim() || videoId;
    const channelTitle = String(row.channel_title || row.channel_id || "").trim();
    const rawVideoDescription = String(row.video_description || "").trim();
    const description = rawVideoDescription
      ? makeSeoDescription(rawVideoDescription, title, channelTitle)
      : channelTitle
        ? `${title} · ${channelTitle} · צפייה בסרטון ב־Youtora`
        : `${title} · צפייה בסרטון ב־Youtora`;
    const canonical = `${origin}/${encodeURIComponent(videoId)}`;
    return {
      found: true,
      meta: {
        origin,
        url: url.toString(),
        canonical,
        type: "video.other",
        title: `${stripSiteSuffix(title)} | Youtora`,
        description,
        image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        robots: "index,follow,max-image-preview:large",
        jsonLd: buildVideoJsonLd({ row, canonical }),
        pageHtml: buildVideoSeoHtml({ row, canonical, related }),
      },
    };
  }

  const mPlaylist = path.match(/^\/(PL[A-Za-z0-9_-]+)$/);
  if (mPlaylist) {
    const playlistId = mPlaylist[1];
    const row = await firstRow(env.DB, `
      SELECT p.playlist_id, p.title, p.thumb_video_id, c.channel_id,
             c.title AS channel_title
      FROM playlists p
      LEFT JOIN channels c ON c.id = p.channel_int
      WHERE p.playlist_id = ?
      LIMIT 1
    `, [playlistId]);
    if (!row) return { found: false };

    const title = row.title || row.playlist_id;
    const channelTitle = row.channel_title || row.channel_id || "";
    const description = channelTitle
      ? `${title} · פלייליסט מערוץ ${channelTitle}`
      : `${title} · פלייליסט לצפייה ב־Youtora`;
    const canonical = `${origin}/${encodeURIComponent(row.playlist_id)}`;
    return {
      found: true,
      meta: {
        origin,
        url: url.toString(),
        canonical,
        type: "website",
        title: `${title} | פלייליסט | Youtora`,
        description,
        image: row.thumb_video_id ? `https://i.ytimg.com/vi/${row.thumb_video_id}/hqdefault.jpg` : `${origin}/default-og.png`,
        robots: "index,follow,max-image-preview:large",
        jsonLd: {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: title,
          description,
          url: canonical,
        },
      },
    };
  }

  const mChannel = path.match(/^\/(UC[A-Za-z0-9_-]{10,})(?:\/(videos|shorts|live|playlists))?$/);
  if (mChannel) {
    const channelId = mChannel[1];
    const tab = mChannel[2] || "videos";
    const row = await firstRow(env.DB, `
      SELECT channel_id, title, thumbnail_url, banner_url, description, localized_description
      FROM channels
      WHERE channel_id = ?
      LIMIT 1
    `, [channelId]);
    if (!row) return { found: false };

    const tabText = {
      videos: "סרטונים",
      shorts: "שורטים",
      live: "שידורים חיים",
      playlists: "פלייליסטים",
    }[tab] || "סרטונים";

    const title = row.title || row.channel_id;
    const baseDescription = row.localized_description || row.description || "";
    const description = baseDescription
      ? `${tabText} של הערוץ ${title} ב־Youtora. ${baseDescription}`.slice(0, 300)
      : `${tabText} של הערוץ ${title} ב־Youtora`;
    const canonical = `${origin}/${encodeURIComponent(row.channel_id)}/${tab}`;

    return {
      found: true,
      meta: {
        origin,
        url: url.toString(),
        canonical,
        type: "website",
        title: `${title} | ${tabText} | Youtora`,
        description,
        image: normalizeUrl(row.thumbnail_url, origin) || `${origin}/default-og.png`,
        robots: "index,follow,max-image-preview:large",
        jsonLd: {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: `${title} - ${tabText}`,
          description,
          url: canonical,
        },
      },
    };
  }

  return { found: false };
}

function getStaticMeta({ path, url }) {
  if (path === "/" || path === "/videos") {
    return {
      canonical: path === "/videos" ? `${url.origin}/videos` : `${url.origin}/`,
      type: "website",
      title: "Youtora | סרטונים מכל הערוצים",
      description: "עמוד הסרטונים של Youtora עם הסרטונים האחרונים מכל הערוצים.",
      image: `${url.origin}/default-og.png`,
      robots: "index,follow,max-image-preview:large",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Youtora",
        url: `${url.origin}/`,
        potentialAction: {
          "@type": "SearchAction",
          target: `${url.origin}/search?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      },
    };
  }

  const staticRoutes = {
    "/shorts": ["Youtora | שורטים", "השורטים האחרונים מכל הערוצים ב־Youtora."],
    "/live": ["Youtora | שידורים חיים", "השידורים החיים האחרונים מכל הערוצים ב־Youtora."],
    "/channels": ["Youtora | ערוצים", "רשימת כל הערוצים הזמינים ב־Youtora."],
    "/playlists": ["Youtora | פלייליסטים", "רשימת פלייליסטים מכל הערוצים ב־Youtora."],
  };

  if (staticRoutes[path]) {
    const [title, description] = staticRoutes[path];
    return {
      canonical: `${url.origin}${path}`,
      type: "website",
      title,
      description,
      image: `${url.origin}/default-og.png`,
      robots: "index,follow,max-image-preview:large",
    };
  }

  if (path === "/search") {
    const q = (url.searchParams.get("q") || "").trim();
    return {
      canonical: `${url.origin}/search${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      type: "website",
      title: q ? `חיפוש: ${q} | Youtora` : "חיפוש | Youtora",
      description: q ? `תוצאות חיפוש עבור ${q} ב־Youtora.` : "חיפוש ב־Youtora.",
      image: `${url.origin}/default-og.png`,
      robots: "noindex,follow,max-image-preview:large",
    };
  }

  return null;
}

function makeSeoDescription(description, title, channelTitle) {
  const clean = cleanSeoText(description, 220)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const base = clean || [title, channelTitle].filter(Boolean).join(" · ");
  return base.length > 165 ? `${base.slice(0, 162).trim()}…` : base;
}

function buildVideoSeoHtml({ row, canonical, related = [] }) {
  const videoId = String(row?.video_id || "").trim();
  const title = stripSiteSuffix(String(row?.title || videoId).trim() || videoId);
  const channelId = String(row?.channel_id || "").trim();
  const channelTitle = String(row?.channel_title || channelId || "").trim();
  const description = cleanSeoText(row?.video_description || "", 1800);
  const tags = [
    ...parseJsonArray(row?.hashtags_json).map((tag) => `#${String(tag).replace(/^#+/, "")}`),
    ...parseJsonArray(row?.tags_json).map((tag) => String(tag).replace(/^#+/, "")),
  ].filter(Boolean).slice(0, 18);
  const relatedItems = (related || []).filter((item) => item?.video_id).slice(0, 8);

  return `
    <article class="seoVideoPage" aria-label="פרטי הסרטון">
      <h1>${html(title)}</h1>

      <div class="seoVideoEmbed">
        <iframe
          src="https://www.youtube.com/embed/${encodeURIComponent(videoId)}?rel=0"
          title="${html(title)}"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowfullscreen></iframe>
      </div>

      <p class="seoVideoMeta">
        ${channelId ? `<a href="/${encodeURIComponent(channelId)}/videos" data-link>${html(channelTitle || channelId)}</a>` : html(channelTitle)}
        ${row?.published_at ? `<span>פורסם: ${html(formatHebrewDate(row.published_at))}</span>` : ""}
        ${row?.duration_sec ? `<span>משך: ${html(formatDurationText(row.duration_sec))}</span>` : ""}
      </p>

      ${tags.length ? `<nav class="seoTags" aria-label="תגיות">${tags.map(renderSeoTag).join("")}</nav>` : ""}

      ${description ? `<p class="seoDescription">${html(description)}</p>` : ""}

      <p class="seoOriginalLink">
        <a href="https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}" target="_blank" rel="nofollow noopener noreferrer">פתח את הסרטון המקורי ביוטיוב</a>
      </p>

      ${relatedItems.length ? `
        <section class="seoRelated" aria-label="עוד סרטונים מהערוץ">
          <h2>עוד סרטונים מהערוץ</h2>
          <ul>
            ${relatedItems.map((item) => `
              <li>
                <a href="/${encodeURIComponent(item.video_id)}" data-link>${html(stripSiteSuffix(item.title || item.video_id))}</a>
                ${item.published_at ? `<span>${html(formatHebrewDate(item.published_at))}</span>` : ""}
              </li>
            `).join("")}
          </ul>
        </section>
      ` : ""}
    </article>
  `;
}

function renderSeoTag(rawTag) {
  const value = String(rawTag || "").trim();
  if (!value) return "";

  if (value.startsWith("#")) {
    const clean = value.replace(/^#+/, "").trim();
    return clean ? `<a href="/hashtag/${encodeURIComponent(clean)}" data-link>${html(`#${clean}`)}</a>` : "";
  }

  return `<a href="/tag/${encodeURIComponent(value)}" data-link>${html(value)}</a>`;
}

function cleanSeoText(value, maxLen = 1000) {
  const clean = String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!clean) return "";
  return clean.length > maxLen ? `${clean.slice(0, Math.max(0, maxLen - 1)).trim()}…` : clean;
}

function stripSiteSuffix(value) {
  return String(value || "").replace(/\s*\|\s*Youtora\s*$/i, "").trim();
}

function formatHebrewDate(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Intl.DateTimeFormat("he-IL", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(n * 1000));
}

function formatDurationText(value) {
  const n = Math.floor(Number(value || 0));
  if (!Number.isFinite(n) || n <= 0) return "";
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function buildVideoJsonLd({ row, canonical }) {
  const videoId = String(row?.video_id || "").trim();
  if (!videoId) return null;

  const json = {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    name: String(row?.title || videoId).trim() || videoId,
    url: canonical,
    embedUrl: `https://www.youtube.com/embed/${videoId}`,
    thumbnailUrl: [`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`],
  };

  const description = cleanSeoText(row?.video_description || "", 900);
  if (description) json.description = description;

  const tags = [
    ...parseJsonArray(row?.tags_json),
    ...parseJsonArray(row?.hashtags_json)
  ].filter(Boolean).slice(0, 15);
  if (tags.length) json.keywords = [...new Set(tags)].join(", ");

  const viewCount = Number(row?.view_count || 0);
  if (Number.isFinite(viewCount) && viewCount > 0) {
    json.interactionStatistic = {
      "@type": "InteractionCounter",
      interactionType: { "@type": "WatchAction" },
      userInteractionCount: viewCount
    };
  }

  const channelTitle = String(row?.channel_title || row?.channel_id || "").trim();
  if (channelTitle) {
    json.publisher = {
      "@type": "Organization",
      name: channelTitle,
    };
  }

  const uploadDate = toIsoDateTime(row?.published_at);
  if (uploadDate) json.uploadDate = uploadDate;

  const duration = secondsToIsoDuration(row?.duration_sec);
  if (duration) json.duration = duration;

  return json;
}

async function firstRow(DB, sql, params) {
  if (!DB) return null;
  const res = await DB.prepare(sql).bind(...params).all();
  return res?.results?.[0] || null;
}

async function safeAll(DB, sql, params) {
  if (!DB) return [];
  try {
    const res = await DB.prepare(sql).bind(...params).all();
    return res?.results || [];
  } catch {
    return [];
  }
}

function buildUrlSet(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((entry) => `<url><loc>${xml(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${xml(entry.lastmod)}</lastmod>` : ""}</url>`).join("\n")}
</urlset>`;
}

function xmlResponse(body, maxAge = 900) {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=UTF-8",
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    },
  });
}

function secondsToIsoDuration(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  const total = Math.floor(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s || (!h && !m) ? `${s}S` : ""}`;
}

function toIsoDate(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString().slice(0, 10);
}

function toIsoDateTime(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString();
}

function normalizeVideoKind(value) {
  const kind = String(value || "V").trim().toUpperCase();
  return ["V", "S", "L"].includes(kind) ? kind : "V";
}

function normalizePath(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function normalizeUrl(u, origin) {
  if (!u) return "";
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return origin.replace(/\/$/, "") + u;
  return u;
}

function escJson(obj) {
  return JSON.stringify(obj).replaceAll("<", "\\u003c");
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
