function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Admin", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

function parseBasicAuth(request) {
  const h = request.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return null;
  try {
    const raw = atob(h.slice(6)); // "user:pass"
    const i = raw.indexOf(":");
    if (i < 0) return null;
    return { user: raw.slice(0, i), pass: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

export async function onRequest({ env, request, next }) {
  const user = env.ADMIN_BASIC_USER || "";
  const pass = env.ADMIN_BASIC_PASS || "";
  if (!user || !pass) return new Response("Missing ADMIN_BASIC_USER/ADMIN_BASIC_PASS", { status: 500 });

  const creds = parseBasicAuth(request);
  if (!creds) return unauthorized();
  if (creds.user !== user || creds.pass !== pass) return unauthorized();

  return next();
}
