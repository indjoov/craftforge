/**
 * CraftForge – Cloudflare Worker
 * Handles: AI generation proxy + auth (magic links) + credits (KV) + Stripe webhook
 *
 * KV binding required in wrangler.toml:  CRAFTFORGE_KV
 * Secrets (set via: wrangler secret put <NAME>):
 *   ANTHROPIC_API_KEY
 *   RESEND_API_KEY         — resend.com free tier
 *   TOKEN_SECRET           — any random 32+ char string
 *   STRIPE_WEBHOOK_SECRET  — from Stripe dashboard
 *
 * [vars] in wrangler.toml:
 *   FRONTEND_URL = "https://craftforge.pages.dev"
 */

// ── Config ──────────────────────────────────────────────────────────────────
const FREE_PER_MONTH   = 3;
const CREDIT_PACKS     = { starter: 10, pro: 40, studio: 100 };
const ALLOWED_ORIGIN   = "*"; // TODO: set to "https://craftforge.pages.dev" in production

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    const cors = {
      "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age":       "86400",
    };

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    let response;
    try {
      if      (path === "/api/generate"          && method === "POST") response = await handleGenerate(request, env);
      else if (path === "/api/auth/request-link" && method === "POST") response = await handleRequestLink(request, env);
      else if (path === "/api/auth/verify"       && method === "GET" ) response = await handleVerify(request, env);
      else if (path === "/api/credits/check"     && method === "GET" ) response = await handleCheckCredits(request, env);
      else if (path === "/api/stripe/webhook"    && method === "POST") response = await handleStripeWebhook(request, env);
      else response = json({ error: "Not found" }, 404);
    } catch (err) {
      console.error(err);
      response = json({ error: "Internal server error" }, 500);
    }

    Object.entries(cors).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  },
};

// ── Generate (with credit gate) ─────────────────────────────────────────────
async function handleGenerate(request, env) {
  // 1. Resolve user from token (or fall back to IP for anonymous free tier)
  const token  = getBearerToken(request);
  let   email  = null;

  if (token) {
    const payload = await verifyToken(token, env.TOKEN_SECRET);
    if (payload && Date.now() < payload.exp) email = payload.email;
  }

  // 2. Credit check & consume
  const creditResult = await consumeCredit(email, request, env);
  if (!creditResult.ok) {
    return json({ error: "No credits remaining", paywall: true, needsLogin: !email }, 402);
  }

  // 3. Parse prompt
  let body;
  try { body = await request.json(); } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { prompt } = body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return json({ error: "Missing prompt" }, 400);
  }
  if (prompt.length > 500) {
    return json({ error: "Prompt too long (max 500 chars)" }, 400);
  }

  // 4. Call Anthropic
  const SYSTEM = `You are a Web Audio API plugin generator. Output ONLY valid JSON, no markdown, no explanation.

Schema:
{
  "name": "PLUGIN NAME",
  "type": "Effect | Synth | Utility",
  "description": "One sentence.",
  "parameters": [
    { "id": "string", "name": "Display Name", "min": 0, "max": 1, "default": 0.5, "unit": "" }
  ],
  "buildFunction": "function buildPlugin(ctx, getParam) { ... return { input, output }; }"
}

buildFunction rules:
- ctx = AudioContext, getParam(id) returns 0..1 normalized value
- Must create input GainNode and output GainNode, connect chain between them
- Return { input, output }
- Use ONLY: GainNode, BiquadFilterNode, DelayNode, DynamicsCompressorNode, WaveShaperNode, StereoPannerNode, OscillatorNode
- const mapRange = (v, lo, hi) => lo + v*(hi-lo); is available as helper
- Apply params directly on node creation
- 3–5 parameters with musically useful ranges
- Output ONLY the JSON object.`;

  let anthropicRes;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":          env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 2000,
        system:     SYSTEM,
        messages:   [{ role: "user", content: `Plugin for: "${prompt.trim()}"` }],
      }),
    });
  } catch (err) {
    return json({ error: "Failed to reach Anthropic API: " + err.message }, 502);
  }

  const data = await anthropicRes.json();
  if (!anthropicRes.ok) {
    return json({ error: data.error?.message || "Anthropic API error" }, anthropicRes.status);
  }

  // Include remaining credits in response so frontend can update display
  return json({ ...data, _credits: creditResult });
}

