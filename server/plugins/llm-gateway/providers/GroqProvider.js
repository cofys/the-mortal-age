// Groq -- LAST in the chain (final fallback).
// Free tier, OpenAI-compatible: https://api.groq.ai/openai/v1/chat/completions
// STUBBED until GROQ_API_KEY is set and LLM_GATEWAY_LIVE=1.

const { LlmProvider } = require("./BaseProvider");

const ENDPOINT = "https://api.groq.ai/openai/v1/chat/completions";

class GroqProvider extends LlmProvider {
  constructor() {
    super({ name: "groq", apiKeyEnv: "GROQ_API_KEY", defaultRpm: 30 });
    this.model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
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
        max_tokens: maxTokens,
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

module.exports = { GroqProvider };
