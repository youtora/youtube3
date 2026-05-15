const $ = (id) => document.getElementById(id);

function esc(s){return (s||"").replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]))}

const YOUTUBE_DESKTOP_BANNER_SUFFIX = "=w1707-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj";
function channelBannerDisplayUrl(url){
  const raw = String(url || "").trim();
  if(!raw) return "";
  if(raw.includes("yt3.googleusercontent.com/") && !raw.includes("=w") && !raw.includes("-fcrop64=")){
    return raw + YOUTUBE_DESKTOP_BANNER_SUFFIX;
  }
  return raw;
}
function fmtDate(unix){
  if(!unix) return "";
  try { return new Date(unix*1000).toLocaleDateString('he-IL', { year:'numeric', month:'2-digit', day:'2-digit' }); }
  catch { return ""; }
}
function pad2(n){
  return String(n).padStart(2, "0");
}
function fmtClock(d){
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDateRel(unix){
  const n = Number(unix || 0);
  if(!Number.isFinite(n) || n <= 0) return "";

  const d = new Date(n * 1000);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((startToday - startTarget) / 86400000);

  if(diffDays === 0) return `היום ב־${fmtClock(d)}`;
  if(diffDays === 1) return `אתמול ב־${fmtClock(d)}`;
  if(diffDays === 2) return "לפני יומיים";
  if(diffDays < 7) return `לפני ${diffDays} ימים`;
  if(diffDays < 14) return "לפני שבוע";
  if(diffDays < 30){
    const weeks = Math.floor(diffDays / 7);
    return weeks <= 1 ? "לפני שבוע" : `לפני ${weeks} שבועות`;
  }
  if(diffDays < 60) return "לפני חודש";
  if(diffDays < 365){
    const months = Math.floor(diffDays / 30);
    return months <= 1 ? "לפני חודש" : `לפני ${months} חודשים`;
  }
  if(diffDays < 730) return "לפני שנה";
  return `לפני ${Math.floor(diffDays / 365)} שנים`;
}
function fmtDuration(sec){
  const n = Number(sec);
  if(!Number.isFinite(n) || n <= 0) return "";

  const total = Math.floor(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtCount(value){
  const n = Number(value);
  if(!Number.isFinite(n) || n < 0) return "";
  try { return new Intl.NumberFormat('he-IL', { notation:'compact', maximumFractionDigits:1 }).format(n); }
  catch { return String(Math.round(n)); }
}
const MIN_VISIBLE_VIEWS = 10; // מציגים צפיות רק מ־10 ומעלה
const MIN_VISIBLE_LIKES = 10; // מציגים לייקים רק מ־10 ומעלה

function fmtViews(value){
  const n = Number(value);
  if(!Number.isFinite(n) || n < MIN_VISIBLE_VIEWS) return "";

  const s = fmtCount(n);
  return s ? `${s} צפיות` : "";
}
function fmtLikes(value){
  if(value === null || value === undefined || value === "") return "";

  const n = Number(value);
  if(!Number.isFinite(n) || n < MIN_VISIBLE_LIKES) return "";

  const s = fmtCount(n);
  return s ? `${s} לייקים` : "";
}
function arr(value){
  return Array.isArray(value) ? value : [];
}
const LANG_FILTERS = ["he", "en", "fr", "yi", "ru"];
function normalizeLangFilter(value){
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  const base = raw.split("-")[0];
  const map = { iw:"he", he:"he", en:"en", fr:"fr", yi:"yi", yid:"yi", ji:"yi", ru:"ru" };
  const lang = map[base] || base;
  return LANG_FILTERS.includes(lang) ? lang : "he";
}
function currentLang(qs){
  return normalizeLangFilter((qs || new URLSearchParams(location.search)).get("lang") || "he");
}
function langParam(lang){
  return normalizeLangFilter(lang);
}
function langUrl(path, lang, extraParams={}){
  const q = new URLSearchParams();
  q.set("lang", langParam(lang));
  for (const [key, value] of Object.entries(extraParams || {})) {
    if (value !== undefined && value !== null && String(value).trim() !== "") q.set(key, String(value));
  }
  return path + "?" + q.toString();
}
function renderLanguageFilter(activeLang, path, extraParams={}){
  const active = langParam(activeLang);
  const links = LANG_FILTERS.map(code => {
    const cls = code === active ? "languagePill active" : "languagePill";
    return '<a class="' + cls + '" href="' + esc(langUrl(path, code, extraParams)) + '" data-link>' + esc(languageName(code)) + '</a>';
  }).join("");
  return '<div class="languageFilter" role="navigation" aria-label="סינון לפי שפה"><span class="languageFilterLabel">שפה:</span>' + links + '</div>';
}
const CHANNEL_SORTS = [
  { value: "latest", label: "חדשים" },
  { value: "oldest", label: "ישנים" },
  { value: "views", label: "הכי נצפים" },
];
function normalizeChannelSort(value){
  const sort = String(value || "latest").trim().toLowerCase();
  return CHANNEL_SORTS.some(x => x.value === sort) ? sort : "latest";
}
function renderChannelSortFilter(activeSort, path, lang){
  const active = normalizeChannelSort(activeSort);
  const links = CHANNEL_SORTS.map(item => {
    const cls = item.value === active ? "languagePill active" : "languagePill";
    const params = item.value === "latest" ? {} : { sort: item.value };
    return '<a class="' + cls + '" href="' + esc(langUrl(path, lang, params)) + '" data-link>' + esc(item.label) + '</a>';
  }).join("");
  return '<div class="languageFilter channelSortFilter" role="navigation" aria-label="מיון סרטוני הערוץ"><span class="languageFilterLabel">מיון:</span>' + links + '</div>';
}

const LATEST_SORTS = [
  { value: "latest", label: "חדשים" },
  { value: "views", label: "הכי נצפים" },
];
function normalizeLatestSort(value){
  const sort = String(value || "latest").trim().toLowerCase();
  return LATEST_SORTS.some(x => x.value === sort) ? sort : "latest";
}
function renderLatestSortFilter(activeSort, path, lang){
  const active = normalizeLatestSort(activeSort);
  const links = LATEST_SORTS.map(item => {
    const cls = item.value === active ? "languagePill active" : "languagePill";
    const params = item.value === "latest" ? {} : { sort: item.value };
    return '<a class="' + cls + '" href="' + esc(langUrl(path, lang, params)) + '" data-link>' + esc(item.label) + '</a>';
  }).join("");
  return '<div class="languageFilter channelSortFilter" role="navigation" aria-label="מיון סרטונים כלליים"><span class="languageFilterLabel">מיון:</span>' + links + '</div>';
}
function normalizeTagName(value){
  return String(value || "")
    .trim()
    .replace(/^#+/, "")
    .trim()
    .replace(/[“”״]/g, '"')
    .replace(/[‘’׳]/g, "'");
}
function tagPageHref(value, type="tag"){
  const name = normalizeTagName(value);
  const tagType = type === "hashtag" ? "hashtag" : "tag";
  const base = tagType === "hashtag" ? "/hashtag" : "/tag";
  return name ? `${base}/${encodeURIComponent(name)}` : base;
}
function splitTrailingUrlPunctuation(value){
  let main = String(value || "");
  let tail = "";

  while(main && /[.,!?;:)\]\}״”’']$/.test(main)){
    tail = main.slice(-1) + tail;
    main = main.slice(0, -1);
  }

  return { main, tail };
}
function linkifyText(value){
  const text = String(value || "");
  if(!text) return "";

  const tokenRe = /(?:https?:\/\/|www\.)[^\s<>"']+|#(?:[\p{L}\p{N}_-]|['"׳״‘’“”](?=[\p{L}\p{N}_-])){2,80}/gu;
  let out = "";
  let last = 0;
  let m;

  while((m = tokenRe.exec(text))){
    const token = m[0];
    out += esc(text.slice(last, m.index));

    if(token.startsWith("#")){
      const name = normalizeTagName(token);
      out += name
        ? `<a class="inlineHashLink" href="${tagPageHref(name, "hashtag")}" data-link>#${esc(name)}</a>`
        : esc(token);
    } else {
      const { main, tail } = splitTrailingUrlPunctuation(token);
      const href = main.startsWith("www.") ? `https://${main}` : main;
      out += main
        ? `<a class="textLink" href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(main)}</a>${esc(tail)}`
        : esc(token);
    }

    last = tokenRe.lastIndex;
  }

  out += esc(text.slice(last));
  return out;
}
function renderTagChip(value){
  const name = normalizeTagName(value);
  if(!name) return "";
  return `<a class="tagChip" href="${tagPageHref(name, "tag")}" data-link>${esc(name)}</a>`;
}
function ytVideoThumb(videoId, q="mqdefault"){ return videoId ? `https://i.ytimg.com/vi/${videoId}/${q}.jpg` : ""; }
function ytShortThumb(videoId){ return videoId ? `https://i.ytimg.com/vi/${videoId}/oar2.jpg` : ""; }
function videoKindLabel(kind){
  if(kind === "S") return "שורט";
  if(kind === "L") return "שידור חי";
  return "";
}

async function api(url){
  const r = await fetch(url);
  const t = await r.text();
  if(!r.ok) throw new Error(`${r.status} ${t.slice(0,200)}`);
  return JSON.parse(t);
}


function absoluteUrl(pathOrUrl){
  try { return new URL(pathOrUrl, location.origin).toString(); }
  catch { return location.origin + "/"; }
}
function upsertMetaByName(name, content){
  let el = document.head.querySelector(`meta[name="${name}"]`);
  if(!el){
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content || "");
}
function upsertMetaByProperty(prop, content){
  let el = document.head.querySelector(`meta[property="${prop}"]`);
  if(!el){
    el = document.createElement("meta");
    el.setAttribute("property", prop);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content || "");
}
function upsertCanonical(href){
  let el = document.head.querySelector('link[rel="canonical"]');
  if(!el){
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", absoluteUrl(href || location.pathname + location.search));
}
function upsertStructuredData(obj){
  let el = document.head.querySelector('#structured-data');
  if(!el){
    el = document.createElement('script');
    el.id = 'structured-data';
    el.type = 'application/ld+json';
    document.head.appendChild(el);
  }
  el.textContent = obj ? JSON.stringify(obj).replace(/</g, '\\u003c') : '';
}
function applyRouteMeta(meta={}){
  const title = meta.title || 'Youtora';
  const description = meta.description || 'Youtora - ספריית סרטונים, ערוצים ופלייליסטים מתעדכנת.';
  const canonical = absoluteUrl(meta.canonical || (location.pathname + location.search));
  const robots = meta.robots || 'index,follow,max-image-preview:large';
  const image = absoluteUrl(meta.image || '/default-og.png');
  const ogType = meta.type || 'website';

  document.title = title;
  upsertMetaByName('description', description);
  upsertMetaByName('robots', robots);
  upsertCanonical(canonical);
  upsertMetaByProperty('og:type', ogType);
  upsertMetaByProperty('og:site_name', 'Youtora');
  upsertMetaByProperty('og:title', title);
  upsertMetaByProperty('og:description', description);
  upsertMetaByProperty('og:image', image);
  upsertMetaByProperty('og:url', canonical);
  upsertMetaByName('twitter:card', 'summary_large_image');
  upsertMetaByName('twitter:title', title);
  upsertMetaByName('twitter:description', description);
  upsertMetaByName('twitter:image', image);
  upsertStructuredData(meta.jsonLd || null);
}
function secondsToIsoDuration(sec){
  const n = Number(sec || 0);
  if(!Number.isFinite(n) || n <= 0) return '';
  const total = Math.floor(n);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}
function latestSeo(kind=''){
  if(kind === 'S') return {
    title: 'Youtora | שורטים',
    description: 'השורטים האחרונים מכל הערוצים ב־Youtora.',
    canonical: '/shorts'
  };
  if(kind === 'L') return {
    title: 'Youtora | שידורים חיים',
    description: 'השידורים החיים האחרונים מכל הערוצים ב־Youtora.',
    canonical: '/live'
  };
  return {
    title: 'Youtora | סרטונים מכל הערוצים',
    description: 'עמוד הבית של Youtora עם הסרטונים האחרונים מכל הערוצים.',
    canonical: '/'
  };
}
function channelTabLabel(tab){
  if(tab === 'shorts') return 'שורטים';
  if(tab === 'live') return 'שידורים חיים';
  if(tab === 'playlists') return 'פלייליסטים';
  return 'סרטונים';
}

function setPage(inner){
  $("page").innerHTML = `<div class="pad">${inner}</div>`;
}

function navigate(path){
  history.pushState({}, "", path);
  render().catch(showErr);
}

function hookLinks(){
  document.addEventListener("click", (e)=>{
    const a = e.target.closest("a");
    if(!a) return;
    const href = a.getAttribute("href") || "";
    const target = a.getAttribute("target");
    if(target === "_blank") return;
    if(!href.startsWith("/")) return;
    if(!a.hasAttribute("data-link")) return;
    e.preventDefault();
    navigate(href);
  });
}

window.addEventListener("popstate", ()=>render().catch(showErr));

function route(){
  const p = location.pathname.replace(/\/+$/,"") || "/";
  const parts = p.split("/").filter(Boolean);
  const qs = new URLSearchParams(location.search);
  return { p, parts, qs };
}

function showErr(err){
  applyRouteMeta({ title:'שגיאה | Youtora', description:'אירעה שגיאה בטעינת הדף.', robots:'noindex,follow' });
  setPage(`<div class="h1">שגיאה</div><p class="sub">${esc(err?.message || String(err))}</p>`);
}

function setActiveNav(){
  const path = location.pathname.replace(/\/+$/,"") || "/";
  const links = document.querySelectorAll('.nav .navLink[data-link]');

  links.forEach((link)=>{
    const href = (link.getAttribute('href') || '').replace(/\/+$/, '') || '/';
    let active = false;

    if (href === '/') active = path === '/';
    else active = path === href || path.startsWith(href + '/');

    link.classList.toggle('active', active);
  });
}

function headerSearch(){
  const form = $("searchForm");
  const input = $("searchInput");
  if (!form || !input) return;
  form.onsubmit = (e)=>{
    e.preventDefault();
    const q = (input.value||"").trim();
    if(!q) return;
    navigate(`/search?q=${encodeURIComponent(q)}`);
  };
}


function renderNetfreeProbeBanner(){
  return `
    <div id="netfreeProbeBanner" style="margin:0 0 14px;padding:10px 14px;border:1px solid #e5e5e5;border-radius:10px;background:#fafafa;color:#333;font-size:14px;line-height:1.5">
      בדיקת סינון: בודק אם הגלישה היא דרך נטפרי…
    </div>
  `;
}

async function canReachNetfreeProbeUrl(url, timeoutMs = 1800){
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await fetch(url + "?t=" + Date.now(), {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal
    });

    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateNetfreeProbeBanner(){
  const el = document.getElementById("netfreeProbeBanner");
  if(!el) return;

  const results = await Promise.all([
    canReachNetfreeProbeUrl("https://api.internal.netfree.link/user/0"),
    canReachNetfreeProbeUrl("https://certx2.internal.netfree.link/user/0")
  ]);

  const isNetfree = results.some(Boolean);

  el.textContent = isNetfree
    ? "בדיקת סינון: נראה שאתה גולש דרך נטפרי"
    : "בדיקת סינון: לא זוהתה גלישה דרך נטפרי";

  el.style.background = isNetfree ? "#f1fff5" : "#fff8f0";
  el.style.borderColor = isNetfree ? "#bfe8ca" : "#f0d2aa";
}


function renderShortCard(v){
  const thumb = ytShortThumb(v.video_id);
  const relDate = fmtDateRel(v.published_at);
  const duration = fmtDuration(v.duration_sec);
  const views = fmtViews(v.view_count);
  const likes = fmtLikes(v.like_count);
  const channelHref = v.channel_id ? `/${encodeURIComponent(v.channel_id)}/videos` : "";
  const channelName = v.channel_title || v.channel_id || "";
  const channelThumb = v.channel_thumbnail_url || "";

  return `
    <article class="shortCard">
      <a class="shortThumbWrap" href="/${encodeURIComponent(v.video_id)}" data-link>
        <img class="shortThumb" loading="lazy" decoding="async" src="${esc(thumb)}">
        ${duration ? `<span class="thumbBadge">${esc(duration)}</span>` : ``}
      </a>

      <div class="shortBody">
        <a class="cardTitleLink" href="/${encodeURIComponent(v.video_id)}" data-link>
          <div class="shortTitle">${esc(v.title || v.video_id)}</div>
        </a>

        <div class="videoMetaStackRow">
          ${channelHref
            ? `<a class="videoChannelAvatarLink" href="${channelHref}" data-link>
                ${channelThumb
                  ? `<img class="videoChannelAvatar metaAvatar" loading="lazy" decoding="async" src="${esc(channelThumb)}" onerror="this.style.display='none'">`
                  : `<span class="videoChannelAvatar videoChannelAvatarFallback metaAvatar"></span>`
                }
              </a>`
            : `${channelThumb
                  ? `<img class="videoChannelAvatar metaAvatar" loading="lazy" decoding="async" src="${esc(channelThumb)}" onerror="this.style.display='none'">`
                  : `<span class="videoChannelAvatar videoChannelAvatarFallback metaAvatar"></span>`
              }`
          }

          <div class="videoMetaStack">
            <div class="videoMetaDate">${esc([relDate, views, likes].filter(Boolean).join(" · "))}</div>
            ${channelHref
              ? `<a class="videoChannelLink videoChannelBelow shortChannelLink" href="${channelHref}" data-link>${esc(channelName)}</a>`
              : `<div class="videoChannelLink videoChannelBelow shortChannelLink">${esc(channelName)}</div>`
            }
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderVideoCard(v){
  const thumb = ytVideoThumb(v.video_id);
  const relDate = fmtDateRel(v.published_at);
  const duration = fmtDuration(v.duration_sec);
  const views = fmtViews(v.view_count);
  const likes = fmtLikes(v.like_count);
  const channelHref = v.channel_id ? `/${encodeURIComponent(v.channel_id)}/videos` : "";
  const channelName = v.channel_title || v.channel_id || "";
  const channelThumb = v.channel_thumbnail_url || "";

  return `
    <article class="card">
      <a class="cardThumbLink thumbWrap" href="/${encodeURIComponent(v.video_id)}" data-link>
        <img class="thumb16x9" loading="lazy" decoding="async" src="${esc(thumb)}">
        ${duration ? `<span class="thumbBadge">${esc(duration)}</span>` : ``}
      </a>

      <div class="cardBody videoCardBody">
        <a class="cardTitleLink" href="/${encodeURIComponent(v.video_id)}" data-link>
          <div class="cardTitle">${esc(v.title || v.video_id)}</div>
        </a>

        <div class="videoMetaStackRow">
          ${channelHref
            ? `<a class="videoChannelAvatarLink" href="${channelHref}" data-link>
                ${channelThumb
                  ? `<img class="videoChannelAvatar metaAvatar" loading="lazy" decoding="async" src="${esc(channelThumb)}" onerror="this.style.display='none'">`
                  : `<span class="videoChannelAvatar videoChannelAvatarFallback metaAvatar"></span>`
                }
              </a>`
            : `${channelThumb
                  ? `<img class="videoChannelAvatar metaAvatar" loading="lazy" decoding="async" src="${esc(channelThumb)}" onerror="this.style.display='none'">`
                  : `<span class="videoChannelAvatar videoChannelAvatarFallback metaAvatar"></span>`
              }`
          }

          <div class="videoMetaStack">
            <div class="videoMetaDate">${esc([relDate, views, likes].filter(Boolean).join(" · "))}</div>
            ${channelHref
              ? `<a class="videoChannelLink videoChannelBelow" href="${channelHref}" data-link>${esc(channelName)}</a>`
              : `<div class="videoChannelLink videoChannelBelow">${esc(channelName)}</div>`
            }
          </div>
        </div>
      </div>
    </article>
  `;
}

/* ========= Infinite Loader (minimal & safe) ========= */
let activeObserver = null;

function stopActiveObserver(){
  if (activeObserver) {
    try { activeObserver.disconnect(); } catch {}
    activeObserver = null;
  }
}

/**
 * Creates infinite scroll observer on a sentinel element.
 * - Calls `onNearEnd()` when sentinel is near viewport.
 * - Uses rootMargin to preload early.
 * - Safe: only 1 active observer at a time (SPA).
 */
function startInfiniteScroll({ sentinelEl, onNearEnd, enabled = true, rootMargin = "800px 0px" }) {
  stopActiveObserver();

  if (!enabled) return null;
  if (!sentinelEl) return null;
  if (typeof IntersectionObserver === "undefined") return null;

  const obs = new IntersectionObserver((entries)=>{
    for (const e of entries) {
      if (e.isIntersecting) {
        onNearEnd();
      }
    }
  }, { root: null, rootMargin, threshold: 0 });

  obs.observe(sentinelEl);
  activeObserver = obs;
  return obs;
}

/* ---------- LATEST PAGES: home / shorts / live ---------- */
let latestState = { kind: "", lang: "he", sort: "latest", cursor: null, loading: false, done: false, token: 0 };

function latestPageMeta(kind){
  if(kind === "S") return { title: "שורטים", sub: "השורטים האחרונים מכל הערוצים" };
  if(kind === "L") return { title: "שידורים חיים", sub: "השידורים החיים האחרונים מכל הערוצים" };
  return { title: "בית", sub: "הסרטונים האחרונים מכל הערוצים" };
}

async function pageLatest(kind="", qs=new URLSearchParams(location.search)){
  const lang = currentLang(qs);
  const sort = normalizeLatestSort(qs.get("sort"));
  const path = kind === "S" ? "/shorts" : kind === "L" ? "/live" : "/";
  latestState = { kind, lang, sort, cursor: null, loading: false, done: false, token: latestState.token + 1 };
  const t = latestState.token;
  const meta = latestPageMeta(kind);
  applyRouteMeta(latestSeo(kind));

  setPage(`
    ${kind === "" ? renderNetfreeProbeBanner() : ""}
    <div class="h1">${esc(meta.title)}</div>
    <p class="sub">${esc(meta.sub)} · ${esc(languageName(lang))}</p>
    ${renderLanguageFilter(lang, path, sort === "latest" ? {} : { sort })}
    ${renderLatestSortFilter(sort, path, lang)}
    <div class="hr"></div>

    <div id="latestGrid" class="${kind === "S" ? "shortsGrid" : "grid"}"></div>

    <div id="latestSentinel" style="height:1px"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="latestMoreBtn" class="btn" type="button" style="display:none">טען עוד</button>
    </div>

    <div id="latestHint" class="muted" style="margin-top:8px"></div>
  `);

  if(kind === "") updateNetfreeProbeBanner();

  const btn = document.getElementById("latestMoreBtn");
  const hint = document.getElementById("latestHint");
  const sentinel = document.getElementById("latestSentinel");

  btn.onclick = () => latestLoadMore(t);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO) btn.style.display = "inline-flex";

  await latestLoadMore(t);

  if (hasIO) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => latestLoadMore(t),
      enabled: true,
      rootMargin: "900px 0px",
    });
    hint.textContent = latestState.done ? "סוף הרשימה." : "";
  }
}

async function latestLoadMore(token){
  if (latestState.loading || latestState.done) return;
  latestState.loading = true;

  const btn = document.getElementById("latestMoreBtn");
  const hint = document.getElementById("latestHint");
  const grid = document.getElementById("latestGrid");

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "טוען…";

  const url =
    `/api/latest?limit=24` +
    `&lang=${encodeURIComponent(latestState.lang)}` +
    `&sort=${encodeURIComponent(latestState.sort)}` +
    `&kind=${encodeURIComponent(latestState.kind || "V")}` +
    (latestState.cursor ? `&cursor=${encodeURIComponent(latestState.cursor)}` : "");

  const data = await api(url);

  if (token !== latestState.token) return;

  const vids = data.videos || [];
  if (vids.length) {
    const renderer = latestState.kind === "S" ? renderShortCard : renderVideoCard;
    grid.insertAdjacentHTML("beforeend", vids.map(renderer).join(""));
  }

  latestState.cursor = data.next_cursor || null;
  latestState.done = !latestState.cursor || vids.length === 0;

  if (btn) {
    btn.disabled = false;
    btn.style.display = (typeof IntersectionObserver === "undefined" && !latestState.done) ? "inline-flex" : "none";
  }

  if (hint) hint.textContent = latestState.done ? "סוף הרשימה." : "";

  if (latestState.done) stopActiveObserver();

  latestState.loading = false;
}

async function pageHome(qs){
  return pageLatest("", qs);
}

async function pageShorts(qs){
  return pageLatest("S", qs);
}

async function pageLive(qs){
  return pageLatest("L", qs);
}

/* ---------- PAGES: channels list ---------- */
function renderChannelCard(ch, lang="he"){
  const href = langUrl(`/${encodeURIComponent(ch.channel_id)}/videos`, lang);
  return `
    <a class="channelCard" href="${esc(href)}" data-link>
      <span class="channelCardMedia">
        ${ch.thumbnail_url
          ? `<img class="channelCardAvatar" loading="lazy" decoding="async" src="${esc(ch.thumbnail_url)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ``}
        <span class="channelCardAvatar channelCardAvatarFallback"${ch.thumbnail_url ? ` style="display:none"` : ``}>${esc((ch.title || ch.channel_id || "").trim().charAt(0) || "?")}</span>
      </span>
      <span class="channelCardTitle">${esc(ch.title || ch.channel_id)}</span>
    </a>
  `;
}

function normFilterValue(value){
  return String(value || "").trim().toLowerCase();
}

function channelTopicMatches(ch, topic){
  const wanted = normFilterValue(topic);
  if (!wanted) return true;
  return arr(ch.topic_categories).some(t => normFilterValue(topicLabel(t)) === wanted);
}

function channelKeywordMatches(ch, keyword){
  const wanted = normFilterValue(keyword);
  if (!wanted) return true;
  return parseBrandingKeywords(ch.branding_keywords || "")
    .some(k => normFilterValue(k) === wanted);
}

async function pageChannels(qs=new URLSearchParams()){
  stopActiveObserver();

  const lang = currentLang(qs);
  const topic = (qs.get("topic") || "").trim();
  const keyword = (qs.get("keyword") || "").trim();
  const hasFilter = !!(topic || keyword);
  const filterTopicTitle = topic ? topicDisplayLabel(topic) : "";
  const filterTitle = topic
    ? `ערוצים בקטגוריה ${filterTopicTitle}`
    : keyword
      ? `ערוצים לפי מילת מפתח ${keyword}`
      : "ערוצים";

  applyRouteMeta({
    title: hasFilter ? `${filterTitle} | ${languageName(lang)} | Youtora` : `Youtora | ערוצים | ${languageName(lang)}`,
    description: hasFilter ? `${filterTitle} ב־Youtora בשפה ${languageName(lang)}.` : `רשימת הערוצים ב־Youtora בשפה ${languageName(lang)}.`,
    canonical: hasFilter
      ? `/channels?${topic ? `topic=${encodeURIComponent(topic)}` : `keyword=${encodeURIComponent(keyword)}`}`
      : '/channels',
    robots: hasFilter ? 'noindex,follow' : 'index,follow,max-image-preview:large'
  });

  setPage(`<div class="muted">טוען ערוצים…</div>`);
  const data = await api(`/api/channels?lang=${encodeURIComponent(lang)}`);
  const channels = data.channels || [];
  const filtered = channels
    .filter(ch => channelTopicMatches(ch, topic))
    .filter(ch => channelKeywordMatches(ch, keyword));

  setPage(`
    <div class="h1">${esc(filterTitle)}</div>
    <p class="sub">${hasFilter ? `נמצאו ${filtered.length} ערוצים מתוך ${channels.length}` : `ערוצים בשפה ${languageName(lang)}`}</p>

    ${renderLanguageFilter(lang, "/channels", { ...(topic ? { topic } : {}), ...(keyword ? { keyword } : {}) })}

    ${hasFilter ? `
      <div class="btnRow">
        <a class="btn" href="${langUrl("/channels", lang)}" data-link>נקה סינון</a>
      </div>
    ` : ``}

    <div class="hr"></div>

    ${filtered.length ? `
      <div class="channelsGrid">
        ${filtered.map(ch => renderChannelCard(ch, lang)).join("")}
      </div>
    ` : `<div class="muted">לא נמצאו ערוצים מתאימים.</div>`}
  `);
}

/* ---------- PAGES: playlists list ---------- */
let playlistsState = { cursor: null, loading: false, done: false, token: 0 };

function renderPlaylistCard(p){
  const count = Number(p.item_count);
  const countText = Number.isFinite(count) && count > 0 ? `${count} סרטונים` : "פלייליסט";
  const channelName = p.channel_title || p.channel_id || "";
  const thumb = p.thumb_video_id ? ytVideoThumb(p.thumb_video_id) : "";

  return `
    <a class="playlistCard" href="/${encodeURIComponent(p.playlist_id)}" data-link>
      <span class="playlistVisual">
        <span class="playlistThumbWrap thumbWrap">
          ${thumb
            ? `<img class="thumb16x9 playlistThumb" loading="lazy" decoding="async"
                 src="${esc(thumb)}"
                 onerror="this.style.display='none'">`
            : `<span class="thumb16x9 playlistThumb"></span>`
          }
          <span class="playlistShade"></span>
          <span class="playlistTypeBadge">פלייליסט</span>
          <span class="playlistCountBadge">${esc(countText)}</span>
        </span>
      </span>

      <span class="playlistBody">
        <span class="playlistTitle">${esc(p.title || p.playlist_id)}</span>
        <span class="playlistChannel">${esc(channelName)}</span>
        <span class="playlistMetaLink">עודכן לצפייה</span>
      </span>
    </a>
  `;
}

async function pagePlaylists(){
  stopActiveObserver();
  applyRouteMeta({ title:'Youtora | פלייליסטים', description:'רשימת פלייליסטים מכל הערוצים ב־Youtora.', canonical:'/playlists' });

  playlistsState = { cursor: null, loading: false, done: false, token: playlistsState.token + 1 };
  const t = playlistsState.token;

  setPage(`
    <div class="h1">פלייליסטים</div>
    <p class="sub">רשימת פלייליסטים מכל הערוצים</p>
    <div class="hr"></div>

    <div id="plGrid" class="playlistGrid"></div>

    <div id="plSentinel" style="height:1px"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="plMoreBtn" class="btn" type="button" style="display:none">טען עוד</button>
    </div>

    <div id="plHint" class="muted" style="margin-top:8px"></div>
  `);

  const btn = document.getElementById("plMoreBtn");
  const hint = document.getElementById("plHint");
  const sentinel = document.getElementById("plSentinel");

  btn.onclick = () => playlistsLoadMore(t);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO) btn.style.display = "inline-flex";

  await playlistsLoadMore(t);

  if (hasIO) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => playlistsLoadMore(t),
      enabled: true,
      rootMargin: "900px 0px",
    });
  }

  if (hint) hint.textContent = playlistsState.done ? "סוף הרשימה." : "";
}

