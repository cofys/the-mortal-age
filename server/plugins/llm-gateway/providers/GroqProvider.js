// Groq -- OpenAI-compatible chat completions.
// Free tier models are separate quota buckets (see ProviderChain.js SLOT_DEFS).
// STUBBED until GROQ_API_KEY is set and LLM_GATEWAY_LIVE=1.

const { LlmProvider } = require("./BaseProvider");

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

class GroqProvider extends LlmProvider {
  constructor(model) {
    super({ name: "groq", apiKeyEnv: "GROQ_API_KEY", defaultRpm: 30 });
    // NOTE: llama-3.3-70b-versatile is GONE from Groq's free tier (2026-10-06).
    this.model = model || process.env.GROQ_MODEL || "openai/gpt-oss-120b";
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
