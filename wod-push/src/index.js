import {
  ApplicationServer,
  exportApplicationServerKey,
  importVapidKeys,
  PushSubscriber,
  PushMessageError,
  Urgency,
} from "@jsr/negrel__webpush";

const WOD_URL = "https://swe-wod.com/wod.json";
const ALLOWED_ORIGINS = new Set([
  "https://swe-wod.com",
  "https://www.swe-wod.com"
]);
const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};
const LAST_BROADCAST_KEY = "lastBroadcast";
const LAST_SUBSCRIBE_KEY = "lastSubscribe";

let appPromise;

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://swe-wod.com";
  return { ...BASE_CORS_HEADERS, "Access-Control-Allow-Origin": allowOrigin };
}

function withCors(res, origin = "") {
  const headers = new Headers(res.headers || {});
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(res.body, { ...res, headers });
}

function jsonResponse(obj, init = {}, origin = "") {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(JSON.stringify(obj), { ...init, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    // 1) CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 1.5) public VAPID key
    if (url.pathname === "/vapid" && request.method === "GET") {
      const app = await getApp(env);
      const publicKey = await exportApplicationServerKey(app.vapidKeys);
      return jsonResponse({ publicKey }, {}, origin);
    }

    // 2) subscribe
    if (url.pathname === '/subscribe' && request.method === 'POST') {
        const sub = await request.json(); // { endpoint, keys: { p256dh, auth } }
        // Key by endpoint for idempotency
        await env.WOD_SUBS.put(sub.endpoint, JSON.stringify(sub));
        const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
        const suffix = endpoint ? endpoint.slice(-16) : "";
        await env.WOD_META.put(LAST_SUBSCRIBE_KEY, JSON.stringify({
          at: new Date().toISOString(),
          origin,
          ua: request.headers.get("User-Agent") || "",
          endpointSuffix: suffix
        }));
        return jsonResponse({ ok: true }, {}, origin);
    }


    // 3) unsubscribe
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const { endpoint } = await request.json();
      if (endpoint) await env.WOD_SUBS.delete(endpoint);
      return jsonResponse({ ok: true }, {}, origin);
    }

    // 4) broadcast (auth protected)
    if (url.pathname === "/broadcast" && request.method === "POST") {
      if (request.headers.get("Authorization") !== `Bearer ${env.BROADCAST_TOKEN}`) {
        return withCors(new Response("Unauthorized", { status: 401 }), origin);
      }
      const payload = await request.json();
      const res = await broadcast(env, payload);
      return jsonResponse(res, {}, origin);
    }

    // 5) debug
    if (url.pathname === "/debug") {
      const subs = await env.WOD_SUBS.list();
      const meta = await env.WOD_META.list();
      const lastBroadcast = await env.WOD_META.get(LAST_BROADCAST_KEY);
      const lastSubscribe = await env.WOD_META.get(LAST_SUBSCRIBE_KEY);
      return jsonResponse({
        totalSubscriptions: subs.keys.length,
        subscriptions: subs.keys.map(k => k.name),
        metaKeys: meta.keys.map(k => k.name),
        lastBroadcast: lastBroadcast ? JSON.parse(lastBroadcast) : null,
        lastSubscribe: lastSubscribe ? JSON.parse(lastSubscribe) : null,
      }, {}, origin);
    }

    return withCors(new Response("OK"), origin);
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
  return ApplicationServer.new({
    contactInformation: "mailto:davidjamesdavis.djd@gmail.com",
    vapidKeys: importVapidKeys(getVapidJwk(env)),
  });
}

async function getApp(env) {
  if (!appPromise) appPromise = makeApp(env);
  return appPromise;
}

async function sendOne(env, subscription, payload) {
  const app = await getApp(env);
  const sub = app.subscribe(subscription);
  // JSON payload; use pushTextMessage for plain text
  await sub.pushMessage(new TextEncoder().encode(JSON.stringify(payload)), {
    ttl: 3600,
    urgency: Urgency.Normal,
  });
}

async function broadcast(env, data) {
  let delivered = 0, removed = 0, total = 0, failed = 0;
  const statusCounts = {};
  const errorSamples = [];
  let cursor;

  do {
    const page = await env.WOD_SUBS.list({ cursor });
    total += page.keys.length;

    for (const { name: endpoint } of page.keys) {
      const subJSON = await env.WOD_SUBS.get(endpoint);
      if (!subJSON) continue;

      try {
        const subscription = JSON.parse(subJSON);
        await sendOne(env, subscription, data);
        delivered++;
      } catch (err) {
        failed++;
        if (err instanceof PushMessageError) {
          if (err.isGone?.()) {
            await env.WOD_SUBS.delete(endpoint);
            removed++;
          }
          if (err.response?.status) {
            statusCounts[err.response.status] = (statusCounts[err.response.status] || 0) + 1;
          }
        }
        if (errorSamples.length < 5) {
          const name = err?.name || "Error";
          const message = err?.message || String(err);
          errorSamples.push({ name, message });
        }
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
    errorSamples,
    sentAt: new Date().toISOString()
  };
  try {
    await env.WOD_META.put(LAST_BROADCAST_KEY, JSON.stringify(summary));
  } catch {}
  return summary;
}

function getVapidJwk(env) {
  if (env.VAPID_KEYS) {
    return JSON.parse(env.VAPID_KEYS);
  }
  if (env.VAPID_PUBLIC_JWK && env.VAPID_PRIVATE_JWK) {
    return {
      publicKey: JSON.parse(env.VAPID_PUBLIC_JWK),
      privateKey: JSON.parse(env.VAPID_PRIVATE_JWK),
    };
  }
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    if (env.VAPID_PUBLIC_KEY.trim().startsWith("{")) {
      return {
        publicKey: JSON.parse(env.VAPID_PUBLIC_KEY),
        privateKey: JSON.parse(env.VAPID_PRIVATE_KEY),
      };
    }
    return jwkFromBase64Keys(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  }
  throw new Error("Missing VAPID keys. Set VAPID_KEYS (JWK JSON) or VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY.");
}

function jwkFromBase64Keys(publicKeyB64, privateKeyB64) {
  const pub = base64UrlToBytes(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 4) {
    throw new Error("Invalid VAPID public key format (expected 65-byte uncompressed P-256 key).");
  }
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const d = base64UrlToBytes(privateKeyB64);
  if (d.length !== 32) {
    throw new Error("Invalid VAPID private key format (expected 32-byte P-256 key).");
  }
  const jwkPublic = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(x),
    y: bytesToBase64Url(y),
  };
  const jwkPrivate = { ...jwkPublic, d: bytesToBase64Url(d) };
  return { publicKey: jwkPublic, privateKey: jwkPrivate };
}

function base64UrlToBytes(b64url) {
  const pad = "=".repeat((4 - b64url.length % 4) % 4);
  const base64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return base64;
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "Content-Type": "application/json" }
  });
}
