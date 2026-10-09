# LLM Chat Gateway — DESIGN.md

The "mouth" of the AI citizens. Scripted bodies play the game; the LLM only wakes
up when a real player talks to a citizen bot. Silence is the default.

## Architecture

```
real player PMs a citizen bot
        |
        v
ChatInterceptor (api.onSocialPacket, "private_message")
        |  emits
        v
llm:chat-request { citizenUsername, requesterUsername, text, channel }
        |
        v
Gateway.handleChatRequest
  - citizen registry + MemoryStore (card, notes, history)
  - PromptBuilder (token-lean prompt, ~920 tokens/call typical)
  - ProviderChain.complete  (Gemini -> Groq)
  - record exchange in memory
  - TypingScheduler (human typing delay, latest-wins)
        |  emits
        v
llm:chat-response { ..., text, provider, tokensUsed, latencyMs }
        |
        v
Mouth (forceChat bubble + sendPublicChat to nearby players,
       or a real PM back to the requester for private chat)
```

Bots are full Player entities but have no ClientConnection, so MCP-style
injection (`core.dispatchClientMessages`) cannot drive them — the mouth speaks
through `bot.forceChat()` plus the same broadcast loop core's
`ChatPacketListener.handleText` uses for public chat. Per-player reply cooldowns
(default 8s) and a daily call budget keep one chatty player from farming calls.

## Provider chain: model slots (all free tier, all STUBBED)

Free tiers are PER MODEL, so the chain is a flat list of (provider, model)
slots, each its own quota bucket: own RPM limiter, own circuit breaker, own
daily call + token caps at 80% of free tier. Using every free model multiplies
headroom ~3-5x.

Model inventory (Groq numbers are ground truth from the org limits page,
2026-10-06; Gemini numbers are widely-reported AI Studio free tier):

| Provider | Model | Tier | Free tier | Slot caps (80%) |
|---|---|---|---|---|
| gemini | gemini-2.5-flash | flagship | ~1,500 req/day | 1,200 req / 800K tok |
| groq | openai/gpt-oss-120b | flagship | 30 RPM, 1K req/d, 200K tok/d | 24 RPM, 800 req / 160K tok |
| groq | qwen/qwen3.8-27b | flagship | 30 RPM, 1K req/d, 200K tok/d | 24 RPM, 800 req / 160K tok |
| gemini | gemini-2.0-flash | standard | ~1,500 req/day | 1,200 req / 800K tok |
| groq | openai/gpt-oss-20b | standard | 30 RPM, 1K req/d, 200K tok/d | 24 RPM, 800 req / 160K tok |
| gemini | gemini-2.5-flash-lite | lite | ~1,500 req/day | 1,200 req / 800K tok |
| groq | allam-2-7b | lite | 30 RPM, 7K req/d, 500K tok/d | 24 RPM, 5,600 req / 400K tok |
| groq | openai/gpt-oss-safeguard-20b | drip | 3 RPM, 1K req/d, 200K tok/d | 2 RPM, 800 req / 160K tok |

Combined free headroom: ~12K req/day, ~3.4M tokens/day across all slots.
`llama-3.3-70b-versatile` is CONFIRMED gone from Groq's free tier -- do not use it.

Cerebras was evaluated and dropped (2026-10-06): it requires a payment method
on file. `providers/CerebrasProvider.js` is implemented but OUT of the chain.

Routing (quota-aware, in `ProviderChain.rankSlots`):
score = remainingQuotaFraction x tierWeight. First contact (`history` empty)
goes out with `tier: "flagship"`; routine chatter spends cheap lite quota first
and saves flagship headroom. A 429 on one model never affects its siblings.

- Same `complete({ system, user, maxTokens, tier? })` shape on all slots; returns
  `{ ok, text, tokensUsed, provider, model }` or `{ ok: false, reason }`.
- No key -> no-op with a one-time `NEEDS_API_KEY` log. Nothing ever logs or
  prints key material.
- RPM is a per-slot token bucket: calls QUEUE and wait rather than bursting.
- Circuit breaker is per slot: a 429 opens it immediately; other errors open it
  after 3 consecutive failures. 60s cooldown, then a half-open probe.
- Daily caps: when a slot's call OR token cap is hit it is skipped for the rest
  of the UTC day (`[llm-gateway] DAILY CAP reached for <slot> (...)`); every slot
  capped means silence. Chain-wide `LLM_GATEWAY_DAILY_BUDGET` (default 1000)
  guards on top.

## Token budget math (free-tier request limits)

Estimate: tokens ~= chars / 4. Per chat call:

| Component | Tokens |
|---|---|
| World grounding (fixed, all citizens share it) | ~160 |
| Personality card (hard cap 480 chars) | ~120 |
| Player notes (top 5) | ~150 |
| History (last 6 exchanges, truncated oldest-first) | ~300 |
| Current player line | ~100 |
| Reply output cap (60 tokens; public chat lines are 80 chars anyway) | 60 |
| Overhead | ~30 |
| **Total per call** | **~920** |

Input hard cap: 2000 tokens (history is truncated to fit). Prompts stay lean
regardless of provider context windows — free-tier *request* limits are the
binding constraint now, not context size.

