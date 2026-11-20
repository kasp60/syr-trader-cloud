const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        service: "SYR TRADER",
        environment: "cloudflare-workers",
        timestamp: new Date().toISOString()
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "API route not implemented" }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("SYR TRADER assets are not configured.", { status: 503 });
  }
};