async function playlistsLoadMore(token){
  if (playlistsState.loading || playlistsState.done) return;
  playlistsState.loading = true;

  const btn = document.getElementById("plMoreBtn");
  const hint = document.getElementById("plHint");
  const grid = document.getElementById("plGrid");

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "טוען…";

  const url = `/api/playlists?limit=60${playlistsState.cursor ? `&cursor=${encodeURIComponent(playlistsState.cursor)}` : ""}`;
  const data = await api(url);

  if (token !== playlistsState.token) {
    playlistsState.loading = false;
    return;
  }

  const pls = data.playlists || [];
  if (pls.length) {
    grid.insertAdjacentHTML("beforeend", pls.map(renderPlaylistCard).join(""));
  }

  playlistsState.cursor = data.next_cursor || null;
  playlistsState.done = !playlistsState.cursor || pls.length === 0;

  if (btn) {
    btn.disabled = false;
    btn.style.display = (typeof IntersectionObserver === "undefined" && !playlistsState.done) ? "inline-flex" : "none";
  }
  if (hint) hint.textContent = playlistsState.done ? "סוף הרשימה." : "";

  if (playlistsState.done) stopActiveObserver();

  playlistsState.loading = false;
}


/* ---------- SEARCH (with cursor pagination) ---------- */
let searchState = { key: "", cursor: null, loading: false, done: false, token: 0 };

