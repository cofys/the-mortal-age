"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPrompt,
  buildSpeakPrompt,
  WORLD_GROUNDING,
  MAX_OUTPUT_TOKENS,
  MAX_CARD_CHARS,
} = require("./PromptBuilder");

test("MAX_OUTPUT_TOKENS allows ~2 sentences of substance (32)", () => {
  assert.equal(MAX_OUTPUT_TOKENS, 32);
});

test("WORLD_GROUNDING demands specificity, not generic greetings", () => {
  assert.match(WORLD_GROUNDING, /be specific/i);
  assert.match(WORLD_GROUNDING, /have opinions/i);
  assert.match(WORLD_GROUNDING, /never give a generic greeting/i);
  assert.match(WORLD_GROUNDING, /never start your message with your own name/i);
});

test("WORLD_GROUNDING does not impose a character limit", () => {
  assert.doesNotMatch(WORLD_GROUNDING, /60 characters/);
  assert.doesNotMatch(WORLD_GROUNDING, /under \d+ characters/i);
});

test("buildPrompt uses MAX_OUTPUT_TOKENS", () => {
  const prompt = buildPrompt({
    card: "test card",
    notes: [],
    history: [],
    message: "hello",
    citizenName: "Test Citizen",
  });
  assert.equal(prompt.maxTokens, 32);
  assert.equal(prompt.outputTokens, 32);
});

test("buildPrompt includes specificity instructions in system", () => {
  const prompt = buildPrompt({
    card: "test card",
    notes: [],
    history: [],
    message: "what are you up to?",
    citizenName: "Test Citizen",
  });
  assert.match(prompt.system, /be specific/i);
});

test("buildSpeakPrompt uses MAX_OUTPUT_TOKENS", () => {
  const prompt = buildSpeakPrompt({
    card: "test card",
    toName: "Jon",
    toKind: "player",
    citizenName: "Test Citizen",
  });
  assert.equal(prompt.maxTokens, 32);
});

test("personality card still clamped", () => {
  const longCard = "x".repeat(1000);
  const prompt = buildPrompt({
    card: longCard,
    notes: [],
    history: [],
    message: "hi",
    citizenName: "Test",
  });
  // Card should be clamped to MAX_CARD_CHARS (480)
  assert.ok(prompt.system.length < 1000 + 500);
});
