// Gateway -- orchestration for llm:chat-request -> llm:chat-response.
//
// Flow: llm:chat-request { citizenUsername, requesterUsername, text, channel }
//   1. look up citizen (interceptor registry) + memory (card, notes, history)
//   2. build token-lean prompt (PromptBuilder)
//   3. run the provider chain (Gemini -> Groq); on total failure,
//      stay silent -- silence is free and human
//   4. record the exchange in memory
//   5. TypingScheduler waits out a human typing delay, then emitCustomEvent
//      llm:chat-response { citizenUsername, requesterUsername, text, channel,
//      provider, tokensUsed, latencyMs } -- Mouth.js (or the citizens plugin)
//      speaks it.
//
// The citizens plugin registers personalities via `llm:citizen-register` and can
// emit `llm:chat-request` itself for public chat (see ChatInterceptor).

const { ProviderChain } = require("./ProviderChain");
const { InMemoryMemoryStore, SqliteMemoryStore } = require("./MemoryStore");
const { buildPrompt, buildSpeakPrompt } = require("./PromptBuilder");
const { TypingScheduler } = require("./TypingScheduler");
const { ChatInterceptor } = require("./ChatInterceptor");
const { onChatResponse } = require("./Mouth");

const SQLITE_DB_PATH = process.env.LLM_GATEWAY_DB ?? "";

// Foreground latency budget (ms): a real player is waiting on this reply.
// Worst case through the chain is a 25s per-slot abort plus up to 30s in the
// rate-limiter queue. Past this budget we stay silent — answering a question
// the player already gave up on is worse than silence, and silence is free.
const FOREGROUND_TIMEOUT_MS =
  Number(process.env.LLM_GATEWAY_FOREGROUND_TIMEOUT_MS) || 12_000;

// Race a promise against a timeout. The loser keeps running in the
// background (its own 25s fetch abort bounds it); its result is discarded.
// A late provider success may still count against daily caps — acceptable:
// it happens only on the timeout path, at most once per request.
function withTimeout(promise, ms, reason) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason, retryable: false }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createMemoryStore() {
  if (SQLITE_DB_PATH) return new SqliteMemoryStore(SQLITE_DB_PATH);
  return new InMemoryMemoryStore();
}

class Gateway {
  constructor(api) {
    this.api = api;
    this.chain = new ProviderChain();
    this.memory = createMemoryStore();
    this.scheduler = new TypingScheduler();
    this.interceptor = new ChatInterceptor(api);
  }

  async handleChatRequest(payload) {
    const { citizenUsername, requesterUsername, text, channel, context } = payload ?? {};
    if (!citizenUsername || !requesterUsername || !text) return;

    // Public-path rate limit: onCitizenChatHeard emits llm:chat-request
    // directly, bypassing ChatInterceptor.checkCooldown (which only guards
    // the private-message path via requestChat). Without this cap, one
    // player spamming public chat in a crowd triggers up to 2 LLM calls
    // per utterance, unbounded — free-tier quota is precious.
    if (channel === "public" && !this.interceptor.checkPublicCooldown(citizenUsername)) return;

    const startedAt = Date.now();
    const citizen = this.interceptor.getCitizen(citizenUsername);
    const [card, notes, history] = await Promise.all([
      this.memory.getCard(citizenUsername),
      this.memory.getNotes(citizenUsername, requesterUsername),
      this.memory.getHistory(citizenUsername, requesterUsername),
    ]);

    // Unregistered bots stay silent: no personality card, no mouth.
    // (The citizens plugin registers cards via llm:citizen-register.)
    if (!citizen && !card) {
      console.info(`[llm-gateway] ${citizenUsername} is not a registered citizen -- staying silent`);
      return;
    }

    const prompt = buildPrompt({
      card: card ?? citizen?.personalityCard ?? null,
      notes,
      history,
      message: text,
      context: context ?? null,
      citizenName: citizenUsername,
    });
    // First contact gets the flagship tier: first impressions shape whether a
    // player keeps talking to citizens. Follow-ups ride cheaper slots.
    // A caller-specified tier (e.g. "lite" for citizen-to-citizen threads)
    // always wins — foreground player chat never subsidizes background chatter.
    if (payload?.tier) prompt.tier = payload.tier;
    else if (history.length === 0) prompt.tier = "flagship";

    // Foreground budget: never make a waiting player eat the full 25s abort
    // + 30s queue worst case. Past the budget, stay silent (handled below
    // like any other failed request).
    const result = await withTimeout(this.chain.complete(prompt), FOREGROUND_TIMEOUT_MS, "FOREGROUND_TIMEOUT");
    if (!result.ok || !result.text) {
      // Everyone is down or unconfigured: stay silent. No retry storm.
      console.info(
        `[llm-gateway] no reply for ${citizenUsername} <- ${requesterUsername} (${result.reason})`
      );
      return;
    }

    // Collapse paragraph breaks / stray whitespace: one clean message, no
    // orphan lines in the chatbox. Hard cap at 160 chars (2x the 80-char
    // public-chat line): a citizen never sends more than a real player could
    // type in two messages. Mouth.js paces the chunks with natural pauses.
    const reply = result.text
      .slice(0, 160)
      .replace(/\s+/g, " ")
      .trim();
    await this.memory.pushExchange(citizenUsername, requesterUsername, text, reply);

    const latencyMs = Date.now() - startedAt;
    this.scheduler.schedule(citizenUsername, requesterUsername, reply, () => {
      this.api.emitCustomEvent("llm:chat-response", {
        citizenUsername,
        requesterUsername,
        text: reply,
        channel,
        threadId: payload?.threadId ?? null,
        provider: result.provider,
        tokensUsed: result.tokensUsed ?? prompt.totalBudgetTokens,
        latencyMs,
      });
    });
  }

