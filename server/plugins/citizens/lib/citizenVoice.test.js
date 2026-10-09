"use strict";

// citizenVoice unit checks — pure logic, no running server.
// Run: node lib/citizenVoice.test.js (from server/plugins/citizens)

const assert = require("node:assert/strict");
const {
  voiceFor,
  voiceLine,
  styleLine,
  voiceDirective,
} = require("./citizenVoice");

function personality(traits, speechStyle, vocabulary) {
  return { traits, speechStyle, vocabulary };
}

// --- voiceFor: register mapping -------------------------------------------

{
  const v = voiceFor(personality(["gruff", "dutiful"], "plain blunt words"));
  assert.equal(v.register, "terse", "gruff -> terse");
  assert.equal(v.exclaim, false, "terse never exclaims");
}

{
  const v = voiceFor(personality(["taciturn", "methodical"], "careful formal phrasing"));
  assert.equal(v.register, "terse", "taciturn -> terse");
}

{
  const v = voiceFor(personality(["suspicious", "proud"], "a slow drawl"));
  assert.equal(v.register, "terse", "suspicious -> terse");
}

{
  const v = voiceFor(personality(["chatty", "cheerful"], "rapid-fire chatter"));
  assert.equal(v.register, "warm", "chatty -> warm");
  assert.equal(v.exclaim, true, "warm exclaims");
}

{
  const v = voiceFor(personality(["easygoing", "dutiful"], "a slow drawl"));
  assert.equal(v.register, "warm", "easygoing -> warm");
}

{
  const v = voiceFor(personality(["proud", "devout"], "colorful flowery words"));
  assert.equal(v.register, "colorful", "flowery speech -> colorful");
}

{
  const v = voiceFor(personality(["dutiful", "methodical"], "careful formal phrasing"));
  assert.equal(v.register, "plain", "unmarked -> plain");
}

{
  // Determinism: same input, same output, every time.
  const p = personality(["gruff", "dutiful"], "plain blunt words");
  assert.deepEqual(voiceFor(p), voiceFor(p), "voiceFor is deterministic");
}

{
  // Null-safe.
  const v = voiceFor(null);
  assert.equal(v.register, "plain", "null personality -> plain");
  const v2 = voiceFor({});
  assert.equal(v2.register, "plain", "empty personality -> plain");
}

// --- voiceFor: lowercase ----------------------------------------------------

{
  const v = voiceFor(personality(["dutiful", "fidgety"], "rough street slang"));
  assert.equal(v.lowercase, true, "street slang -> lowercase");
}

{
  const v = voiceFor(personality(["gruff", "dutiful"], "plain blunt words"));
  assert.equal(v.lowercase, true, "gruff + blunt -> lowercase");
}

{
  const v = voiceFor(personality(["cheerful", "chatty"], "rapid-fire chatter"));
  assert.equal(v.lowercase, false, "warm -> not lowercase");
}

// --- voiceLine: pool selection -----------------------------------------------

{
  const pool = {
    plain: ["Hello there, traveller!"],
    terse: ["hey."],
  };
  const line = voiceLine({ register: "terse" }, pool, () => 0);
  assert.equal(line, "hey.", "terse picks terse variant");
}

{
  const pool = {
    plain: ["Hello there, traveller!"],
    terse: ["hey."],
  };
  const line = voiceLine({ register: "plain" }, pool, () => 0);
  assert.equal(line, "Hello there, traveller!", "plain picks plain variant");
}

{
  // Warm/colorful fall back to plain pool (styleLine adds flavor).
  const pool = { plain: ["Hello there!"] };
  const warm = voiceLine({ register: "warm", exclaim: true }, pool, () => 0);
  assert.equal(warm, "Hello there!", "warm falls back to plain");
  const colorful = voiceLine({ register: "colorful" }, pool, () => 0);
  assert.equal(colorful, "Hello there!", "colorful falls back to plain");
}

{
  // Legacy flat array pools don't crash (treated as no plain key -> fallback).
  const line = voiceLine({ register: "plain" }, { plain: ["x"] }, () => 0);
  assert.equal(line, "x", "single plain entry works");
}

{
  // Empty pool -> empty string, never throws.
  const line = voiceLine({ register: "terse" }, {}, () => 0);
  assert.equal(line, "", "empty pool -> empty string");
}

// --- styleLine: transforms ----------------------------------------------------

{
  assert.equal(
    styleLine({ register: "terse" }, "gz! nice!"),
    "gz. nice.",
    "terse: ! -> ."
  );
}

{
  assert.equal(
    styleLine({ register: "terse", lowercase: true }, "Gz! Nice Shot!"),
    "gz. nice shot.",
    "terse + lowercase"
  );
}

{
  assert.equal(
    styleLine({ register: "warm", exclaim: true }, "gz!"),
    "gz!",
    "warm keeps exclamation"
  );
}

{
  assert.equal(
    styleLine({ register: "plain" }, "Hello there!"),
    "Hello there!",
    "plain untouched"
  );
}

// --- voiceDirective: LLM card constraints --------------------------------------

{
  const d = voiceDirective(personality(["gruff", "dutiful"], "plain blunt words"));
  assert.ok(d.includes("1-6 words"), "terse directive mentions word count");
  assert.ok(d.includes("lowercase"), "directive mentions lowercase");
  assert.ok(d.includes("no exclamation"), "terse directive bans exclamations");
}

{
  const d = voiceDirective(personality(["chatty", "cheerful"], "rapid-fire chatter"));
  assert.ok(d.includes("exclamation marks"), "warm directive allows exclamations");
}

{
  const d = voiceDirective(personality(["dutiful", "methodical"], "careful formal phrasing"));
  assert.ok(d.includes("15 words"), "plain directive caps length");
}

{
  // Out-of-range rng must pick a valid line, never silence the speaker.
  const pool = { plain: ["alpha", "beta", "gamma"], terse: ["a", "b"] };
  const v = voiceFor(personality(["gruff"], "short clipped sentences"));
  assert.strictEqual(voiceLine(v, pool, () => 1.5), "b");
  assert.strictEqual(voiceLine(v, pool, () => 99), "b");
  assert.strictEqual(voiceLine(v, pool, () => -0.5), "a");
  const v2 = voiceFor(personality(["dutiful"], "plain blunt words"));
  assert.ok(["a", "b"].includes(voiceLine(v2, pool, () => 2.7)));
}

console.log("ALL CITIZENVOICE TESTS PASSED");
