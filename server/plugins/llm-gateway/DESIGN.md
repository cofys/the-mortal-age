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

## Provider chain (all free tier, all STUBBED)

| Order | Provider | Env var | Free-tier shape |
|---|---|---|---|
| 1 | Gemini | `GEMINI_API_KEY` | AI Studio free tier: ~1,500 req/day, 10-15 RPM, `:generateContent`, model `gemini-2.5-flash` |
| 2 | Groq | `GROQ_API_KEY` | ~1,000 req/day per model, 30 RPM, OpenAI-compatible `/openai/v1/chat/completions`, model `llama-3.3-70b-versatile` |

Cerebras was evaluated and dropped (2026-10-06): it requires a payment method
on file. `providers/CerebrasProvider.js` is implemented but OUT of the chain;
re-add it to `ProviderChain` if that changes.

- Same `complete({ system, user, maxTokens })` shape on all three; returns
  `{ ok, text, tokensUsed }` or `{ ok: false, reason }`.
- No key -> no-op with a one-time `NEEDS_API_KEY` log. Nothing ever logs or
  prints key material.
- RPM is a per-provider token bucket: calls QUEUE and wait rather than bursting.
- Circuit breaker: a 429 opens the circuit immediately; other errors open it
  after 3 consecutive failures. 60s cooldown, then a half-open probe.
- Daily call budget (env `LLM_GATEWAY_DAILY_BUDGET`, default 1000): when
  exhausted the gateway stays silent instead of spending money that doesn't exist.

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

Calls per day on the free tier: Gemini allows ~1,500 requests/day, Groq ~1,000.
Request limits are NOT the binding constraint for Groq: at ~920 tokens/call,
1,000 calls = 920K tokens, 4.6x over Groq's 200K/day token quota. So every
provider carries BOTH a daily call cap and a daily token cap at 80% of free
tier (see the SAFETY MODEL comment at the top of ProviderChain.js):
Gemini 1,200 calls / 800K tokens, Groq 800 calls / 150K tokens. Token counting
is conservative (prompt chars/4 + full maxTokens). When either cap is hit the
provider is skipped for the rest of the UTC day; all capped means silence.
Jon's rule: we never exceed free tier, never spend money. All four numbers are
env-overridable (`<PROVIDER>_DAILY_CALL_CAP`, `<PROVIDER>_DAILY_TOKEN_CAP`).

## What's STUBBED (awaiting keys)

1. **Providers** — all three no-op with `NEEDS_API_KEY` until their env var is
   set. Real HTTP request bodies are written and ready; they only fire when
   `LLM_GATEWAY_LIVE=1` AND the key exists. Boot and run fine with zero keys:
   bots stay silent.
2. **SQLite memory store** — no sqlite driver on the game host, so
   `SqliteMemoryStore` logs a marker and delegates to the in-memory store.
   Cards/notes/history do not survive a restart. Same interface; swap when a
   driver lands. Set `LLM_GATEWAY_DB=/path/to/db.sqlite` to select it.
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
   replies itself), `LLM_GATEWAY_DB` (SQLite path when a driver exists).
5. The citizens plugin registers each citizen's personality via
   `llm:citizen-register` { username, personalityCard, replyCooldownMs? } —
   until a bot is registered it stays silent even with keys configured.

## Files

- `LlmGateway.plugin.js` — the plugin; `register` is attach-only, one line per hook
- `Gateway.js` — request -> prompt -> chain -> typing delay -> response event
- `ChatInterceptor.js` — ears: onSocialPacket PM interception + citizen registry
- `Mouth.js` — mouth: forceChat/broadcast and PM delivery of replies
- `ProviderChain.js` — fallback chain, RPM token buckets, circuit breakers, daily budget
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