async function pageSearch(q, scope="title"){
  stopActiveObserver();

  const searchScope = scope === "all" ? "all" : "title";

  if(!q){
    applyRouteMeta({ title:'חיפוש | Youtora', description:'חיפוש ב־Youtora.', canonical:'/search', robots:'noindex,follow' });
    setPage(`<div class="h1">חיפוש</div><p class="sub">הקלד מילה בחיפוש למעלה.</p>`);
    return;
  }

  const canonical = `/search?q=${encodeURIComponent(q)}${searchScope === "all" ? "&scope=all" : ""}`;
  applyRouteMeta({ title:`חיפוש: ${q} | Youtora`, description:`תוצאות חיפוש עבור ${q} ב־Youtora.`, canonical, robots:'noindex,follow' });

  const si = $("searchInput");
  if (si) si.value = q;

  searchState = { key: `${q}|${searchScope}`, cursor: null, loading: false, done: false, token: searchState.token + 1 };
  const t = searchState.token;

  setPage(`
    <div class="h1">תוצאות חיפוש</div>
    <p class="sub">מילת חיפוש: <b>${esc(q)}</b></p>

    <div class="tabs" style="margin-top:10px">
      <a class="tab ${searchScope === "title" ? "active" : ""}" href="/search?q=${encodeURIComponent(q)}" data-link>כותרות בלבד</a>
      <a class="tab ${searchScope === "all" ? "active" : ""}" href="/search?q=${encodeURIComponent(q)}&scope=all" data-link>כולל תיאור ותגיות</a>
    </div>

    <div class="hr"></div>

    <div id="searchGrid" class="grid"></div>

    <div id="searchSentinel" style="height:1px"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="searchMoreBtn" class="btn" type="button">טען עוד</button>
    </div>

    <div id="searchHint" class="muted" style="margin-top:8px"></div>
  `);

  const grid = document.getElementById("searchGrid");
  const btn = document.getElementById("searchMoreBtn");
  const hint = document.getElementById("searchHint");
  const sentinel = document.getElementById("searchSentinel");

  btn.onclick = () => searchLoadMore(t, q, searchScope);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO) btn.style.display = "inline-flex";

  // טעינה ראשונה
  await searchLoadMore(t, q, searchScope);

  // אינסוף־סקрол
  if (hasIO && !searchState.done) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => searchLoadMore(t, q, searchScope),
      enabled: true,
      rootMargin: "200px 0px",
    });
  }

  if (hint) hint.textContent = searchState.done ? "סוף הרשימה." : "";
}