// ── Auth: Request Magic Link ─────────────────────────────────────────────────
async function handleRequestLink(request, env) {
  const { email } = await request.json().catch(() => ({}));
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Invalid email" }, 400);
  }

  const token = await signToken({ email, exp: Date.now() + 15 * 60 * 1000 }, env.TOKEN_SECRET);
  const frontendUrl = env.FRONTEND_URL || "https://craftforge.pages.dev";
  const link = `${frontendUrl}?cf_token=${token}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      from:    "CraftForge <noreply@craftforge.pages.dev>",
      to:      email,
      subject: "Your CraftForge login link",
      html:    magicLinkEmailHtml(link, email),
    }),
  });

  if (!res.ok) {
    console.error("Resend error:", await res.text());
    return json({ error: "Failed to send email" }, 500);
  }

  return json({ ok: true });
}

// ── Auth: Verify Token ───────────────────────────────────────────────────────
async function handleVerify(request, env) {
  const url   = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return json({ error: "Missing token" }, 400);

  const payload = await verifyToken(token, env.TOKEN_SECRET);
  if (!payload)           return json({ error: "Invalid token" }, 401);
  if (Date.now() > payload.exp) return json({ error: "Link expired" }, 401);

  // Issue 30-day session token
  const sessionToken = await signToken(
    { email: payload.email, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 },
    env.TOKEN_SECRET
  );

  // Ensure user record exists
  const user = await getUser(payload.email, env);
  if (!user._exists) await saveUser(payload.email, user, env);

  // Get credit info
  const freeRemaining = getFreeRemaining(user);
  return json({
    ok:            true,
    session_token: sessionToken,
    email:         payload.email,
    credits:       user.credits,
    free_remaining: freeRemaining,
  });
}

// ── Credits: Check ───────────────────────────────────────────────────────────
async function handleCheckCredits(request, env) {
  const token = getBearerToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);

  const payload = await verifyToken(token, env.TOKEN_SECRET);
  if (!payload || Date.now() > payload.exp) return json({ error: "Unauthorized" }, 401);

  const user          = await getUser(payload.email, env);
  const freeRemaining = getFreeRemaining(user);

  return json({
    email:          payload.email,
    credits:        user.credits,
    free_remaining: freeRemaining,
    total:          user.credits + freeRemaining,
  });
}

// ── Stripe Webhook ───────────────────────────────────────────────────────────
async function handleStripeWebhook(request, env) {
  const body = await request.text();
  const sig  = request.headers.get("stripe-signature") || "";

  const valid = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ error: "Invalid signature" }, 400);

  const event = JSON.parse(body);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email   = session.customer_email || session.metadata?.email;
    const pack    = session.metadata?.pack;

    if (email && pack && CREDIT_PACKS[pack]) {
      const user = await getUser(email, env);
      user.credits += CREDIT_PACKS[pack];
      await saveUser(email, user, env);
      console.log(`Credited ${CREDIT_PACKS[pack]} to ${email} (pack: ${pack})`);
    }
  }

  return json({ received: true });
}

// ── Credit logic ─────────────────────────────────────────────────────────────
async function consumeCredit(email, request, env) {
  if (email) {
    // Logged-in user
    const user          = await getUser(email, env);
    const freeRemaining = getFreeRemaining(user);

    if (freeRemaining > 0) {
      user.free_used_this_month += 1;
      await saveUser(email, user, env);
      return { ok: true, source: "free", free_remaining: freeRemaining - 1, credits: user.credits };
    }
    if (user.credits > 0) {
      user.credits -= 1;
      await saveUser(email, user, env);
      return { ok: true, source: "paid", free_remaining: 0, credits: user.credits };
    }
    return { ok: false };
  } else {
    // Anonymous: rate-limit by IP (simple KV counter)
    const ip  = request.headers.get("CF-Connecting-IP") || "unknown";
    const key = `anon:${ip}:${currentMonthKey()}`;
    const raw = await env.CRAFTFORGE_KV.get(key);
    const count = raw ? parseInt(raw) : 0;
    if (count >= FREE_PER_MONTH) return { ok: false };
    await env.CRAFTFORGE_KV.put(key, String(count + 1), { expirationTtl: 60 * 60 * 24 * 35 });
    return { ok: true, source: "free_anon", free_remaining: FREE_PER_MONTH - count - 1 };
  }
}

// ── User KV helpers ──────────────────────────────────────────────────────────
async function getUser(email, env) {
  const raw = await env.CRAFTFORGE_KV.get(`user:${email}`, "json");
  if (raw) return { ...raw, _exists: true };
  return {
    email,
    credits:              0,
    free_used_this_month: 0,
    free_reset_month:     currentMonthKey(),
    created_at:           Date.now(),
    _exists:              false,
  };
}

async function saveUser(email, user, env) {
  const { _exists, ...data } = user;
  await env.CRAFTFORGE_KV.put(`user:${email}`, JSON.stringify(data));
}

function getFreeRemaining(user) {
  if (user.free_reset_month !== currentMonthKey()) {
    user.free_used_this_month = 0;
    user.free_reset_month     = currentMonthKey();
  }
  return Math.max(0, FREE_PER_MONTH - (user.free_used_this_month || 0));
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}`;
}

