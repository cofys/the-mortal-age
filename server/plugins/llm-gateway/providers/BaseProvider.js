// Base class for the llm-gateway provider chain.
//
// All providers are STUBBED by default: they no-op with a NEEDS_API_KEY marker
// until Jon creates the free-tier keys and sets the matching env var.
// The gateway boots and runs fine with zero providers configured -- citizen bots
// simply stay silent (silence is free and human).
//
// To go live (after keys exist): set the provider's <X>_API_KEY env var AND
// LLM_GATEWAY_LIVE=1. Each provider then makes a real HTTPS call shaped exactly
// like its free-tier chat API. Never logs or prints key material.

const LIVE = (process.env.LLM_GATEWAY_LIVE ?? "0") === "1";

// What an LLM provider needs to say a thing. `system` is the personality card +
// world grounding + player notes; `user` is the truncated history + the new line.
class LlmProvider {
  constructor({ name, apiKeyEnv, defaultRpm }) {
    this.name = name;
    this.apiKeyEnv = apiKeyEnv;
    this.rpm = Number(process.env[`${name.toUpperCase()}_RPM`]) || defaultRpm;
    this._keyWarned = false;
  }

  get apiKey() {
    return process.env[this.apiKeyEnv] || "";
  }

  get configured() {
    return this.apiKey.length > 0;
  }

  // Never logs the key. A missing key is a normal operating state, not an error.
  needsApiKey() {
    if (!this._keyWarned) {
      this._keyWarned = true;
      console.info(`[llm-gateway] provider ${this.name}: NEEDS_API_KEY (${this.apiKeyEnv} not set) -- staying silent`);
    }
    return { ok: false, reason: "NEEDS_API_KEY", retryable: false, provider: this.name };
  }

  // Shared gate: missing key -> no-op marker; LIVE off -> stub notice; else call.
  async complete(request) {
    if (!this.configured) return this.needsApiKey();
    if (!LIVE) {
      return {
        ok: false,
        reason: "STUBBED",
        retryable: false,
        provider: this.name,
        detail: `Key present but LLM_GATEWAY_LIVE!=1; set it to 1 to make real calls.`,
      };
    }
    try {
      return await this.callApi(request);
    } catch (error) {
      return {
        ok: false,
        reason: error.status === 429 ? "RATE_LIMITED" : "ERROR",
        status: error.status,
        retryable: error.status === 429 || error.status >= 500,
        provider: this.name,
        detail: error.message,
      };
    }
  }

  // Implemented per provider below. Must resolve to
  // { ok: true, text, tokensUsed } -- tokensUsed is a rough estimate.
  // Throw { status, message } on HTTP failure.
  async callApi(_request) {
    throw new Error(`${this.name}: callApi not implemented (stubbed)`);
  }

  // Never include key material in thrown errors.
  async postJson(url, body, headers = {}) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 200);
      throw { status: response.status, message: `${this.name} HTTP ${response.status}: ${snippet}` };
    }
    return response.json();
  }
}

module.exports = { LlmProvider, LLM_GATEWAY_LIVE: LIVE };
