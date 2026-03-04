/**
 * CraftForge – Cloudflare Worker Proxy
 * Routes requests to Anthropic API, keeps the API key server-side.
 * Deploy at: https://dash.cloudflare.com → Workers
 */

// ── Rate limiting (in-memory per Worker instance) ──────────────────────────
// Cloudflare Workers are stateless, so for production use Cloudflare KV
// This gives ~10 req/hour per IP as a basic guard
const rateLimitMap = new Map();
const RATE_LIMIT = 10;       // max requests
const RATE_WINDOW = 60 * 60; // per 1 hour (seconds)

function isRateLimited(ip) {
  const now = Math.floor(Date.now() / 1000);
  const entry = rateLimitMap.get(ip) || { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_WINDOW) {
    // Reset window
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT) return true;

  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

// ── CORS headers ────────────────────────────────────────────────────────────
// Change this to your actual domain once deployed, e.g.:
// "https://craft-audio.com" or "https://craftforge.craft-audio.com"
const ALLOWED_ORIGIN = "*"; // TODO: restrict to your domain in production

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// ── Main handler ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin),
      });
    }

    // Only allow POST to /api/generate
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/generate") {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Rate limiting
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (isRateLimited(ip)) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Please wait before generating another plugin." }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        }
      );
    }

    // Parse incoming body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const { prompt } = body;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return new Response(JSON.stringify({ error: "Missing prompt" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Prompt length guard
    if (prompt.length > 500) {
      return new Response(JSON.stringify({ error: "Prompt too long (max 500 chars)" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // Call Anthropic API — key comes from Worker secret (env.ANTHROPIC_API_KEY)
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

    let anthropicResponse;
    try {
      anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          system: SYSTEM,
          messages: [{ role: "user", content: `Plugin for: "${prompt.trim()}"` }],
        }),
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Failed to reach Anthropic API: " + err.message }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        }
      );
    }

    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      return new Response(
        JSON.stringify({ error: data.error?.message || "Anthropic API error" }),
        {
          status: anthropicResponse.status,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        }
      );
    }

    // Forward the response to the client
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin),
      },
    });
  },
};