async function searchLoadMore(token, q, scope="title"){
  const searchScope = scope === "all" ? "all" : "title";
  if (searchState.loading || searchState.done) return;
  if (searchState.key !== `${q}|${searchScope}`) return;

  searchState.loading = true;

  const btn = document.getElementById("searchMoreBtn");
  const hint = document.getElementById("searchHint");
  const grid = document.getElementById("searchGrid");

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "טוען…";

  const url =
    `/api/search?q=${encodeURIComponent(q)}&limit=50&scope=${encodeURIComponent(searchScope)}` +
    (searchState.cursor ? `&cursor=${encodeURIComponent(searchState.cursor)}` : "");


  let data;
  try {
    data = await api(url);
  } catch (err) {
    searchState.loading = false;
    if (btn) btn.disabled = false;
    if (hint) hint.textContent = `שגיאה בטעינה: ${err?.message || String(err)}`;
    return;
  }

  if (token !== searchState.token) {
    searchState.loading = false;
    return;
  }

  const results = data.results || data.videos || data.items || [];
  if (results.length) {
    grid.insertAdjacentHTML("beforeend", results.map(r => renderVideoCard(r)).join(""));
  }

  const next =
    data.next_cursor ||
    data.videos_next_cursor ||
    data.nextCursor ||
    data.cursor ||
    null;

  searchState.cursor = next ? String(next) : null;
  searchState.done = !searchState.cursor || results.length === 0;

  if (btn) {
    btn.disabled = false;
    btn.style.display = !searchState.done ? "inline-flex" : "none";
  }
  if (hint) hint.textContent = searchState.done ? "סוף הרשימה." : "";

  if (searchState.done) stopActiveObserver();

  searchState.loading = false;
}


/* ---------- TAG / HASHTAG PAGE ---------- */
let tagState = { key: "", cursor: null, loading: false, done: false, token: 0 };

