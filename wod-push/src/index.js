import {
  ApplicationServer,
  importVapidKeys,
  PushSubscriber,
  Urgency,
} from "@jsr/negrel__webpush";

const WOD_URL = "https://swe-wod.com/wod.json";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Save subscription
    if (url.pathname === "/subscribe" && request.method === "POST") {
      const sub = await request.json();
      await env.WOD_SUBS.put(sub.endpoint, JSON.stringify(sub));
      return json({ ok: true });
    }

    // Remove subscription
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const { endpoint } = await request.json();
      if (endpoint) await env.WOD_SUBS.delete(endpoint);
      return json({ ok: true });
    }

    // Manual broadcast (for testing)
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const token = request.headers.get("Authorization");
      if (token !== `Bearer ${env.BROADCAST_TOKEN}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const payload = await request.json();
      const res = await broadcast(env, payload);
      return json(res);
    }

    if (url.pathname === "/debug") {
      const subs = await env.WOD_SUBS.list();
      const meta = await env.WOD_META.list();

      return new Response(
        JSON.stringify(
          {
            totalSubscriptions: subs.keys.length,
            subscriptions: subs.keys.map(k => k.name),
            metaKeys: meta.keys.map(k => k.name),
          },
          null,
          2
        ),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("OK");
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
    contactInformation: "mailto:you@example.com",
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
  let delivered = 0, removed = 0, total = 0;
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
        } else if (res && (res.status === 404 || res.status === 410)) {
          await env.WOD_SUBS.delete(endpoint);
          removed++;
        }
      } catch {
        // Malformed/expired sub: clean it up
        await env.WOD_SUBS.delete(endpoint);
        removed++;
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return { delivered, removed, total };
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" }
  });
}