// ── Utility ──────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

// ── HMAC token (no library) ──────────────────────────────────────────────────
async function signToken(payload, secret) {
  const header = btoa(JSON.stringify({ alg: "HS256" }));
  const body   = btoa(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const key    = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig    = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${data}.${sigB64}`;
}

async function verifyToken(token, secret) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data = `${header}.${body}`;
    const key  = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
    if (!valid) return null;
    return JSON.parse(atob(body));
  } catch { return null; }
}

async function verifyStripeSignature(body, sig, secret) {
  try {
    const timestamp = sig.split(",").find(p => p.startsWith("t="))?.split("=")[1];
    const v1        = sig.split(",").find(p => p.startsWith("v1="))?.split("=")[1];
    if (!timestamp || !v1) return false;
    const payload  = `${timestamp}.${body}`;
    const key      = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const computed    = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const computedHex = Array.from(new Uint8Array(computed)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computedHex === v1;
  } catch { return false; }
}

// ── Email template ────────────────────────────────────────────────────────────
function magicLinkEmailHtml(link, email) {
  return `<!DOCTYPE html>
<html>
<body style="font-family:'DM Mono','Courier New',monospace;background:#0a0a0f;color:#e0e0e0;padding:40px;max-width:480px;margin:0 auto;">
  <div style="color:#9d97ff;font-size:11px;letter-spacing:0.2em;font-weight:700;margin-bottom:24px;">CRAFTFORGE · CRAFT AUDIO</div>
  <p style="color:#aaa;font-size:14px;line-height:1.6;margin-bottom:24px;">
    Here's your login link for <strong style="color:#fff;">${email}</strong>.<br>
    It expires in 15 minutes.
  </p>
  <a href="${link}" style="display:inline-block;padding:13px 28px;background:#6c63ff;color:#fff;text-decoration:none;font-size:13px;font-weight:700;letter-spacing:0.08em;border-radius:8px;">
    OPEN CRAFTFORGE →
  </a>
  <p style="color:#444;font-size:11px;margin-top:28px;line-height:1.5;">
    Didn't request this? Ignore it — nothing will happen.
  </p>
</body>
</html>`;
}