function normalizeTagType(type){
  return type === "hashtag" ? "hashtag" : "tag";
}
function tagTypeTitle(type){
  return normalizeTagType(type) === "hashtag" ? "האשטג" : "תגית";
}
function tagDisplayValue(value, type){
  const name = normalizeTagName(value);
  return normalizeTagType(type) === "hashtag" ? `#${name}` : name;
}
function tagIndexTitle(type){
  return normalizeTagType(type) === "hashtag" ? "כל ההאשטגים" : "כל התגיות";
}
function tagIndexDescription(type){
  return normalizeTagType(type) === "hashtag"
    ? "כל ההאשטגים שנמצאו בתיאורי הסרטונים ב־Youtora."
    : "כל התגיות שנמצאו במטא־דאטה של הסרטונים ב־Youtora.";
}
function renderTagIndexItem(item, type){
  const tagType = normalizeTagType(type);
  const value = normalizeTagName(item?.value || item?.norm || "");
  if(!value) return "";

  const display = tagDisplayValue(value, tagType);
  const count = Number(item?.video_count || 0);
  const countText = count > 0 ? `${fmtCount(count)} סרטונים` : "סרטונים";
  const latest = fmtDateRel(item?.latest_published_at);

  return `
    <a class="tagIndexCard" href="${tagPageHref(value, tagType)}" data-link>
      <span class="tagIndexName">${esc(display)}</span>
      <span class="tagIndexMeta">
        ${esc(countText)}${latest ? ` · סרטון אחרון ${esc(latest)}` : ""}
      </span>
    </a>
  `;
}

let tagIndexState = { key: "", offset: 0, loading: false, done: false, token: 0 };

async function pageTagIndex(type="tag"){
  stopActiveObserver();

  const tagType = normalizeTagType(type);
  const title = tagIndexTitle(tagType);
  const canonical = tagType === "hashtag" ? "/hashtag" : "/tag";

  applyRouteMeta({
    title: `${title} | Youtora`,
    description: tagIndexDescription(tagType),
    canonical
  });

  tagIndexState = { key: tagType, offset: 0, loading: false, done: false, token: tagIndexState.token + 1 };
  const t = tagIndexState.token;

  setPage(`
    <div class="h1">${esc(title)}</div>
    <p class="sub">${esc(tagIndexDescription(tagType))}</p>

    <div class="btnRow">
      <a class="btn ${tagType === "hashtag" ? "primary" : ""}" href="/hashtag" data-link>האשטגים</a>
      <a class="btn ${tagType === "tag" ? "primary" : ""}" href="/tag" data-link>תגיות</a>
    </div>

    <div class="hr"></div>

    <div id="tagIndexGrid" class="tagIndexGrid"></div>

    <div id="tagIndexSentinel" style="height:1px"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="tagIndexMoreBtn" class="btn" type="button">טען עוד</button>
    </div>

    <div id="tagIndexHint" class="muted" style="margin-top:8px"></div>
  `);

  const btn = document.getElementById("tagIndexMoreBtn");
  const sentinel = document.getElementById("tagIndexSentinel");

  if (btn) btn.onclick = () => tagIndexLoadMore(t, tagType);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO && btn) btn.style.display = "inline-flex";

  await tagIndexLoadMore(t, tagType);

  if (hasIO && !tagIndexState.done) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => tagIndexLoadMore(t, tagType),
      enabled: true,
      rootMargin: "200px 0px",
    });
  }
}

async function tagIndexLoadMore(token, type="tag"){
  const tagType = normalizeTagType(type);

  if (tagIndexState.loading || tagIndexState.done) return;
  if (tagIndexState.key !== tagType) return;

  tagIndexState.loading = true;

  const btn = document.getElementById("tagIndexMoreBtn");
  const hint = document.getElementById("tagIndexHint");
  const grid = document.getElementById("tagIndexGrid");

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "טוען…";

  let data;
  try {
    data = await api(`/api/tags?type=${encodeURIComponent(tagType)}&limit=200&offset=${encodeURIComponent(tagIndexState.offset)}`);
  } catch (err) {
    tagIndexState.loading = false;
    if (btn) btn.disabled = false;
    if (hint) hint.textContent = `שגיאה בטעינה: ${err?.message || String(err)}`;
    return;
  }

  if (token !== tagIndexState.token) {
    tagIndexState.loading = false;
    return;
  }

  const results = data.results || data.items || [];
  const html = results.map(item => renderTagIndexItem(item, tagType)).filter(Boolean).join("");
  if (html && grid) grid.insertAdjacentHTML("beforeend", html);

  const next = data.next_offset ?? null;
  tagIndexState.offset = next !== null ? Number(next) : tagIndexState.offset + results.length;
  tagIndexState.done = next === null || results.length === 0;

  if (btn) {
    btn.disabled = false;
    btn.style.display = !tagIndexState.done ? "inline-flex" : "none";
  }

  if (hint) {
    if (!results.length && !grid?.children?.length) {
      hint.textContent = tagType === "hashtag"
        ? "עדיין לא נמצאו האשטגים. צריך להריץ רענון מטא־דאטה לסרטונים."
        : "עדיין לא נמצאו תגיות. צריך להריץ רענון מטא־דאטה לסרטונים.";
    } else {
      hint.textContent = tagIndexState.done ? "סוף הרשימה." : "";
    }
  }

  if (tagIndexState.done) stopActiveObserver();

  tagIndexState.loading = false;
}

async function pageTag(value, type="tag"){
  stopActiveObserver();

  const clean = normalizeTagName(value);
  const tagType = normalizeTagType(type);

  if(!clean){
    const emptyTitle = tagTypeTitle(tagType);
    const emptyBase = tagType === "hashtag" ? "/hashtag" : "/tag";
    applyRouteMeta({ title:`${emptyTitle} | Youtora`, description:`סרטונים לפי ${emptyTitle} ב־Youtora.`, canonical:emptyBase, robots:'noindex,follow' });
    setPage(`<div class="h1">${esc(emptyTitle)} לא נמצא</div><p class="sub"><a href="/" data-link>חזרה לבית</a></p>`);
    return;
  }

  const display = tagDisplayValue(clean, tagType);
  const canonical = tagPageHref(clean, tagType);

  applyRouteMeta({
    title: `${display} | Youtora`,
    description: `כל הסרטונים עם ${tagTypeTitle(tagType)} ${display} ב־Youtora.`,
    canonical
  });

  tagState = { key: `${tagType}|${clean}`, cursor: null, loading: false, done: false, token: tagState.token + 1 };
  const t = tagState.token;

  setPage(`
    <div class="h1">סרטונים לפי ${tagTypeTitle(tagType)}</div>
    <p class="sub"><b>${esc(display)}</b></p>

    <div class="hr"></div>

    <div id="tagGrid" class="grid"></div>

    <div id="tagSentinel" style="height:1px"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="tagMoreBtn" class="btn" type="button">טען עוד</button>
    </div>

    <div id="tagHint" class="muted" style="margin-top:8px"></div>
  `);

  const btn = document.getElementById("tagMoreBtn");
  const hint = document.getElementById("tagHint");
  const sentinel = document.getElementById("tagSentinel");

  btn.onclick = () => tagLoadMore(t, clean, tagType);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO) btn.style.display = "inline-flex";

  await tagLoadMore(t, clean, tagType);

  if (hasIO && !tagState.done) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => tagLoadMore(t, clean, tagType),
      enabled: true,
      rootMargin: "200px 0px",
    });
  }

  if (hint) hint.textContent = tagState.done ? "סוף הרשימה." : "";
}

async function tagLoadMore(token, value, type="tag"){
  const clean = normalizeTagName(value);
  const tagType = normalizeTagType(type);

  if (tagState.loading || tagState.done) return;
  if (tagState.key !== `${tagType}|${clean}`) return;

  tagState.loading = true;

  const btn = document.getElementById("tagMoreBtn");
  const hint = document.getElementById("tagHint");
  const grid = document.getElementById("tagGrid");

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "טוען…";

  const url =
    `/api/tag?type=${encodeURIComponent(tagType)}&value=${encodeURIComponent(clean)}&limit=50` +
    (tagState.cursor ? `&cursor=${encodeURIComponent(tagState.cursor)}` : "");

  let data;
  try {
    data = await api(url);
  } catch (err) {
    tagState.loading = false;
    if (btn) btn.disabled = false;
    if (hint) hint.textContent = `שגיאה בטעינה: ${err?.message || String(err)}`;
    return;
  }

  if (token !== tagState.token) {
    tagState.loading = false;
    return;
  }

  const results = data.results || data.videos || data.items || [];
  if (results.length) {
    grid.insertAdjacentHTML("beforeend", results.map(r => renderVideoCard(r)).join(""));
  }

  const next = data.next_cursor || null;

  tagState.cursor = next ? String(next) : null;
  tagState.done = !tagState.cursor || results.length === 0;

  if (btn) {
    btn.disabled = false;
    btn.style.display = !tagState.done ? "inline-flex" : "none";
  }
  if (hint) hint.textContent = tagState.done ? "סוף הרשימה." : "";

  if (tagState.done) stopActiveObserver();

  tagState.loading = false;
}



function topicLabel(topic){
  const raw = String(topic || "").trim();
  if (!raw) return "";
  const last = raw.split("/").pop() || raw;
  try {
    return decodeURIComponent(last).replace(/_/g, " ");
  } catch (_) {
    return last.replace(/_/g, " ");
  }
}

function topicDisplayLabel(topic){
  const label = topicLabel(topic);
  const map = {
    Religion: "דת",
    Society: "חברה",
    Education: "חינוך",
    Knowledge: "ידע",
    Music: "מוזיקה",
    Entertainment: "בידור",
    Lifestyle: "סגנון חיים",
    Technology: "טכנולוגיה",
    Business: "עסקים",
    Politics: "פוליטיקה",
    Sports: "ספורט",
    Health: "בריאות"
  };
  return map[label] || label;
}

