// Cerebras -- PRIMARY provider in the chain.
// Free tier: 1M tokens/day, 8K context cap, ~30 RPM.
// API is OpenAI-compatible: https://api.cerebras.ai/v1/chat/completions
// STUBBED until CEREBRAS_API_KEY is set and LLM_GATEWAY_LIVE=1.

const { LlmProvider } = require("./BaseProvider");

const ENDPOINT = "https://api.cerebras.ai/v1/chat/completions";

class CerebrasProvider extends LlmProvider {
  constructor() {
    super({ name: "cerebras", apiKeyEnv: "CEREBRAS_API_KEY", defaultRpm: 30 });
    this.model = process.env.CEREBRAS_MODEL || "llama-3.3-70b";
  }

  async callApi({ system, user, maxTokens }) {
    const data = await this.postJson(
      ENDPOINT,
      {
        model: this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_completion_tokens: maxTokens,
        temperature: 0.9,
      },
      { Authorization: `Bearer ${this.apiKey}` }
    );
    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";
    const usage = data?.usage ?? {};
    return {
      ok: true,
      text,
      tokensUsed: (usage.total_tokens ?? 0) || undefined,
    };
  }
}

module.exports = { CerebrasProvider };
