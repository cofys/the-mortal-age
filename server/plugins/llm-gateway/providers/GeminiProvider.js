// Gemini -- SECOND in the chain (fallback when Cerebras is unconfigured / down).
// Free tier via AI Studio key; text API:
// https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=...
// The key travels as a query param per Google's API (never logged -- see BaseProvider).
// STUBBED until GEMINI_API_KEY is set and LLM_GATEWAY_LIVE=1.

const { LlmProvider } = require("./BaseProvider");

class GeminiProvider extends LlmProvider {
  constructor() {
    super({ name: "gemini", apiKeyEnv: "GEMINI_API_KEY", defaultRpm: 15 });
    this.model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  }

  async callApi({ system, user, maxTokens }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      this.model
    )}:generateContent`;
    const data = await this.postJson(
      url,
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 },
      },
      { "x-goog-api-key": this.apiKey }
    );
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim();
    const usage = data?.usageMetadata ?? {};
    return {
      ok: true,
      text,
      tokensUsed:
        (usage.totalTokenCount ?? 0) || undefined,
    };
  }
}

module.exports = { GeminiProvider };