function languageName(code){
  const raw = String(code || "").trim();
  if (!raw) return "";
  const base = raw.split(/[-_]/)[0].toLowerCase();
  const map = {
    iw: "עברית",
    he: "עברית",
    en: "אנגלית",
    yi: "יידיש",
    yid: "יידיש",
    ru: "רוסית",
    fr: "צרפתית",
    es: "ספרדית",
    de: "גרמנית",
    ar: "ערבית",
    it: "איטלקית",
    pt: "פורטוגזית",
    uk: "אוקראינית"
  };
  return map[base] || raw;
}

function countryName(code){
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) return "";
  const map = {
    IL: "ישראל",
    US: "ארצות הברית",
    GB: "בריטניה",
    FR: "צרפת",
    CA: "קנדה",
    AU: "אוסטרליה",
    RU: "רוסיה",
    UA: "אוקראינה",
    DE: "גרמניה",
    ES: "ספרד",
    IT: "איטליה"
  };
  return map[raw] || raw;
}

function localizationLanguageNames(localizations, primaryCode){
  const obj = localizations && typeof localizations === "object" ? localizations : {};
  const primaryBase = String(primaryCode || "").split(/[-_]/)[0].toLowerCase();
  const names = [];

  for (const key of Object.keys(obj)) {
    const base = String(key || "").split(/[-_]/)[0].toLowerCase();
    if (!base || (primaryBase && base === primaryBase)) continue;
    const name = languageName(base);
    if (name && !names.includes(name)) names.push(name);
  }

  return names;
}