Calls per day on the free tier: Gemini ~1,500 requests/day per flash model;
Groq 1,000/day per model (7,000/day for allam-2-7b). Request limits are NOT the
binding constraint: at ~920 tokens/call, 1,000 calls = 920K tokens, 4.6x over a
200K/day token quota. So every model slot carries BOTH a daily call cap and a
daily token cap at 80% of its free tier (see the SAFETY MODEL comment at the top
of ProviderChain.js and the slot inventory above). Token counting is
conservative (prompt chars/4 + full maxTokens). When either cap is hit the slot
is skipped for the rest of the UTC day; every slot capped means silence.
Jon's rule: we never exceed free tier, never spend money. Caps are
env-overridable per slot (`<PROVIDER>_<MODEL>_DAILY_CALL_CAP`,
`<PROVIDER>_<MODEL>_DAILY_TOKEN_CAP`, `<PROVIDER>_<MODEL>_RPM`) with the legacy
provider-level vars as fallback.

## What's STUBBED (awaiting keys)

1. **Providers** — all three no-op with `NEEDS_API_KEY` until their env var is
   set. Real HTTP request bodies are written and ready; they only fire when
   `LLM_GATEWAY_LIVE=1` AND the key exists. Boot and run fine with zero keys:
   bots stay silent.
2. **SQLite memory store** — no sqlite driver on the game host, so
   `SqliteMemoryStore` logs a marker and delegates to the in-memory store.
   Cards/notes/history do not survive a restart. Same interface; swap when a
   driver lands. Set `LLM_GATEWAY_DB=/path/to/db.sqlite` to select it.
   NOTE: the default memory store is now `JsonMemoryStore` (JSON file at
   `data/saves/llm-gateway-memory.json`, env `LLM_GATEWAY_MEMORY_FILE`) —
   conversation memory DOES survive restarts; the SQLite path only matters
   if Jon prefers it over JSON when a driver lands.
3. **Public-chat interception** — `ChatPacketListener.handleText` broadcasts
   public chat without emitting a plugin hook, so the gateway currently
   intercepts only private messages to citizen bots. Options when Jon wants it:
   (a) the citizens plugin emits `llm:chat-request` for nearby public chat, or
   (b) a one-line generic core addition in `handleText`:
   `PluginManager.emitSocialPacket({ player, packet: { type: "chat", text, messageType: "public" }, handled: false })`
   (generic hook = core-legal per AGENTS.md; the packet union type would also
   need "public" added). Neither is implemented here — additive-only.

## What Jon needs to do

1. Create 2 free API keys: Gemini (Google AI Studio), Groq (console.groq.com).
   No credit card on either.
2. Set `GEMINI_API_KEY`, `GROQ_API_KEY` in the server env.
3. Set `LLM_GATEWAY_LIVE=1` to actually make calls.
4. Optional tuning: `GEMINI_MODEL` / `GROQ_MODEL`,
   `GEMINI_RPM` / `GROQ_RPM`, `LLM_GATEWAY_DAILY_BUDGET`,
   `LLM_GATEWAY_MOUTH=0` (disable default mouth if the citizens plugin speaks
   replies itself), `LLM_GATEWAY_DB` (SQLite path when a driver exists),
   `LLM_GATEWAY_MEMORY_FILE` (JSON memory path; empty = in-memory only),
   `LLM_GATEWAY_MEMORY_FLUSH_MS` (debounced JSON-memory write interval; default
   5000; writes are dirty-flag + debounced, never on the hot path),
   `LLM_GATEWAY_USAGE_FILE` (usage rollup path; empty = in-memory only),
   `LLM_GATEWAY_PUBLIC_PER_PLAYER_MAX` (default 4) /
   `LLM_GATEWAY_PUBLIC_PER_PLAYER_WINDOW_MS` (default 300000) /
   `LLM_GATEWAY_PM_PER_PLAYER_DAILY_MAX` (default 200) — per-player reply
   throttles that close the spam-farming vector,
   `LLM_GATEWAY_PUBLIC_FLAGSHIP_FIRST_CONTACT=1` (route first-contact public
   replies to flagship instead of lite).
5. The citizens plugin registers each citizen's personality via
   `llm:citizen-register` { username, personalityCard, replyCooldownMs? } —
   until a bot is registered it stays silent even with keys configured.

## Files

- `LlmGateway.plugin.js` — the plugin; `register` is attach-only, one line per hook
- `Gateway.js` — request -> prompt -> chain -> typing delay -> response event
- `ChatInterceptor.js` — ears: onSocialPacket PM interception + citizen registry
- `Mouth.js` — mouth: forceChat/broadcast and PM delivery of replies
- `ProviderChain.js` — model-slot chain: quota-aware routing, per-slot RPM buckets, circuit breakers, daily caps
- `providers/BaseProvider.js` — stubbed base (NEEDS_API_KEY gate, never logs keys)
- `providers/CerebrasProvider.js` — implemented but OUT of the chain (payment method required); `GeminiProvider.js` / `GroqProvider.js`
- `PromptBuilder.js` — personality card + notes + truncated history, 2000-token input cap
- `MemoryStore.js` — card/notes/history interface; in-memory v1, SQLite stubbed
- `TypingScheduler.js` — 40-60 wpm simulated typing + jitter, never instant, latest-wins

## Verification

- `node --check` on all 12 files: pass.
- Functional smoke (ephemeral, /tmp): prompt fits 2000-token cap (1279 on a fat
  20-exchange stress), memory round-trip OK (caught and fixed a case-sensitivity
  bug in card keys), typing delays 900-10,000ms, chain returns
  `ALL_PROVIDERS_UNAVAILABLE` gracefully with no keys, PM-to-bot emits
  `llm:chat-request` while PM-to-real-player emits nothing, circuit breaker
  opens on 429 / 3 errors and half-opens after cooldown, daily budget guard
  verified (caught and fixed `Number("0") || 1000` fallback swallowing a 0 budget).
