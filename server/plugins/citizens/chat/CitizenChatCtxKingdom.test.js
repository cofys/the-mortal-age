"use strict";

/**
 * CitizenChatCtxKingdom.test.js — regression for the undeclared `ctx` in
 * handleSocialKeyword: seven keyword sites read `ctx?.kingdomId`, but
 * handleSocialKeyword(citizenUsername, speakerUsername, text) has no ctx
 * parameter, so Node throws ReferenceError. Each site sits in try/catch
 * returning false, so the handlers silently never answered. The fix uses
 * the module-level citizenKingdomId(citizenUsername) seam instead.
 *
 * FAIL-before: the cook-off handler throws ReferenceError inside its
 * try/catch, returns false, and onCitizenChatHeard falls through to an
 * `llm:chat-request` event (the cook-off libs are never consulted).
 * PASS-after: the handler answers (no LLM event) and routes to the
 * citizen's real kingdom from the roster.
 *
 * Run: node server/plugins/citizens/chat/CitizenChatCtxKingdom.test.js
 */

const assert = require("assert");
const path = require("path");

function stub(p, exports) {
  const abs = path.resolve(__dirname, p);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// --- top-of-file dependency stubs (same set as CitizenFollowupSweep) ---

stub("../lib/citizenVoice.js", {
  voiceFor: () => ({}),
  voiceLine: () => "",
});
const saidPublic = [];
stub("./CitizenSayPublic.js", { sayPublic: (player, text) => { saidPublic.push(text); } });
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

// --- cook-off lib stub: record which kingdom the handler asks about ---

const cookOffKingdoms = [];
stub("../lib/CitizenCookOffs.js", {
  openCookOff: (kingdomId) => {
    cookOffKingdoms.push(kingdomId);
    return { theme: "Mystery", mystery: "spice", entries: [], pot: 100 };
  },
  seasonOf: () => "season-1",
  rankingsFor: () => [],
});

// --- module under test ---

const { initCitizenChat, onCitizenChatHeard } = require("./CitizenChat");

let passed = 0;
function test(name, fn) {
  try {
    saidPublic.length = 0;
    cookOffKingdoms.length = 0;
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("cook-off handler answers instead of swallowing a ReferenceError", () => {
  const emitted = [];
  initCitizenChat({ emitCustomEvent: (name) => { emitted.push(name); } });
  onCitizenChatHeard({
    citizenUsername: "Aldric Stone",
    speakerUsername: "Jon",
    text: "when is the next cook-off?",
    shouldReply: true,
  });
  assert.ok(
    !emitted.includes("llm:chat-request"),
    `cook-off was NOT handled — fell through to LLM request (${JSON.stringify(emitted)})`
  );
});

test("cook-off handler routes to the citizen's real kingdom", () => {
  initCitizenChat({ emitCustomEvent: () => {} });
  onCitizenChatHeard({
    citizenUsername: "Aldric Stone",
    speakerUsername: "Jon",
    text: "when is the next cook-off?",
    shouldReply: true,
  });
  assert.deepStrictEqual(
    cookOffKingdoms,
    ["keldagrim"],
    `expected the handler to ask about keldagrim, saw ${JSON.stringify(cookOffKingdoms)}`
  );
});