function parseBrandingKeywords(text){
  const s = String(text || "").trim();
  if (!s) return [];
  const out = [];
  const re = /"([^"]+)"|'([^']+)'|(\S+)/g;
  let m;
  while ((m = re.exec(s)) && out.length < 18) {
    const value = (m[1] || m[2] || m[3] || "").trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function channelTopicHref(topic){
  const label = topicLabel(topic);
  return label ? `/channels?topic=${encodeURIComponent(label)}` : "/channels";
}

function channelKeywordHref(keyword){
  const value = String(keyword || "").trim();
  return value ? `/channels?keyword=${encodeURIComponent(value)}` : "/channels";
}

function renderChannelInfoBox(ch){
  const description = (ch.localized_description || ch.description || "").trim();
  const keywords = parseBrandingKeywords(ch.branding?.keywords || "");
  const rawTopics = Array.isArray(ch.topic_categories) ? ch.topic_categories : [];
  const topics = rawTopics.map(topicLabel).filter(Boolean);
  const primaryLangCode = ch.language_code || ch.default_language || ch.branding?.default_language || "";
  const primaryLang = languageName(primaryLangCode);
  const country = countryName(ch.country || ch.branding?.country || "");
  const allLangNames = arr(ch.languages).map(languageName).filter(Boolean);
  const extraLangs = [...new Set([...allLangNames, ...localizationLanguageNames(ch.localizations, primaryLangCode)])]
    .filter(name => name && name !== primaryLang);

  if (!description && !keywords.length && !topics.length && !primaryLang && !country && !extraLangs.length) return "";

  return `
    <details class="channelInfoDisclosure">
      <summary class="btn channelInfoToggle">
        <span class="whenClosed">מידע על הערוץ</span>
        <span class="whenOpen">הסתר מידע</span>
      </summary>

      <div class="channelInfoBox">
        ${description ? `<div class="channelDescription">${linkifyText(description)}</div>` : ``}
        ${(primaryLang || country || extraLangs.length) ? `
          <div class="channelMetaLine">
            ${primaryLang ? `<span>שפה ראשית: ${esc(primaryLang)}</span>` : ``}
            ${extraLangs.length ? `<span>שפות נוספות: ${esc(extraLangs.join(", "))}</span>` : ``}
            ${country ? `<span>מדינה: ${esc(country)}</span>` : ``}
          </div>
        ` : ``}
        ${topics.length ? `<div class="channelChipRow"><span class="channelChipLabel">קטגוריות:</span>${rawTopics.map(t => `<a class="channelChip channelChipLink" href="${channelTopicHref(t)}" title="${esc(topicLabel(t))}" data-link>${esc(topicDisplayLabel(t))}</a>`).join("")}</div>` : ``}
        ${keywords.length ? `<div class="channelChipRow"><span class="channelChipLabel">מילות מפתח:</span>${keywords.map(k => `<a class="channelChip channelChipLink" href="${channelKeywordHref(k)}" data-link>${esc(k)}</a>`).join("")}</div>` : ``}
      </div>
    </details>
  `;
}

/* ---------- CHANNEL: infinite load videos ---------- */
let channelVideosState = { key: "", cursor: null, loading: false, done: false, token: 0 };

async function pageChannel(channel_id, tab, qs=new URLSearchParams(location.search)){
  stopActiveObserver();

  const activeTab = ["videos", "playlists", "shorts", "live"].includes(tab) ? tab : "videos";
  const lang = currentLang(qs);
  const sort = normalizeChannelSort(qs.get("sort"));
  const kind = activeTab === "shorts" ? "S" : activeTab === "live" ? "L" : "V";

  setPage(`<div class="muted">טוען ערוץ…</div>`);

  const include_playlists = activeTab === "playlists" ? "1" : "0";
  const include_videos = activeTab === "playlists" ? "0" : "1";

  const data = await api(
    `/api/channel?channel_id=${encodeURIComponent(channel_id)}` +
    `&include_playlists=${include_playlists}` +
    `&include_videos=${include_videos}` +
    `&videos_limit=24` +
    `&lang=${encodeURIComponent(lang)}` +
    `&sort=${encodeURIComponent(sort)}` +
    `&kind=${encodeURIComponent(kind)}`
  );

  const ch = data.channel;
  const playlists = data.playlists || [];
  const tabLabel = channelTabLabel(activeTab);
  const bannerUrl = channelBannerDisplayUrl(ch.banner_url);
  applyRouteMeta({
    title: `${ch.title || ch.channel_id} | ${tabLabel} | Youtora`,
    description: (ch.localized_description || ch.description || `${tabLabel} של הערוץ ${ch.title || ch.channel_id} ב־Youtora.`).slice(0, 155),
    canonical: `/${encodeURIComponent(ch.channel_id)}/${activeTab}`,
    image: bannerUrl || ch.thumbnail_url || '/default-og.png',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${ch.title || ch.channel_id} - ${tabLabel}`,
      description: ch.localized_description || ch.description || `${tabLabel} של הערוץ ${ch.title || ch.channel_id} ב־Youtora.`,
      url: absoluteUrl(`/${encodeURIComponent(ch.channel_id)}/${activeTab}`)
    }
  });

  const header = `
    ${bannerUrl ? `<div class="channelBanner"><img loading="lazy" decoding="async" src="${esc(bannerUrl)}" onerror="this.closest(\'.channelBanner\').style.display=\'none\'"></div>` : ``}

    <div class="avatarRow">
      ${ch.thumbnail_url ? `<img class="avatar" style="width:64px;height:64px" loading="lazy" decoding="async" src="${esc(ch.thumbnail_url)}" onerror="this.style.display='none'">`
                         : `<div class="avatar" style="width:64px;height:64px"></div>`}
      <div style="min-width:0">
        <div class="h1" style="margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(ch.title || ch.channel_id)}</div>
        <p class="sub" style="margin-top:4px">${esc(ch.channel_id)}</p>
      </div>
    </div>

    <div class="btnRow">
      <a class="btn" target="_blank" rel="noreferrer" href="https://www.youtube.com/channel/${encodeURIComponent(ch.channel_id)}">פתח ביוטיוב</a>
    </div>

    ${renderChannelInfoBox(ch)}

    ${activeTab !== "playlists" ? renderLanguageFilter(lang, `/${encodeURIComponent(channel_id)}/${activeTab}`, sort === "latest" ? {} : { sort }) : ``}
    ${activeTab !== "playlists" ? renderChannelSortFilter(sort, `/${encodeURIComponent(channel_id)}/${activeTab}`, lang) : ``}

    <div class="tabs">
      <a class="tab ${activeTab==="videos"?"active":""}" href="${langUrl(`/${encodeURIComponent(channel_id)}/videos`, lang, sort === "latest" ? {} : { sort })}" data-link>סרטונים</a>
      <a class="tab ${activeTab==="shorts"?"active":""}" href="${langUrl(`/${encodeURIComponent(channel_id)}/shorts`, lang, sort === "latest" ? {} : { sort })}" data-link>שורטים</a>
      <a class="tab ${activeTab==="live"?"active":""}" href="${langUrl(`/${encodeURIComponent(channel_id)}/live`, lang, sort === "latest" ? {} : { sort })}" data-link>שידורים חיים</a>
      <a class="tab ${activeTab==="playlists"?"active":""}" href="/${encodeURIComponent(channel_id)}/playlists" data-link>פלייליסטים</a>
    </div>
  `;

  if (activeTab === "playlists") {
    setPage(`
      ${header}
      <div class="hr"></div>
      ${playlists.length ? `
        <div class="playlistGrid">
          ${playlists.map(renderPlaylistCard).join("")}
        </div>
      ` : `<div class="muted">אין פלייליסטים (או עדיין לא נטענו).</div>`}
    `);
    return;
  }

  channelVideosState = {
    key: `${channel_id}|${kind}|${lang}|${sort}`,
    cursor: data.videos_next_cursor || null,
    loading: false,
    done: !data.videos_next_cursor,
    token: channelVideosState.token + 1
  };
  const t = channelVideosState.token;

  setPage(`
    ${header}
    <div class="hr"></div>

    <div id="chGrid" class="${kind === "S" ? "shortsGrid" : "grid"}">
      ${(data.videos || []).map(v => (kind === "S" ? renderShortCard : renderVideoCard)({
        ...v,
        channel_id: ch.channel_id,
        channel_title: ch.title,
        channel_thumbnail_url: ch.thumbnail_url
      })).join("")}
    </div>

    <div id="chSentinel" style="height:1px"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="chMoreBtn" class="btn" type="button" style="display:none">טען עוד</button>
    </div>

    <div id="chHint" class="muted" style="margin-top:8px"></div>
  `);

  const btn = document.getElementById("chMoreBtn");
  const hint = document.getElementById("chHint");
  const sentinel = document.getElementById("chSentinel");

  btn.onclick = () => channelLoadMoreVideos(t, ch.channel_id, ch.title, ch.thumbnail_url, kind, lang, sort);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO && !channelVideosState.done) btn.style.display = "inline-flex";
  if (hint) hint.textContent = channelVideosState.done ? "סוף הרשימה." : "";

  if (hasIO && !channelVideosState.done) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => channelLoadMoreVideos(t, ch.channel_id, ch.title, ch.thumbnail_url, kind, lang, sort),
      enabled: true,
      rootMargin: "200px 0px",
    });
  }
}

async function channelLoadMoreVideos(token, channel_id, channel_title, channel_thumbnail_url, kind="", lang="he", sort="latest"){
  sort = normalizeChannelSort(sort);
  if (channelVideosState.loading || channelVideosState.done) return;
  if (channelVideosState.key !== `${channel_id}|${kind}|${lang}|${sort}`) return;

  channelVideosState.loading = true;

  const btn = document.getElementById("chMoreBtn");
  const hint = document.getElementById("chHint");
  const grid = document.getElementById("chGrid");

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "טוען…";

  const url =
    `/api/channel?channel_id=${encodeURIComponent(channel_id)}` +
    `&include_channel=0&include_playlists=0&include_videos=1` +
    `&videos_limit=24` +
    `&lang=${encodeURIComponent(lang)}` +
    `&sort=${encodeURIComponent(sort)}` +
    `&kind=${encodeURIComponent(kind || "V")}` +
    (channelVideosState.cursor ? `&videos_cursor=${encodeURIComponent(channelVideosState.cursor)}` : "");

  const data = await api(url);

  if (token !== channelVideosState.token) return;

  const vids = data.videos || [];
  if (vids.length) {
    const renderer = kind === "S" ? renderShortCard : renderVideoCard;
    const html = vids.map(v => renderer({
      ...v,
      channel_id,
      channel_title,
      channel_thumbnail_url
    })).join("");
    grid.insertAdjacentHTML("beforeend", html);
  }

  channelVideosState.cursor = data.videos_next_cursor || null;
  channelVideosState.done = !channelVideosState.cursor || vids.length === 0;

  if (btn) {
    btn.disabled = false;
    btn.style.display = (typeof IntersectionObserver === "undefined" && !channelVideosState.done) ? "inline-flex" : "none";
  }
  if (hint) hint.textContent = channelVideosState.done ? "סוף הרשימה." : "";

  if (channelVideosState.done) stopActiveObserver();

  channelVideosState.loading = false;
}

/* ---------- VIDEO PAGE ---------- */
const WATCH_SIDE_TABS = [
  { key: "discover", label: "לגלות עוד" },
  { key: "more", label: "עוד מהערוץ" },
  { key: "popular", label: "פופולאריים" },
  { key: "playlists", label: "פלייליסטים" }
];

let watchSideState = { videoId: "", tab: "discover", loading: false, loaded: {} };

function normalizeWatchSideTab(tab){
  const key = String(tab || "discover").trim().toLowerCase();
  return WATCH_SIDE_TABS.some(t => t.key === key) ? key : "discover";
}

function renderRecoCard(r){
  return `
    <article class="recoCard">
      <a class="recoThumbLink" href="/${encodeURIComponent(r.video_id)}" data-link>
        <span class="recoThumbWrap">
          <img class="recoThumb" loading="lazy" decoding="async" src="${esc(ytVideoThumb(r.video_id))}">
          ${fmtDuration(r.duration_sec) ? `<span class="thumbBadge thumbBadgeSm">${esc(fmtDuration(r.duration_sec))}</span>` : ``}
        </span>
      </a>

      <div class="recoBody">
        <a class="recoTitleLink" href="/${encodeURIComponent(r.video_id)}" data-link>
          <span class="recoTitle">${esc(r.title || r.video_id)}</span>
        </a>

        <span class="recoMetaBlock">
          ${r.channel_id
            ? `<a class="recoAvatarLink" href="/${encodeURIComponent(r.channel_id)}/videos" data-link>`
            : `<span class="recoAvatarLink">`
          }
            ${r.channel_thumbnail_url
              ? `<img class="recoAvatar" loading="lazy" decoding="async" src="${esc(r.channel_thumbnail_url)}" onerror="this.style.display='none'">`
              : `<span class="recoAvatar recoAvatarFallback"></span>`
            }
          ${r.channel_id ? `</a>` : `</span>`}

          <span class="recoMetaText">
            <span class="recoDate">${esc([fmtDateRel(r.published_at), fmtViews(r.view_count)].filter(Boolean).join(" · "))}</span>
            ${r.channel_id
              ? `<a class="recoChannel" href="/${encodeURIComponent(r.channel_id)}/videos" data-link>${esc(r.channel_title || r.channel_id || "")}</a>`
              : `<span class="recoChannel">${esc(r.channel_title || r.channel_id || "")}</span>`
            }
          </span>
        </span>
      </div>
    </article>
  `;
}

function renderRecoPlaylistCard(p){
  const count = Number(p.item_count);
  const countText = Number.isFinite(count) && count > 0 ? `${count} סרטונים` : "פלייליסט";
  const thumb = p.thumb_video_id ? ytVideoThumb(p.thumb_video_id) : "";

  return `
    <article class="recoCard recoPlaylistCard">
      <a class="recoThumbLink" href="/${encodeURIComponent(p.playlist_id)}" data-link>
        <span class="recoThumbWrap recoPlaylistThumbWrap">
          ${thumb
            ? `<img class="recoThumb" loading="lazy" decoding="async" src="${esc(thumb)}" onerror="this.style.display='none'">`
            : `<span class="recoThumb recoPlaylistEmptyThumb"></span>`
          }
          <span class="playlistTypeBadge">פלייליסט</span>
        </span>
      </a>

      <div class="recoBody">
        <a class="recoTitleLink" href="/${encodeURIComponent(p.playlist_id)}" data-link>
          <span class="recoTitle">${esc(p.title || p.playlist_id)}</span>
        </a>
        <span class="recoMetaText">
          <span class="recoDate">${esc(countText)}</span>
          <span class="recoChannel">${esc(p.channel_title || p.channel_id || "")}</span>
        </span>
      </div>
    </article>
  `;
}

function renderWatchSideShell(){
  return `
    <div class="watchSideTitle">סרטונים נוספים</div>
    <div class="watchSideTabs" role="tablist" aria-label="אפשרויות צד הסרטון">
      ${WATCH_SIDE_TABS.map(t => `
        <button class="watchSideTab ${t.key === "discover" ? "active" : ""}"
                type="button"
                data-watch-side-tab="${esc(t.key)}"
                role="tab"
                aria-selected="${t.key === "discover" ? "true" : "false"}">
          ${esc(t.label)}
        </button>
      `).join("")}
    </div>
    <div id="watchSideContent" class="watchSideContent">
      <div class="muted watchSideHint">טוען…</div>
    </div>
  `;
}

function setWatchSideActiveTab(tab){
  const active = normalizeWatchSideTab(tab);
  document.querySelectorAll("[data-watch-side-tab]").forEach(btn => {
    const isActive = btn.getAttribute("data-watch-side-tab") === active;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
}

function renderWatchSideContent(tab, data){
  const box = document.getElementById("watchSideContent");
  if (!box) return;

  if (tab === "playlists") {
    const playlists = data.playlists || [];
    box.innerHTML = playlists.length
      ? `<div class="recoList">${playlists.map(renderRecoPlaylistCard).join("")}</div>`
      : `<div class="muted watchSideHint">אין כרגע פלייליסטים לערוץ הזה.</div>`;
    return;
  }

  const videos = data.videos || [];
  box.innerHTML = videos.length
    ? `<div class="recoList">${videos.map(renderRecoCard).join("")}</div>`
    : `<div class="muted watchSideHint">אין כרגע תוצאות להצגה.</div>`;
}

async function loadWatchSideTab(videoId, tab="more"){
  const cleanVideoId = String(videoId || "").trim();
  const activeTab = normalizeWatchSideTab(tab);
  if (!cleanVideoId) return;
  if (watchSideState.videoId !== cleanVideoId) return;

  watchSideState.tab = activeTab;
  setWatchSideActiveTab(activeTab);

  if (watchSideState.loaded[activeTab]) {
    renderWatchSideContent(activeTab, watchSideState.loaded[activeTab]);
    return;
  }

  const box = document.getElementById("watchSideContent");
  if (box) box.innerHTML = `<div class="muted watchSideHint">טוען…</div>`;

  let data;
  try {
    data = await api(`/api/video-sidebar?video_id=${encodeURIComponent(cleanVideoId)}&tab=${encodeURIComponent(activeTab)}&limit=10`);
  } catch (err) {
    if (watchSideState.videoId !== cleanVideoId) return;
    if (box) box.innerHTML = `<div class="muted watchSideHint">שגיאה בטעינה: ${esc(err?.message || String(err))}</div>`;
    return;
  }

  if (watchSideState.videoId !== cleanVideoId || watchSideState.tab !== activeTab) return;

  watchSideState.loaded[activeTab] = data;
  renderWatchSideContent(activeTab, data);
}

function hookWatchSideTabs(videoId){
  document.querySelectorAll("[data-watch-side-tab]").forEach(btn => {
    btn.onclick = () => loadWatchSideTab(videoId, btn.getAttribute("data-watch-side-tab") || "more");
  });
}

async function pageVideo(video_id){
  stopActiveObserver();

  setPage(`<div class="muted">טוען סרטון…</div>`);
  const data = await api(`/api/video?video_id=${encodeURIComponent(video_id)}`);
  const v = data.video;
  const cleanDescription = String(v.description || "").trim();
  const seoDescription = cleanDescription
    ? cleanDescription.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 165)
    : ((v.channel_title || v.channel_id) ? `${v.title || v.video_id} · ${v.channel_title || v.channel_id} · צפייה בסרטון ב־Youtora` : `${v.title || v.video_id} · צפייה בסרטון ב־Youtora`);
  applyRouteMeta({
    title: `${v.title || v.video_id} | Youtora`,
    description: seoDescription,
    canonical: `/${encodeURIComponent(v.video_id)}`,
    type: 'video.other',
    image: ytVideoThumb(v.video_id, 'hqdefault'),
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'VideoObject',
      name: v.title || v.video_id,
      url: absoluteUrl(`/${encodeURIComponent(v.video_id)}`),
      embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(v.video_id)}`,
      thumbnailUrl: [ytVideoThumb(v.video_id, 'hqdefault')],
      ...(fmtDate(v.published_at) ? { uploadDate: new Date(Number(v.published_at) * 1000).toISOString() } : {}),
      ...(secondsToIsoDuration(v.duration_sec) ? { duration: secondsToIsoDuration(v.duration_sec) } : {}),
      ...(cleanDescription ? { description: cleanDescription } : {}),
      ...((arr(v.tags).length || arr(v.hashtags).length) ? { keywords: [...new Set([...arr(v.tags), ...arr(v.hashtags)])].join(', ') } : {}),
      ...(Number(v.view_count) >= MIN_VISIBLE_VIEWS ? {
        interactionStatistic: {
          '@type': 'InteractionCounter',
          interactionType: { '@type': 'WatchAction' },
          userInteractionCount: Number(v.view_count)
        }
      } : {}),
      ...((v.channel_title || v.channel_id) ? { publisher: { '@type':'Organization', name: v.channel_title || v.channel_id } } : {})
    }
  });

  const player = `
    <iframe class="player"
      src="https://www.youtube.com/embed/${encodeURIComponent(v.video_id)}?rel=0"
      title="YouTube video player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen></iframe>
  `;

  watchSideState = { videoId: v.video_id, tab: "discover", loading: false, loaded: {} };

  setPage(`
    <div class="watchLayout">
      <section class="watchMain">
        ${player}
        <div class="h1" style="margin-top:10px">${linkifyText(v.title || v.video_id)}</div>
        <p class="sub">${[
          fmtDateRel(v.published_at) ? `פורסם: ${esc(fmtDateRel(v.published_at))}` : "",
          fmtDuration(v.duration_sec) ? `משך: ${esc(fmtDuration(v.duration_sec))}` : "",
          fmtViews(v.view_count),
          fmtLikes(v.like_count)
        ].filter(Boolean).join(" · ")}</p>

        <div class="avatarRow watchChannelRow">
          ${v.thumbnail_url ? `<img class="avatar" loading="lazy" decoding="async" src="${esc(v.thumbnail_url)}" onerror="this.style.display='none'">`
                            : `<div class="avatar"></div>`}
          <div style="min-width:0">
            <div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${v.channel_id
                ? `<a href="/${encodeURIComponent(v.channel_id)}/videos" data-link>${esc(v.channel_title || v.channel_id)}</a>`
                : esc(v.channel_title || "ערוץ")
              }
            </div>
            <div class="muted" style="font-size:12px">ערוץ</div>
          </div>

          <div style="margin-inline-start:auto" class="btnRow">
            <a class="btn" target="_blank" rel="noreferrer" href="https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}">פתח ביוטיוב</a>
          </div>
        </div>

        ${arr(v.tags).length ? `
          <div class="tagRow">
            ${arr(v.tags).slice(0, 40).map(renderTagChip).join("")}
          </div>
        ` : ``}

        ${cleanDescription ? `<div class="videoDescription">${linkifyText(cleanDescription)}</div>` : ``}

        <div class="hr"></div>
      </section>

      <aside class="watchSide">
        ${renderWatchSideShell()}
      </aside>
    </div>
  `);

  watchSideState.loaded.discover = { tab: "discover", videos: data.recommended || [] };
  hookWatchSideTabs(v.video_id);
  renderWatchSideContent("discover", watchSideState.loaded.discover);
}

