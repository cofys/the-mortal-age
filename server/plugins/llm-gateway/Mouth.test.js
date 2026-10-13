// Tests for the LLM mouth: name-strip, the public-channel delegation to
// CitizenSayPublic.sayPublic, the private channel, and the prompt fixes.
// Plain node, no framework. Run: node server/plugins/llm-gateway/Mouth.test.js
// (from repo root)
const assert = require("node:assert/strict");
const { speakPublic, speakPrivate } = require("./Mouth");
const {
  resetForTests: resetSayPublic,
  setChunkScheduler,
} = require("../citizens/chat/CitizenSayPublic");
const { WORLD_GROUNDING, buildSpeakPrompt } = require("./PromptBuilder");

let failures = 0;
function test(name, fn) {
  try {
    resetSayPublic(); // isolate throttle + anti-repeat memory between tests
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

/** A nearby real player who hears public chat. */
function mockHearer() {
  const heard = [];
  return {
    heard,
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getUsername: () => "listener",
    getIndex: () => 42,
    getRelations: () => ({ canReceivePublicChatFrom: () => true }),
    getPacketSender: () => ({
      sendPublicChat: (line, from, index) => heard.push({ line, from, index }),
    }),
  };
}

// ---- speakPublic delegates to sayPublic: name-strip ----
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

// ---- speakPublic delegates to sayPublic: delegation semantics ----
test("chunks long replies at 80-char word boundaries", () => {
  setChunkScheduler((fn) => fn()); // run continuation chunks synchronously
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  const text = "a".repeat(40) + " " + "b".repeat(40) + " " + "c".repeat(68);
  speakPublic(api, bot, text);
  assert.equal(bot.spoken.length, 3);
  for (const line of bot.spoken) assert.ok(line.length <= 80, `line too long: ${line}`);
  assert.equal(bot.spoken.join(" "), text); // word boundaries preserved, nothing cut mid-word
  setChunkScheduler(null); // back to default async delivery
});

test("collapses newlines and extra whitespace before delegating", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  speakPublic(api, bot, "hello\n\nthere   friend");
  assert.equal(bot.spoken.length, 1);
  assert.equal(bot.spoken[0], "hello there friend");
});

test("returns false with no nearby players but still speaks overhead", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  const result = speakPublic(api, bot, "Anyone out there?");
  assert.equal(result, false); // nobody's chat box got it...
  assert.equal(bot.spoken.length, 1); // ...but the overhead bubble still fires
});

test("falls under sayPublic's 8s chat-box throttle", () => {
  const api = mockApi();
  const bot = mockBot("oranettle", "Ora Nettle");
  const hearer = mockHearer();
  bot.getLocalPlayers = () => [hearer];
  const first = speakPublic(api, bot, "First line.");
  assert.equal(first, true);
  assert.equal(hearer.heard.length, 1);
  assert.equal(hearer.heard[0].line, "First line.");
  const second = speakPublic(api, bot, "Second line.");
  assert.equal(second, false); // throttled: stays silent entirely
  assert.equal(bot.spoken.length, 1);
  assert.equal(hearer.heard.length, 1);
});

// ---- speakPrivate: name-strip (unchanged path) ----
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

test("WORLD_GROUNDING demands one short sentence and bans name-first", () => {
  assert.ok(WORLD_GROUNDING.includes("one short sentence"), "missing one-sentence rule");
  assert.ok(
    WORLD_GROUNDING.toLowerCase().includes("never start your message with your own name"),
    "missing name-first ban"
  );
});

test("buildSpeakPrompt strings demand one short sentence", () => {
  const card = "A cheerful fisher.";
  const forPlayer = buildSpeakPrompt({ card, toName: "Liam", toKind: "player", citizenName: "Ora Nettle" });
  const forCitizen = buildSpeakPrompt({ card, toName: "Bob", toRole: "miner", citizenName: "Ora Nettle" });
  for (const p of [forPlayer, forCitizen]) {
    assert.ok(!p.user.includes("60 characters"), `user still has 60 chars: ${p.user}`);
    assert.ok(!p.system.includes("60 characters"), "system still has 60 chars");
    assert.ok(p.user.includes("One short sentence"), `missing one-sentence: ${p.user}`);
  }
});

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
} else {
  console.log("all Mouth/PromptBuilder tests passed");
}
