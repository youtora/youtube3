function html(content) {
  return new Response(content, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export async function onRequest() {
  return html(`<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ריענון מטא־דאטה | Youtora Admin</title>
  <style>
    :root{color-scheme:light;background:#f6f7fb;color:#111827}
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif;margin:0;background:#f6f7fb;color:#111827}
    .wrap{max-width:1100px;margin:24px auto;padding:0 14px 48px}
    h1{font-size:28px;margin:0 0 6px}
    .sub{color:#64748b;margin:0 0 20px;line-height:1.6}
    .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:16px;box-shadow:0 8px 22px rgba(15,23,42,.06)}
    .span4{grid-column:span 4}.span8{grid-column:span 8}.span12{grid-column:span 12}
    label{display:block;font-weight:650;margin:0 0 7px}
    input,select,button{font:inherit}
    input,select{width:100%;padding:11px 12px;border:1px solid #d1d5db;border-radius:12px;background:#fff}
    .row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:10px 0}
    .check{display:flex;align-items:center;gap:8px;margin:10px 0;color:#334155}
    .check input{width:auto}
    button{border:0;border-radius:13px;padding:11px 16px;cursor:pointer;font-weight:700;background:#111827;color:white}
    button.secondary{background:#e5e7eb;color:#111827}
    button.danger{background:#b91c1c;color:#fff}
    button:disabled{opacity:.55;cursor:not-allowed}
    .buttons{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
    .statgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
    .stat{background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:12px}
    .stat .num{font-size:24px;font-weight:800;margin-top:4px}.stat .name{color:#64748b;font-size:13px}
    pre{direction:ltr;text-align:left;white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;padding:14px;border-radius:14px;max-height:360px;overflow:auto}
    table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden}
    th,td{padding:9px;border-bottom:1px solid #eef2f7;text-align:right;font-size:14px;vertical-align:top}
    th{background:#f8fafc;color:#334155;font-weight:800}
    .ok{color:#15803d;font-weight:800}.bad{color:#b91c1c;font-weight:800}.muted{color:#64748b}
    .pill{display:inline-flex;align-items:center;border-radius:999px;background:#eef2ff;color:#3730a3;padding:3px 8px;font-size:12px;font-weight:700}
    .progress{height:12px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-top:10px}
    .bar{height:100%;width:0;background:#111827;transition:width .25s ease}
    a{color:#2563eb;text-decoration:none}
    @media(max-width:800px){.span4,.span8{grid-column:span 12}.row{grid-template-columns:1fr}.statgrid{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
  <main class="wrap">
    <h1>ריענון מטא־דאטה לסרטונים</h1>
    <p class="sub">הדף הזה מריץ את <code>/k9p1/refresh-video-meta</code> בלי לפתוח Console. הוא מוגן באותה הרשאת Admin של <code>/k9p1</code>.</p>

    <div class="grid">
      <section class="card span4">
        <h2 style="margin-top:0">הגדרות הרצה</h2>

        <div class="row" style="grid-template-columns:1fr 1fr">
          <div>
            <label for="limit">כמה סרטונים בכל סיבוב</label>
            <input id="limit" type="number" min="1" max="200" value="20" />
          </div>
          <div>
            <label for="rounds">כמה סיבובים</label>
            <input id="rounds" type="number" min="1" max="500" value="1" />
          </div>
        </div>

        <div class="row" style="grid-template-columns:1fr 1fr">
          <div>
            <label for="maxAge">גיל מקסימלי בשעות</label>
            <input id="maxAge" type="number" min="1" value="999999" />
          </div>
          <div>
            <label for="delay">המתנה בין סיבובים</label>
            <select id="delay">
              <option value="500">חצי שנייה</option>
              <option value="1000" selected>שנייה</option>
              <option value="2000">2 שניות</option>
              <option value="5000">5 שניות</option>
            </select>
          </div>
        </div>

        <label class="check">
          <input id="includeFresh" type="checkbox" />
          כולל גם סרטונים שכבר יש להם נתונים
        </label>

        <div class="buttons">
          <button id="runOne" onclick="runOnce()">רענן פעם אחת</button>
          <button id="runMany" onclick="runMany()">הרץ סיבובים</button>
          <button id="stopBtn" class="danger" onclick="stopRun()" disabled>עצור</button>
          <button class="secondary" onclick="loadStatus()">בדוק מצב</button>
        </div>

        <div class="progress"><div id="bar" class="bar"></div></div>
        <p id="progressText" class="muted">מוכן.</p>
      </section>

      <section class="card span8">
        <h2 style="margin-top:0">מצב המסד</h2>
        <div id="stats" class="statgrid"></div>
        <p class="muted" style="margin-bottom:0">בדיקה מהירה: אם <b>with_details</b> עולה, הריענון ממלא את <code>video_details</code>. אם <b>video_details_fts</b> עולה, החיפוש בתיאורים/תגיות מתמלא.</p>
      </section>

      <section class="card span12">
        <h2 style="margin-top:0">תוצאות הרצה</h2>
        <pre id="out">מוכן.</pre>
      </section>

      <section class="card span12">
        <h2 style="margin-top:0">20 הסרטונים האחרונים</h2>
        <div id="latest"></div>
      </section>
    </div>
  </main>

<script>
  let stopped = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  function log(value){
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    $("out").textContent = text;
  }

  function appendLog(value){
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    $("out").textContent += "\n" + text;
    $("out").scrollTop = $("out").scrollHeight;
  }

  function sleep(ms){ return new Promise((resolve) => setTimeout(resolve, ms)); }

  function getSettings(){
    return {
      limit: Math.max(1, Math.min(200, parseInt($("limit").value || "20", 10))),
      max_age_hours: Math.max(1, parseInt($("maxAge").value || "999999", 10)),
      include_fresh: $("includeFresh").checked === true
    };
  }

  async function readResponse(res){
    const text = await res.text();
    try { return { status: res.status, ok: res.ok, data: JSON.parse(text) }; }
    catch { return { status: res.status, ok: res.ok, data: text.slice(0, 4000) }; }
  }

  async function refreshOnce(){
    const res = await fetch("/k9p1/refresh-video-meta?x=" + Date.now(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(getSettings())
    });
    return readResponse(res);
  }

  function setBusy(isBusy){
    $("runOne").disabled = isBusy;
    $("runMany").disabled = isBusy;
    $("stopBtn").disabled = !isBusy;
  }

  async function runOnce(){
    stopped = false;
    setBusy(true);
    $("bar").style.width = "15%";
    $("progressText").textContent = "מריץ סיבוב אחד…";
    log("מריץ…");

    try {
      const result = await refreshOnce();
      $("bar").style.width = "100%";
      log(result);
      await loadStatus(false);
    } catch (error) {
      log({ ok:false, error:String(error?.message || error) });
    } finally {
      setBusy(false);
      $("progressText").textContent = "סיים.";
    }
  }

  async function runMany(){
    stopped = false;
    setBusy(true);

    const rounds = Math.max(1, Math.min(500, parseInt($("rounds").value || "1", 10)));
    const delay = parseInt($("delay").value || "1000", 10);
    const summary = [];
    log(\`מתחיל \${rounds} סיבובים…\`);

    try {
      for(let i = 1; i <= rounds; i++){
        if(stopped) break;

        $("bar").style.width = Math.round(((i - 1) / rounds) * 100) + "%";
        $("progressText").textContent = \`מריץ סיבוב \${i} מתוך \${rounds}…\`;

        const result = await refreshOnce();
        summary.push({ round:i, status:result.status, data:result.data });
        appendLog({ round:i, status:result.status, data:result.data });

        if(!result.ok || result.data?.ok === false){
          appendLog("נעצר בגלל שגיאה.");
          break;
        }

        if(result.data?.checked === 0){
          appendLog("אין עוד סרטונים חסרים לפי ההגדרות הנוכחיות.");
          break;
        }

        if(i < rounds) await sleep(delay);
      }

      $("bar").style.width = "100%";
      $("progressText").textContent = stopped ? "נעצר." : "סיים.";
      await loadStatus(false);
    } catch (error) {
      appendLog({ ok:false, error:String(error?.message || error) });
    } finally {
      setBusy(false);
    }
  }

  function stopRun(){
    stopped = true;
    $("progressText").textContent = "עוצר אחרי הסיבוב הנוכחי…";
  }

  function renderStats(data){
    const totals = data?.totals || {};
    const tables = Object.fromEntries((data?.table_counts || []).map((x) => [x.table_name, x.count]));

    const items = [
      ["videos", tables.videos ?? totals.videos_total ?? 0],
      ["with_details", totals.with_details ?? 0],
      ["missing_details", totals.missing_details ?? 0],
      ["video_tags", tables.video_tags ?? 0],
      ["video_fts", tables.video_fts ?? 0],
      ["video_details_fts", tables.video_details_fts ?? 0],
      ["with_stats", totals.with_stats ?? 0],
      ["video_details", tables.video_details ?? 0]
    ];

    $("stats").innerHTML = items.map(([name, num]) => \`
      <div class="stat">
        <div class="name">\${esc(name)}</div>
        <div class="num">\${Number(num || 0).toLocaleString("he-IL")}</div>
      </div>
    \`).join("");
  }

  function renderLatest(rows){
    if(!rows?.length){
      $("latest").innerHTML = \`<p class="muted">אין נתונים.</p>\`;
      return;
    }

    $("latest").innerHTML = \`
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>סרטון</th>
            <th>details</th>
            <th>stats_fetched_at</th>
            <th>description_len</th>
          </tr>
        </thead>
        <tbody>
          \${rows.map((r) => \`
            <tr>
              <td>\${esc(r.id)}</td>
              <td>
                <div>\${esc(r.title || "")}</div>
                <div class="muted" dir="ltr">\${esc(r.video_id)}</div>
              </td>
              <td>\${Number(r.has_details) === 1 ? \`<span class="ok">1</span>\` : \`<span class="bad">0</span>\`}</td>
              <td dir="ltr">\${esc(r.stats_fetched_at || "")}</td>
              <td>\${esc(r.description_len ?? "")}</td>
            </tr>
          \`).join("")}
        </tbody>
      </table>
    \`;
  }

  async function loadStatus(showLog = true){
    const res = await fetch("/k9p1/metadata-status?x=" + Date.now(), {
      credentials: "same-origin",
      cache: "no-store"
    });

    const result = await readResponse(res);
    if(showLog) log(result);

    if(result.ok && result.data?.ok){
      renderStats(result.data);
      renderLatest(result.data.latest_videos || []);
    } else {
      renderStats({});
      $("latest").innerHTML = \`<pre>\${esc(JSON.stringify(result, null, 2))}</pre>\`;
    }
  }

  loadStatus(false).catch((error) => log({ ok:false, error:String(error?.message || error) }));
</script>
</body>
</html>`);
}