/* ---------- PLAYLIST PAGE ---------- */
function isChannelId(s){ return /^UC[a-zA-Z0-9_-]{20,}$/.test(s); }
function isPlaylistId(s){ return /^PL[a-zA-Z0-9_-]{10,}$/.test(s); }
function isVideoId(s){ return /^[a-zA-Z0-9_-]{11}$/.test(s); }

async function pagePlaylist(playlist_id){
  stopActiveObserver();

  setPage(`<div class="muted">טוען פלייליסט…</div>`);
  const data = await api(`/api/playlist?playlist_id=${encodeURIComponent(playlist_id)}`);
  const p = data.playlist;
  applyRouteMeta({
    title: `${p.title || p.playlist_id} | פלייליסט | Youtora`,
    description: (p.channel_title || p.channel_id) ? `${p.title || p.playlist_id} · פלייליסט מערוץ ${p.channel_title || p.channel_id}` : `${p.title || p.playlist_id} · פלייליסט לצפייה ב־Youtora`,
    canonical: `/${encodeURIComponent(p.playlist_id)}`,
    image: p.thumb_video_id ? ytVideoThumb(p.thumb_video_id, 'hqdefault') : '/default-og.png',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: p.title || p.playlist_id,
      description: (p.channel_title || p.channel_id) ? `${p.title || p.playlist_id} · פלייליסט מערוץ ${p.channel_title || p.channel_id}` : `${p.title || p.playlist_id} · פלייליסט לצפייה ב־Youtora`,
      url: absoluteUrl(`/${encodeURIComponent(p.playlist_id)}`)
    }
  });

  const player = `
    <iframe class="player"
      src="https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(p.playlist_id)}&rel=0"
      title="YouTube playlist player"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen></iframe>
  `;

  setPage(`
    <div class="h1">${esc(p.title || p.playlist_id)}</div>
    <p class="sub">${esc(p.playlist_id)}</p>

    <div class="btnRow">
      <a class="btn" target="_blank" rel="noreferrer" href="https://www.youtube.com/playlist?list=${encodeURIComponent(p.playlist_id)}">פתח ביוטיוב</a>
      <a class="btn" href="/${encodeURIComponent(p.channel_id)}/playlists" data-link>עוד פלייליסטים בערוץ</a>
    </div>

    <div class="hr"></div>

    ${player}
  `);
}

/* ---------- ROUTER ---------- */
async function render(){
  const { parts, qs } = route();
  setActiveNav();

  if(parts.length === 0) return pageHome(qs);
  if(parts[0] === "shorts") return pageShorts(qs);
  if(parts[0] === "live") return pageLive(qs);
  if(parts[0] === "channels") return pageChannels(qs);
  if(parts[0] === "playlists") return pagePlaylists();
  if(parts[0] === "search") return pageSearch((qs.get("q")||"").trim(), (qs.get("scope")||"title").trim());
  if(parts[0] === "hashtag") {
    if(parts.length === 1) return pageTagIndex("hashtag");
    return pageTag(decodeURIComponent(parts[1] || ""), "hashtag");
  }
  if(parts[0] === "tag") {
    if(parts.length === 1) return pageTagIndex((qs.get("type")||"tag").trim());
    return pageTag(decodeURIComponent(parts[1] || ""), (qs.get("type")||"tag").trim());
  }

  // /UC.../videos /shorts /live /playlists
  if(parts.length >= 1 && isChannelId(parts[0])){
    const tab = parts[1] || "videos";
    return pageChannel(parts[0], ["videos", "shorts", "live", "playlists"].includes(tab) ? tab : "videos", qs);
  }

  // /PL...
  if(parts.length === 1 && isPlaylistId(parts[0])){
    return pagePlaylist(parts[0]);
  }

  // /VIDEOID
  if(parts.length === 1 && isVideoId(parts[0])){
    return pageVideo(parts[0]);
  }

  applyRouteMeta({ title:'לא נמצא | Youtora', description:'הדף לא נמצא.', canonical:location.pathname, robots:'noindex,follow' });
  setPage(`<div class="h1">לא נמצא</div><p class="sub"><a href="/" data-link>חזרה לבית</a></p>`);
}

/* init */
hookLinks();
headerSearch();
render().catch(showErr);
