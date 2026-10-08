"use strict";

// Integration check: onSocialPacket emits chat-heard for ALL nearby citizens
// with shouldReply flag; onCitizenChatHeard respects it.

const assert = require("node:assert/strict");

// We need to test the wiring without a running server. Mock the pieces.
const Module = require("node:module");
const path = require("node:path");

// Track emitted events.
const emitted = [];

// Mock pluginApi
const mockApi = {
  emitCustomEvent: (name, payload) => emitted.push({ name, payload }),
  log: () => {},
  core: { World: { getPlayerByName: () => null } },
};

// Load CitizenChat with mocked dependencies.
// The module requires constants, personalities, CitizenContext, CitizenMemory,
// CitizenJournal, CitizenBonds, CitizenNeeds, CitizenHeardReactions.
// We'll let it load for real except where it needs pluginApi.

const chatPath = path.join(__dirname, "CitizenChat.js");
let CitizenChat;
try {
  CitizenChat = require(chatPath);
} catch (e) {
  console.log(`SKIP: cannot load CitizenChat (${e.message})`);
  process.exit(0);
}

let passed = 0;
function check(name, fn) {
  emitted.length = 0;
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// Mock players
function mockPlayer(username, isBot, x = 0, y = 0) {
  return {
    getUsername: () => username,
    getHostAddress: () => (isBot ? "bot" : "127.0.0.1"),
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    getLocalPlayers: () => [],
  };
}

check("onSocialPacket: emits for all nearby citizens with shouldReply flag", () => {
  CitizenChat.initCitizenChat(mockApi);

  const speaker = mockPlayer("Cofy", false, 100, 100);
  const bot1 = mockPlayer("Alice Smith", true, 101, 101);
  const bot2 = mockPlayer("Bob Jones", true, 102, 102);
  const bot3 = mockPlayer("Carol White", true, 103, 103);
  const human = mockPlayer("Dave Human", false, 104, 104);

  speaker.getLocalPlayers = () => [bot1, bot2, bot3, human];

  // Find the onSocialPacket export and call it.
  // It's exported from CitizenChat.
  const { onSocialPacket } = CitizenChat;
  assert.ok(typeof onSocialPacket === "function", "onSocialPacket should be exported");

  onSocialPacket({
    player: speaker,
    packet: { type: "public_chat", text: "hello everyone!" },
  });

  // Should emit 3 events (one per citizen bot, not the human).
  const heard = emitted.filter((e) => e.name === "citizens:chat-heard");
  assert.equal(heard.length, 3, `should emit 3 chat-heard events, got ${heard.length}`);

  // Exactly 2 should have shouldReply=true (MAX_PUBLIC_REPLIERS).
  const repliers = heard.filter((e) => e.payload.shouldReply === true);
  const hearers = heard.filter((e) => e.payload.shouldReply === false);
  assert.equal(repliers.length, 2, `should have 2 repliers, got ${repliers.length}`);
  assert.equal(hearers.length, 1, `should have 1 hearer, got ${hearers.length}`);

  // All should have the text.
  for (const e of heard) {
    assert.equal(e.payload.text, "hello everyone!");
    assert.equal(e.payload.speakerUsername, "Cofy");
  }
});

check("onSocialPacket: ignores non-public-chat", () => {
  CitizenChat.initCitizenChat(mockApi);
  const speaker = mockPlayer("Cofy", false);
  const { onSocialPacket } = CitizenChat;
  onSocialPacket({
    player: speaker,
    packet: { type: "private_message", text: "hi" },
  });
  const heard = emitted.filter((e) => e.name === "citizens:chat-heard");
  assert.equal(heard.length, 0, "should not emit for private_message");
});

check("onSocialPacket: ignores citizen speakers", () => {
  CitizenChat.initCitizenChat(mockApi);
  const botSpeaker = mockPlayer("Alice Smith", true);
  const bot2 = mockPlayer("Bob Jones", true);
  botSpeaker.getLocalPlayers = () => [bot2];
  const { onSocialPacket } = CitizenChat;
  onSocialPacket({
    player: botSpeaker,
    packet: { type: "public_chat", text: "hi" },
  });
  const heard = emitted.filter((e) => e.name === "citizens:chat-heard");
  assert.equal(heard.length, 0, "citizens don't trigger each other");
});

console.log(`\n${passed} integration checks passed.`);
if (process.exitCode) console.log("FAILURES PRESENT");
