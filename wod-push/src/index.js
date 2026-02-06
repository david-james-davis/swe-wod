import {
  ApplicationServer,
  importVapidKeys,
  PushSubscriber,
  Urgency,
} from "@jsr/negrel__webpush";

const WOD_URL = "https://swe-wod.com/wod.json";
const CORS_HEADERS = {
  // if you want to be strict, use "https://swe-wod.com" instead of "*"
  "Access-Control-Allow-Origin": "https://swe-wod.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};
const LAST_BROADCAST_KEY = "lastBroadcast";

function withCors(res) {
  const headers = new Headers(res.headers || {});
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { ...res, headers });
}

function jsonResponse(obj, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(obj), { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1) CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2) subscribe
    if (url.pathname === '/subscribe' && request.method === 'POST') {
        const sub = await request.json(); // { endpoint, keys: { p256dh, auth } }
        // Key by endpoint for idempotency
        await env.WOD_SUBS.put(sub.endpoint, JSON.stringify(sub));
        return jsonResponse({ ok: true });
    }


    // 3) unsubscribe
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const { endpoint } = await request.json();
      if (endpoint) await env.WOD_SUBS.delete(endpoint);
      return jsonResponse({ ok: true });
    }

    // 4) broadcast (auth protected)
    if (url.pathname === "/broadcast" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.BROADCAST_TOKEN}`) {
        return withCors(new Response("Unauthorized", { status: 401 }));
      }
      const payload = await request.json();
      const res = await broadcast(env, payload);
      return jsonResponse(res);
    }

    // 5) debug
    if (url.pathname === "/debug") {
      const subs = await env.WOD_SUBS.list();
      const meta = await env.WOD_META.list();
      const lastBroadcast = await env.WOD_META.get(LAST_BROADCAST_KEY);
      return jsonResponse({
        totalSubscriptions: subs.keys.length,
        subscriptions: subs.keys.map(k => k.name),
        metaKeys: meta.keys.map(k => k.name),
        lastBroadcast: lastBroadcast ? JSON.parse(lastBroadcast) : null,
      });
    }

    return withCors(new Response("OK"));
  },

  // Cron: send once/day (we schedule two UTC slots and dedupe by date)
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
      const last = await env.WOD_META.get("lastSentDate");
      if (last === today) return; // already sent in the other slot

      const items = await (await fetch(WOD_URL, { cf: { cacheTtl: 0 } })).json();
      const latest = items.reduce((a, b) => (a.date > b.date ? a : b));

      const title = `Word of the Day: ${latest.word}`;
      const body  = latest.definition || "Tap to learn more";
      const url   = "https://swe-wod.com/"; // or deep-link by date/word

      await broadcast(env, { title, body, url });
      await env.WOD_META.put("lastSentDate", today);
    })());
  }
};

function makeApp(env) {
  return new ApplicationServer({
    contactInformation: "mailto:davidjamesdavis.djd@gmail.com",
    vapidKeys: importVapidKeys({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    }),
  });
}

async function sendOne(env, subscription, payload) {
  const app = makeApp(env);
  const sub = PushSubscriber.as(subscription);
  // JSON payload; use pushTextMessage for plain text
  return sub.pushMessage(app, JSON.stringify(payload), {
    ttl: 3600,
    urgency: Urgency.Normal,
  });
}

async function broadcast(env, data) {
  let delivered = 0, removed = 0, total = 0, failed = 0;
  const statusCounts = {};
  let cursor;

  do {
    const page = await env.WOD_SUBS.list({ cursor });
    total += page.keys.length;

    for (const { name: endpoint } of page.keys) {
      const subJSON = await env.WOD_SUBS.get(endpoint);
      if (!subJSON) continue;

      try {
        const subscription = JSON.parse(subJSON);
        const res = await sendOne(env, subscription, data);

        // @negrel/webpush returns a Response-like object.
        if (res && res.ok) {
          delivered++;
        } else if (res) {
          statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
          if (res.status === 404 || res.status === 410) {
            await env.WOD_SUBS.delete(endpoint);
            removed++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      } catch {
        // Malformed/expired sub: clean it up
        await env.WOD_SUBS.delete(endpoint);
        removed++;
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const summary = {
    delivered,
    removed,
    failed,
    total,
    statusCounts,
    sentAt: new Date().toISOString()
  };
  try {
    await env.WOD_META.put(LAST_BROADCAST_KEY, JSON.stringify(summary));
  } catch {}
  return summary;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" }
  });
}
