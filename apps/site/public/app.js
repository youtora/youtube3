const $ = (id) => document.getElementById(id);

function esc(s){return (s||"").replace(/[&<>"']/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]))}
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


function renderShortCard(v){
  const thumb = ytShortThumb(v.video_id);
  const relDate = fmtDateRel(v.published_at);
  const duration = fmtDuration(v.duration_sec);
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
            <div class="videoMetaDate">${esc(relDate)}</div>
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
            <div class="videoMetaDate">${esc(relDate)}</div>
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
let latestState = { kind: "", cursor: null, loading: false, done: false, token: 0 };

function latestPageMeta(kind){
  if(kind === "S") return { title: "שורטים", sub: "השורטים האחרונים מכל הערוצים" };
  if(kind === "L") return { title: "שידורים חיים", sub: "השידורים החיים האחרונים מכל הערוצים" };
  return { title: "בית", sub: "הסרטונים האחרונים מכל הערוצים" };
}

async function pageLatest(kind=""){
  latestState = { kind, cursor: null, loading: false, done: false, token: latestState.token + 1 };
  const t = latestState.token;
  const meta = latestPageMeta(kind);
  applyRouteMeta(latestSeo(kind));

  setPage(`
    <div class="h1">${esc(meta.title)}</div>
    <p class="sub">${esc(meta.sub)}</p>
    <div class="hr"></div>

    <div id="latestGrid" class="${kind === "S" ? "shortsGrid" : "grid"}"></div>

    <div id="latestSentinel" style="height:1px"></div>

    <div class="btnRow" style="margin-top:14px">
      <button id="latestMoreBtn" class="btn" type="button" style="display:none">טען עוד</button>
    </div>

    <div id="latestHint" class="muted" style="margin-top:8px"></div>
  `);

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
    (latestState.kind ? `&kind=${encodeURIComponent(latestState.kind)}` : "") +
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

async function pageHome(){
  return pageLatest("");
}

async function pageShorts(){
  return pageLatest("S");
}

async function pageLive(){
  return pageLatest("L");
}

/* ---------- PAGES: channels list ---------- */
function renderChannelCard(ch){
  return `
    <a class="channelCard" href="/${encodeURIComponent(ch.channel_id)}/videos" data-link>
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

async function pageChannels(){
  stopActiveObserver();
  applyRouteMeta({ title:'Youtora | ערוצים', description:'רשימת כל הערוצים הזמינים ב־Youtora.', canonical:'/channels' });

  setPage(`<div class="muted">טוען ערוצים…</div>`);
  const data = await api(`/api/channels`);
  const channels = data.channels || [];

  setPage(`
    <div class="h1">ערוצים</div>
    <p class="sub">כל הערוצים במערכת</p>
    <div class="hr"></div>

    ${channels.length ? `
      <div class="channelsGrid">
        ${channels.map(renderChannelCard).join("")}
      </div>
    ` : `<div class="muted">אין ערוצים עדיין.</div>`}
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
          <img class="thumb16x9 playlistThumb" loading="lazy" decoding="async"
               src="${esc(thumb)}"
               onerror="this.style.display='none'">
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

async function pageSearch(q){
  stopActiveObserver();

  if(!q){
    applyRouteMeta({ title:'חיפוש | Youtora', description:'חיפוש ב־Youtora.', canonical:'/search', robots:'noindex,follow' });
    setPage(`<div class="h1">חיפוש</div><p class="sub">הקלד מילה בחיפוש למעלה.</p>`);
    return;
  }

  applyRouteMeta({ title:`חיפוש: ${q} | Youtora`, description:`תוצאות חיפוש עבור ${q} ב־Youtora.`, canonical:`/search?q=${encodeURIComponent(q)}`, robots:'noindex,follow' });

  const si = $("searchInput");
  if (si) si.value = q;

  searchState = { key: q, cursor: null, loading: false, done: false, token: searchState.token + 1 };
  const t = searchState.token;

  setPage(`
    <div class="h1">תוצאות חיפוש</div>
    <p class="sub">מילת חיפוש: <b>${esc(q)}</b></p>
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

  btn.onclick = () => searchLoadMore(t, q);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO) btn.style.display = "inline-flex";

  // טעינה ראשונה
  await searchLoadMore(t, q);

  // אינסוף־סקрол
  if (hasIO && !searchState.done) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => searchLoadMore(t, q),
      enabled: true,
      rootMargin: "200px 0px",
    });
  }

  if (hint) hint.textContent = searchState.done ? "סוף הרשימה." : "";
}

async function searchLoadMore(token, q){
  if (searchState.loading || searchState.done) return;
  if (searchState.key !== q) return;

  searchState.loading = true;

  const btn = document.getElementById("searchMoreBtn");
  const hint = document.getElementById("searchHint");
  const grid = document.getElementById("searchGrid");

  if (btn) btn.disabled = true;
  if (hint) hint.textContent = "טוען…";

  const url =
    `/api/search?q=${encodeURIComponent(q)}&limit=50` +
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

  // cursor: קודם next_cursor, ואם לא קיים – מהפריט האחרון (cursor)
  const last = results[results.length - 1];
  const next =
    data.next_cursor ||
    data.videos_next_cursor ||
    data.nextCursor ||
    data.cursor ||
    last?.cursor ||
    last?.rowid ||
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


/* ---------- CHANNEL: infinite load videos ---------- */
let channelVideosState = { key: "", cursor: null, loading: false, done: false, token: 0 };

async function pageChannel(channel_id, tab){
  stopActiveObserver();

  const activeTab = ["videos", "playlists", "shorts", "live"].includes(tab) ? tab : "videos";
  const kind = activeTab === "shorts" ? "S" : activeTab === "live" ? "L" : "";

  setPage(`<div class="muted">טוען ערוץ…</div>`);

  const include_playlists = activeTab === "playlists" ? "1" : "0";
  const data = await api(
    `/api/channel?channel_id=${encodeURIComponent(channel_id)}` +
    `&include_playlists=${include_playlists}` +
    `&videos_limit=24` +
    (kind ? `&kind=${encodeURIComponent(kind)}` : "")
  );

  const ch = data.channel;
  const playlists = data.playlists || [];
  const tabLabel = channelTabLabel(activeTab);
  applyRouteMeta({
    title: `${ch.title || ch.channel_id} | ${tabLabel} | Youtora`,
    description: `${tabLabel} של הערוץ ${ch.title || ch.channel_id} ב־Youtora.`,
    canonical: `/${encodeURIComponent(ch.channel_id)}/${activeTab}`,
    image: ch.thumbnail_url || '/default-og.png',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: `${ch.title || ch.channel_id} - ${tabLabel}`,
      description: `${tabLabel} של הערוץ ${ch.title || ch.channel_id} ב־Youtora.`,
      url: absoluteUrl(`/${encodeURIComponent(ch.channel_id)}/${activeTab}`)
    }
  });

  const header = `
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

    <div class="tabs">
      <a class="tab ${activeTab==="videos"?"active":""}" href="/${encodeURIComponent(channel_id)}/videos" data-link>סרטונים</a>
      <a class="tab ${activeTab==="shorts"?"active":""}" href="/${encodeURIComponent(channel_id)}/shorts" data-link>שורטים</a>
      <a class="tab ${activeTab==="live"?"active":""}" href="/${encodeURIComponent(channel_id)}/live" data-link>שידורים חיים</a>
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
    key: `${channel_id}|${kind}`,
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

  btn.onclick = () => channelLoadMoreVideos(t, ch.channel_id, ch.title, ch.thumbnail_url, kind);

  const hasIO = typeof IntersectionObserver !== "undefined";
  if (!hasIO && !channelVideosState.done) btn.style.display = "inline-flex";
  if (hint) hint.textContent = channelVideosState.done ? "סוף הרשימה." : "";

  if (hasIO && !channelVideosState.done) {
    startInfiniteScroll({
      sentinelEl: sentinel,
      onNearEnd: () => channelLoadMoreVideos(t, ch.channel_id, ch.title, ch.thumbnail_url, kind),
      enabled: true,
      rootMargin: "200px 0px",
    });
  }
}

async function channelLoadMoreVideos(token, channel_id, channel_title, channel_thumbnail_url, kind=""){
  if (channelVideosState.loading || channelVideosState.done) return;
  if (channelVideosState.key !== `${channel_id}|${kind}`) return;

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
    (kind ? `&kind=${encodeURIComponent(kind)}` : "") +
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
async function pageVideo(video_id){
  stopActiveObserver();

  setPage(`<div class="muted">טוען סרטון…</div>`);
  const data = await api(`/api/video?video_id=${encodeURIComponent(video_id)}`);
  const v = data.video;
  const rec = data.recommended || [];
  applyRouteMeta({
    title: `${v.title || v.video_id} | Youtora`,
    description: (v.channel_title || v.channel_id) ? `${v.title || v.video_id} · ${v.channel_title || v.channel_id} · צפייה בסרטון ב־Youtora` : `${v.title || v.video_id} · צפייה בסרטון ב־Youtora`,
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

  setPage(`
    <div class="watchLayout">
      <section class="watchMain">
        ${player}
        <div class="h1" style="margin-top:10px">${esc(v.title || v.video_id)}</div>
        <p class="sub">${[fmtDateRel(v.published_at) ? `פורסם: ${esc(fmtDateRel(v.published_at))}` : "", fmtDuration(v.duration_sec) ? `משך: ${esc(fmtDuration(v.duration_sec))}` : ""].filter(Boolean).join(" · ")}</p>

        <div class="hr"></div>

        <div class="avatarRow">
          ${v.thumbnail_url ? `<img class="avatar" loading="lazy" decoding="async" src="${esc(v.thumbnail_url)}" onerror="this.style.display='none'">`
                            : `<div class="avatar"></div>`}
          <div style="min-width:0">
            <div style="font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              <a href="/${encodeURIComponent(v.channel_id)}/videos" data-link>${esc(v.channel_title || v.channel_id)}</a>
            </div>
            <div class="muted" style="font-size:12px">ערוץ</div>
          </div>

          <div style="margin-inline-start:auto" class="btnRow">
            <a class="btn" target="_blank" rel="noreferrer" href="https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}">פתח ביוטיוב</a>
          </div>
        </div>
      </section>

      <aside class="watchSide">
        <div class="watchSideTitle">סרטונים מוצעים</div>
        ${rec.length ? `<div class="recoList">${rec.map(r=>`
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
                  <span class="recoDate">${esc(fmtDateRel(r.published_at) || "")}</span>
                  ${r.channel_id
                    ? `<a class="recoChannel" href="/${encodeURIComponent(r.channel_id)}/videos" data-link>${esc(r.channel_title || r.channel_id || "")}</a>`
                    : `<span class="recoChannel">${esc(r.channel_title || r.channel_id || "")}</span>`
                  }
                </span>
              </span>
            </div>
          </article>
        `).join("")}</div>` : `<div class="muted">אין כרגע המלצות מהמסד.</div>`}
      </aside>
    </div>
  `);
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

  if(parts.length === 0) return pageHome();
  if(parts[0] === "shorts") return pageShorts();
  if(parts[0] === "live") return pageLive();
  if(parts[0] === "channels") return pageChannels();
  if(parts[0] === "playlists") return pagePlaylists();
  if(parts[0] === "search") return pageSearch((qs.get("q")||"").trim());

  // /UC.../videos /shorts /live /playlists
  if(parts.length >= 1 && isChannelId(parts[0])){
    const tab = parts[1] || "videos";
    return pageChannel(parts[0], ["videos", "shorts", "live", "playlists"].includes(tab) ? tab : "videos");
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
