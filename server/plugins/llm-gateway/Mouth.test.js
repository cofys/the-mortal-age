// Tests for the LLM mouth name-strip + prompt fixes.
// Plain node, no framework. Run: node server/plugins/llm-gateway/Mouth.test.js
// (from repo root)
const assert = require("node:assert/strict");
const { speakPublic, speakPrivate } = require("./Mouth");
const { WORLD_GROUNDING, buildSpeakPrompt } = require("./PromptBuilder");

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}: ${e.message}`);
  }
}

function mockApi() {
  return { core: { World: { getNearbyPlayersForUpdate: () => [] }, Misc: { textPack: (s) => s } } };
}

function mockBot(username, displayName) {
  const spoken = [];
  return {
    spoken,
    getUsername: () => username,
    getAttribute: (k) => (k === "character:display-name" ? displayName : undefined),
    getIndex: () => 7,
    forceChat: (line) => spoken.push(line),
    getLocalPlayers: () => [],
  };
}

function mockRequester() {
  const sent = [];
  return {
    sent,
    getPacketSender: () => ({
      sendPrivateMessage: (bot, packed, len) => sent.push({ packed, len }),
    }),
  };
}

// ---- speakPublic: name-strip ----
test("strips full display-name prefix from public line", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  speakPublic(api, bot, "Ora Nettle: Ah, a fellow traveler! Welcome, dear");
  assert.equal(bot.spoken.length, 1);
  assert.ok(!bot.spoken[0].startsWith("Ora Nettle"), `got: ${bot.spoken[0]}`);
  assert.ok(bot.spoken[0].includes("fellow traveler"));
});

test("strips first-name-only prefix", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  speakPublic(api, bot, "Ora: hello there");
  assert.equal(bot.spoken.length, 1);
  assert.equal(bot.spoken[0], "hello there");
});

test("leaves clean lines untouched", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  speakPublic(api, bot, "Morning! Lovely day.");
  assert.equal(bot.spoken.length, 1);
  assert.equal(bot.spoken[0], "Morning! Lovely day.");
});

test("drops message that is only a name prefix", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  speakPublic(api, bot, "Ora Nettle:");
  assert.equal(bot.spoken.length, 0);
});

test("falls back to username when no display name", () => {
  const api = mockApi();
  const bot = mockBot("Bob", undefined);
  speakPublic(api, bot, "Bob: hey");
  assert.equal(bot.spoken.length, 1);
  assert.equal(bot.spoken[0], "hey");
});

// ---- speakPrivate: name-strip ----
test("strips name prefix from private message", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  const requester = mockRequester();
  speakPrivate(api, bot, requester, "Ora Nettle: meet me at the bank");
  assert.equal(requester.sent.length, 1);
  assert.ok(!requester.sent[0].packed.startsWith("Ora Nettle"), `got: ${requester.sent[0].packed}`);
  assert.ok(requester.sent[0].packed.includes("meet me at the bank"));
});

test("private message without prefix passes through", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  const requester = mockRequester();
  speakPrivate(api, bot, requester, "sure thing");
  assert.equal(requester.sent.length, 1);
  assert.equal(requester.sent[0].packed, "sure thing");
});

// ---- PromptBuilder: no char-count straitjacket ----
test("WORLD_GROUNDING drops the 60-char limit", () => {
  assert.ok(!WORLD_GROUNDING.includes("60 characters"), "still mentions 60 characters");
  assert.ok(!WORLD_GROUNDING.toLowerCase().includes("under 60"), "still has under-60");
});

test("WORLD_GROUNDING allows 1-2 sentences and bans name-first", () => {
  assert.ok(WORLD_GROUNDING.includes("1-2 short sentences"), "missing 1-2 sentences");
  assert.ok(
    WORLD_GROUNDING.toLowerCase().includes("never start your message with your own name"),
    "missing name-first ban"
  );
});

test("buildSpeakPrompt strings drop Under-60", () => {
  const card = "A cheerful fisher.";
  const forPlayer = buildSpeakPrompt({ card, toName: "Liam", toKind: "player", citizenName: "Ora Nettle" });
  const forCitizen = buildSpeakPrompt({ card, toName: "Bob", toRole: "miner", citizenName: "Ora Nettle" });
  for (const p of [forPlayer, forCitizen]) {
    assert.ok(!p.user.includes("60 characters"), `user still has 60 chars: ${p.user}`);
    assert.ok(!p.system.includes("60 characters"), "system still has 60 chars");
    assert.ok(p.user.includes("1-2 short sentences"), `missing 1-2: ${p.user}`);
  }
});

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("all Mouth/PromptBuilder tests passed");
}
