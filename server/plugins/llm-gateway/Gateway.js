// Gateway -- orchestration for llm:chat-request -> llm:chat-response.
//
// Flow: llm:chat-request { citizenUsername, requesterUsername, text, channel }
//   1. look up citizen (interceptor registry) + memory (card, notes, history)
//   2. build token-lean prompt (PromptBuilder)
//   3. run the provider chain (Cerebras -> Gemini -> Groq); on total failure,
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
const { buildPrompt } = require("./PromptBuilder");
const { TypingScheduler } = require("./TypingScheduler");
const { ChatInterceptor } = require("./ChatInterceptor");
const { onChatResponse } = require("./Mouth");

const SQLITE_DB_PATH = process.env.LLM_GATEWAY_DB ?? "";

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
    const { citizenUsername, requesterUsername, text, channel } = payload ?? {};
    if (!citizenUsername || !requesterUsername || !text) return;

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
    });

    const result = await this.chain.complete(prompt);
    if (!result.ok || !result.text) {
      // Everyone is down or unconfigured: stay silent. No retry storm.
      console.info(
        `[llm-gateway] no reply for ${citizenUsername} <- ${requesterUsername} (${result.reason})`
      );
      return;
    }

    const reply = result.text.slice(0, 480);
    await this.memory.pushExchange(citizenUsername, requesterUsername, text, reply);

    const latencyMs = Date.now() - startedAt;
    this.scheduler.schedule(citizenUsername, requesterUsername, reply, () => {
      this.api.emitCustomEvent("llm:chat-response", {
        citizenUsername,
        requesterUsername,
        text: reply,
        channel,
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
