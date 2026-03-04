# CraftForge

**Describe a sound. Get a plugin.**

CraftForge is an AI-powered Web Audio plugin generator. Type any effect or sound idea in plain language — CraftForge builds a real, playable Web Audio plugin instantly in the browser.

🔗 **Live demo:** [craftforge.pages.dev](https://craftforge.pages.dev)

Built by [Craft Audio](https://craft-audio.com) — accessibility-first music technology.

---

## What it does

You type a prompt like _"a warm analog chorus with gentle drift"_ or _"dark tape delay with flutter"_ — and CraftForge generates:

- A named plugin with a description
- Real Web Audio API DSP code running in the browser
- Interactive parameter sliders (dynamically generated per plugin)
- A live oscilloscope waveform visualizer
- Instant audio playback via a sawtooth test tone

No DAW. No install. No plugins to download. Just a browser.

---

## Accessibility

CraftForge is built with accessibility as a core principle, not an afterthought:

- **Keyboard navigable** — all controls reachable via Tab, sliders adjustable via arrow keys
- **ARIA labels** on all interactive elements (textarea, sliders, buttons, visualizer canvas)
- **`aria-live` region** for status updates during plugin generation — screen readers announce progress
- **`role="alert"`** on error messages for immediate screen reader announcement
- **High contrast** color palette — text contrast ratios meet WCAG AA
- **Focus-visible styles** — clear keyboard focus indicators on all interactive elements
- **Semantic HTML** — proper use of header, main, footer, button, label
- **No motion required** — animations are purely decorative and do not affect usability

This project is part of the broader Sonic Inclusion initiative — open-source accessibility tooling for deaf and hard-of-hearing musicians.

---

## Architecture

```
Browser (craftforge.pages.dev)
    │
    │  POST /api/generate { prompt }
    ▼
Cloudflare Worker (craftforge-proxy)
    │
    │  POST /v1/messages (API key server-side, never exposed)
    ▼
Anthropic Claude API
    │
    │  JSON plugin spec { name, type, description, parameters, buildFunction }
    ▼
Browser — Web Audio API builds and runs the plugin live
```

**Stack:**
- Frontend: Vanilla HTML/CSS/JS — single file, zero dependencies, zero build step
- Proxy: Cloudflare Worker (Edge, free tier)
- AI: Anthropic Claude (claude-sonnet-4-6)
- Deployment: Cloudflare Pages + Cloudflare Workers

---

## Plugin Spec Format

Claude generates a JSON object with this schema:

```json
{
  "name": "WARM CHORUS",
  "type": "Effect",
  "description": "A lush analog-style chorus with gentle pitch drift.",
  "parameters": [
    { "id": "rate", "name": "Rate", "min": 0.1, "max": 5, "default": 1.2, "unit": "Hz" },
    { "id": "depth", "name": "Depth", "min": 0, "max": 0.01, "default": 0.004, "unit": "" },
    { "id": "mix", "name": "Mix", "min": 0, "max": 1, "default": 0.5, "unit": "" }
  ],
  "buildFunction": "function buildPlugin(ctx, getParam) { ... return { input, output }; }"
}
```

The `buildFunction` uses only standard Web Audio API nodes and runs directly in the browser via `new Function()`.

---

## Self-hosting

### 1. Clone the repo

```bash
git clone https://github.com/indjoov/craftforge.git
cd craftforge
```

### 2. Deploy the Cloudflare Worker

```bash
npm install -g wrangler
wrangler login
cd worker
wrangler deploy
```

### 3. Set your Anthropic API key as a secret

```bash
wrangler secret put ANTHROPIC_API_KEY
```

### 4. Update the Worker URL in index.html

```js
const WORKER_URL = "https://craftforge-proxy.YOUR_SUBDOMAIN.workers.dev/api/generate";
```

### 5. Deploy the frontend to Cloudflare Pages

Upload the site/ folder via the Cloudflare Pages dashboard or connect your GitHub repo for automatic deployments.

---

## Rate limiting

The Cloudflare Worker includes basic in-memory rate limiting (10 requests/hour per IP). For production use, replace with Cloudflare KV-based rate limiting for persistence across Worker instances.

---

## Roadmap

- [ ] Preset saving and sharing (URL-encoded plugin specs)
- [ ] VST3 export via JUCE template system
- [ ] Mobile haptic feedback on parameter changes (Vibration API)
- [ ] Screen reader mode with audio descriptions of waveform shape
- [ ] MIDI input support for testing plugins with real instruments
- [ ] Expanded DSP template library (convolution reverb, granular, spectral)

---

## Part of the Craft Audio ecosystem

| Tool | Description |
|------|-------------|
| PitchCraft | Accessible pitch detection |
| DrumCraft | Accessible drum machine |
| SynthCraft | Accessible synthesizer |
| ResoCraft | Dynamic resonance suppressor |
| CraftLimit | Accessible limiter (Web + VST3) |
| **CraftForge** | AI plugin generator ← you are here |

---

## License

MIT — free to use, modify, and deploy.

---

## About

Built by **Niki Indjov** — Berlin-based musician and audio software developer.
Craft Audio focuses on accessible music technology tools for deaf and hard-of-hearing musicians.

- craftforge.pages.dev
- craft-audio.com
- indjoov.com