  handleCitizenRegister(payload) {
    this.interceptor.onCitizenRegister(payload);
    const card = payload?.personalityCard;
    if (payload?.username && card) {
      this.memory.setCard(payload.username, card).catch(() => {});
    }
  }

  handleCitizenUnregister(payload) {
    this.interceptor.unregisterCitizen(payload?.username);
    if (payload?.username) {
      this.memory.deleteCard(payload.username).catch(() => {});
    }
  }

  /**
   * handleSpeakRequest — a citizen speaks FIRST (no incoming message).
   * Citizen-to-citizen conversation openers. ALWAYS lite tier — this never
   * burns flagship/standard quota. The caller (CitizenSocial) is responsible
   * for only invoking this when a real player is nearby to overhear;
   * otherwise the background journal already recorded that they talked.
   */
  async handleSpeakRequest(payload) {
    const { citizenUsername, toUsername, toRole, toMemory, toKind, playerNote, context, threadId } = payload ?? {};
    if (!citizenUsername || !toUsername) return;

    const startedAt = Date.now();
    const citizen = this.interceptor.getCitizen(citizenUsername);
    const [card, history] = await Promise.all([
      this.memory.getCard(citizenUsername),
      this.memory.getHistory(citizenUsername, toUsername),
    ]);
    if (!citizen && !card) return; // unregistered stays silent

    const prompt = buildSpeakPrompt({
      card: card ?? citizen?.personalityCard ?? null,
      context: context ?? null,
      toName: toUsername,
      toRole: toRole ?? "a fellow citizen",
      toMemory: toMemory ?? null,
      toKind: toKind ?? null,
      playerNote: playerNote ?? null,
      citizenName: citizenUsername,
    });

    const result = await this.chain.complete(prompt);
    if (!result.ok || !result.text) return; // silent on failure/quota

    const reply = result.text
      .slice(0, 160)
      .replace(/\s+/g, " ")
      .trim();
    await this.memory.pushExchange(citizenUsername, toUsername, "(opener)", reply);

    const latencyMs = Date.now() - startedAt;
    this.scheduler.schedule(citizenUsername, toUsername, reply, () => {
      this.api.emitCustomEvent("llm:chat-response", {
        citizenUsername,
        requesterUsername: toUsername,
        text: reply,
        channel: "public",
        threadId: threadId ?? null,
        provider: result.provider,
        tokensUsed: result.tokensUsed ?? prompt.totalBudgetTokens,
        latencyMs,
      });
    });
  }

  handleSocialPacket(event) {
    this.interceptor.onSocialPacket(event);
  }

  handleChatResponse(payload) {
    onChatResponse(this.api, payload);
  }

  shutdown() {
    this.scheduler.cancelAll();
  }

  status() {
    return {
      ...this.chain.status(),
      pendingReplies: this.scheduler.pendingCount(),
      citizens: this.interceptor.citizens.size,
    };
  }
}

module.exports = { Gateway, createMemoryStore };
