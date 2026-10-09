"use strict";

/**
 * CitizenFollowupSweep.test.js (chat) — regression test for the 05:00
 * seven-systems audit follow-up sweep, scope 2.
 *
 * kingdomIdOf(player) reads player.getAttribute(ATTR_KINGDOM_ID) off the
 * LIVE bot entity. Calling it with a bare username string (or a
 * { getUsername } stub) silently falls back to the first kingdom, so every
 * civillaw/tradeguild/status reply named the wrong kingdom. The canonical
 * seam is the roster record's real kingdomId.
 *
 * Run: node server/plugins/citizens/chat/CitizenFollowupSweep.test.js
 */

const assert = require("assert");
const path = require("path");

function stub(p, exports) {
  const abs = path.resolve(__dirname, p);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// --- top-of-file dependency stubs ---

stub("../lib/citizenVoice.js", {
  voiceFor: () => ({}),
  voiceLine: () => "",
});
stub("./CitizenSayPublic.js", { sayPublic: () => {} });
stub("../constants.js", {
  EVENT_LLM_CITIZEN_REGISTER: "llm:citizen-register",
  EVENT_LLM_CITIZEN_UNREGISTER: "llm:citizen-unregister",
  EVENT_LLM_CHAT_REQUEST: "llm:chat-request",
  EVENT_CITIZEN_CHAT_HEARD: "citizens:chat-heard",
  ROLE_MERCHANT: "merchant",
  ATTR_CITIZEN_PERSONALITY: "citizens:personality",
});
stub("../lib/personalities.js", { personalityCard: () => ({}) });
stub("./CitizenContext.js", { buildContext: () => ({}) });
stub("../lib/CitizenMemory.js", {
  getMemory: () => ({}),
  scoreTone: () => 0,
  GRUDGE_INSULT: "grudge",
  GOSSIP_INSULT: "gossip",
});
stub("../lib/CitizenJournal.js", {
  getJournal: () => ({ log: () => {}, recent: () => [], latelyLine: () => "" }),
});

// --- the canonical seam: real roster records with real kingdomIds ---

const roster = new Map([
  ["aldric stone", { username: "Aldric Stone", kingdomId: "keldagrim" }],
  ["beatrix vale", { username: "Beatrix Vale", kingdomId: "misthalin" }],
]);
stub("../director/CitizenDirector.js", {
  getDirector: () => ({ roster }),
});
stub("../lib/CitizenBonds.js", {
  normalizeName: (n) => String(n ?? "").trim().toLowerCase(),
});

// --- module under test ---

const { citizenKingdomId } = require("./CitizenChat");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("citizenKingdomId resolves the roster record's real kingdomId", () => {
  assert.strictEqual(citizenKingdomId("Aldric Stone"), "keldagrim");
  assert.strictEqual(citizenKingdomId("Beatrix Vale"), "misthalin");
});

test("citizenKingdomId does NOT fall back to the first kingdom for a string", () => {
  // The old bug: kingdomIdOf("Aldric Stone") silently returned KINGDOM_IDS[0].
  assert.notStrictEqual(citizenKingdomId("Aldric Stone"), "asgarnia");
});

test("citizenKingdomId returns null when no roster record exists", () => {
  assert.strictEqual(citizenKingdomId("Nobody Here"), null);
  assert.strictEqual(citizenKingdomId(""), null);
});

console.log(`\n${passed} passed`);
