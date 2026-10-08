"use strict";

// CitizenGifts unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenGifts.test.js (plain node)
const assert = require("node:assert/strict");
const Gifts = require("./CitizenGifts");
const { getMemory, MOMENT_GIFT } = require("./lib/CitizenMemory");

const T0 = 1_800_000_000_000; // fixed anchor, avoids Date.now races

function mockInventory(seed = {}) {
  const amounts = { ...seed };
  const inv = {
    getAmount: (id) => amounts[id] ?? 0,
    getFreeSlots: () => 27,
    deleteNumber: (id, qty) => {
      amounts[id] = Math.max(0, (amounts[id] ?? 0) - qty);
      return inv; // production deleteNumber is chainable (see donateBond)
    },
    refreshItems: () => {},
    adds: (id, qty) => {
      amounts[id] = (amounts[id] ?? 0) + qty;
    },
    _amounts: amounts,
  };
  return inv;
}

function mockItem(id, amount = 1, dropable = true) {
  return {
    getId: () => id,
    getAmount: () => amount,
    isDropable: () => dropable,
    getDefinition: () => ({ getName: () => `Item${id}` }),
  };
}

function mockPlayer(name, invSeed = {}) {
  const said = [];
  const inv = mockInventory(invSeed);
  return {
    getUsername: () => name,
    getHostAddress: () => "127.0.0.1",
    isPlayerBot: () => false,
    getInventory: () => inv,
    sendMessage: (m) => said.push(m),
    _said: said,
    _inv: inv,
  };
}

function mockCitizenBot(name, invSeed = {}) {
  const chats = [];
  const inv = mockInventory(invSeed);
  return {
    getUsername: () => name,
    getHostAddress: () => "bot",
    isPlayerBot: () => true,
    getInventory: () => inv,
    forceChat: (m) => chats.push(m),
    _chats: chats,
    _inv: inv,
  };
}

function fresh() {
  getMemory().resetForTests();
}

// --- classifyGift: pure accept / decline / ignore decisions ---
{
  fresh();
  assert.equal(Gifts.classifyGift(mockItem(995, 100), {}), "accept", "coins are accepted");
  assert.equal(Gifts.classifyGift(mockItem(995, 100), { handled: true }), null, "claimed events are ignored");
  assert.equal(Gifts.classifyGift(null, {}), null, "no item means no gift");
  assert.equal(Gifts.classifyGift(mockItem(1337, 1, false), {}), "decline", "bound items are declined");
  console.log("classifyGift: PASS");
}

// --- fillLine: template interpolation ---
{
  assert.equal(
    Gifts.fillLine("Thanks for the {item}, {name}.", { name: "Jon", item: "Logs" }),
    "Thanks for the Logs, Jon."
  );
  assert.equal(Gifts.fillLine("No tokens here.", { name: "Jon", item: "Logs" }), "No tokens here.");
  console.log("fillLine: PASS");
}

// --- isThanksAllowed: voice cooldown gates with injectable time ---
{
  fresh();
  assert.equal(Gifts.isThanksAllowed("CitA", "PlayerA", T0), true, "fresh pair is allowed");
  // Record a thanks at T0 through the handler's own path below, then check gates.
  console.log("isThanksAllowed (pre-thanks): PASS");
}

// --- full accept path: item moves, citizen thanks, memory warms ---
{
  fresh();
  const player = mockPlayer("Jon", { 1511: 5 });
  const bot = mockCitizenBot("Maren");
  const event = { player, target: bot, item: mockItem(1511, 5), handled: false };
  Gifts.onGiftGiven(event, { itemName: (id) => (id === 1511 ? "Logs" : `item ${id}`) }, T0);

  assert.equal(event.handled, true, "gift claims the event");
  assert.equal(player._inv.getAmount(1511), 0, "player's stack is gone");
  assert.equal(bot._inv.getAmount(1511), 5, "citizen genuinely receives the stack");
  assert.equal(bot._chats.length, 1, "citizen says thanks once");
  assert.ok(bot._chats[0].includes("Jon"), "thanks names the giver");
  const filledThanks = ["warm", "neutral", "wry"].flatMap((v) =>
    Gifts.THANKS_LINES[v].map((l) => Gifts.fillLine(l, { name: "Jon", item: "Logs" }).slice(0, 120))
  );
  assert.ok(filledThanks.includes(bot._chats[0]), "thanks is a personality-flavored thanks line");
  assert.ok(player._said.some((m) => m.includes("Maren") && m.includes("Logs")), "player sees confirmation");

  const entry = getMemory().getEntry("Maren", "Jon");
  assert.ok(entry, "memory has an entry for the pair");
  assert.ok(entry.tone >= 1, "gift warms tone");
  assert.ok(
    (entry.moments ?? []).some((m) => m.kind === MOMENT_GIFT),
    "a gift moment is recorded for the LLM mouth"
  );

  // Second gift right away: still accepted and moves, but the voice is quiet.
  const rich = mockPlayer("Jon", { 995: 50 });
  const bot2 = mockCitizenBot("Maren2");
  const event2 = { player: rich, target: bot2, item: mockItem(995, 50), handled: false };
  Gifts.onGiftGiven(
    event2,
    { itemName: () => "Coins" },
    T0 + 1000
  );
  assert.equal(event2.handled, true, "second gift still claims the event");
  assert.equal(bot2._inv.getAmount(995), 50, "second gift still moves");
  assert.equal(bot2._chats.length, 0, "voice stays quiet inside the cooldown");
  assert.ok(event2.handled, "sanity: event2 was the one claimed");
  console.log("accept path: PASS");
}

// --- wry personality gets wry thanks ---
{
  fresh();
  const player = mockPlayer("Jon", { 1511: 1 });
  const bot = mockCitizenBot("Grumb");
  Gifts.onGiftGiven(
    { player, target: bot, item: mockItem(1511, 1), handled: false },
    { itemName: () => "Logs", personality: { traits: ["gruff", "proud"] } },
    T0 + 10 * 60 * 1000
  );
  assert.equal(bot._chats.length, 1, "grump thanks exactly once");
  assert.ok(
    Gifts.THANKS_LINES.wry.some((l) => bot._chats[0] === Gifts.fillLine(l, { name: "Jon", item: "Logs" }).slice(0, 120)),
    "gruff citizen uses a wry line"
  );
  console.log("personality voice: PASS");
}

// --- decline path: bound item stays, citizen says so ---
{
  fresh();
  const player = mockPlayer("Jon", { 1337: 1 });
  const bot = mockCitizenBot("Maren");
  const event = { player, target: bot, item: mockItem(1337, 1, false), handled: false };
  Gifts.onGiftGiven(event, { itemName: () => "Bound Blade" }, T0 + 20 * 60 * 1000);

  assert.equal(event.handled, true, "decline claims the event to stop double-messages");
  assert.equal(player._inv.getAmount(1337), 1, "bound item never leaves the player");
  assert.equal(bot._inv.getAmount(1337), 0, "citizen never receives a bound item");
  assert.equal(bot._chats.length, 1, "citizen explains the refusal");
  assert.ok(player._said.some((m) => m.includes("can't accept")), "player is told why");
  const entry = getMemory().getEntry("Maren", "Jon");
  assert.ok(!entry || !(entry.moments ?? []).some((m) => m.kind === MOMENT_GIFT), "no gift moment for a refusal");
  console.log("decline path: PASS");
}

// --- non-citizens and bots never trigger gifts ---
{
  fresh();
  const player = mockPlayer("Jon", { 1511: 1 });
  const realTarget = mockPlayer("Dave", {});
  const event = { player, target: realTarget, item: mockItem(1511, 1), handled: false };
  Gifts.onGiftGiven(event, { itemName: () => "Logs" }, T0 + 30 * 60 * 1000);
  assert.equal(event.handled, false, "item used on a real player is untouched");
  assert.equal(player._inv.getAmount(1511), 1, "nothing moves between real players");

  const botSource = mockCitizenBot("BotBob");
  const citizen = mockCitizenBot("Maren");
  const event2 = { player: botSource, target: citizen, item: mockItem(1511, 1), handled: false };
  Gifts.onGiftGiven(event2, { itemName: () => "Logs" }, T0 + 31 * 60 * 1000);
  assert.equal(event2.handled, false, "bot-to-bot use is untouched");
  console.log("guard rails: PASS");
}

// --- full hands: citizen keeps nothing, player is told ---
{
  fresh();
  const player = mockPlayer("Jon", { 1511: 1 });
  const bot = mockCitizenBot("Maren");
  bot.getInventory = () => ({
    ...mockInventory({}),
    getFreeSlots: () => 0,
  });
  const event = { player, target: bot, item: mockItem(1511, 1), handled: false };
  Gifts.onGiftGiven(event, { itemName: () => "Logs" }, T0 + 40 * 60 * 1000);
  assert.equal(event.handled, true, "full-hands claims the event");
  assert.equal(player._inv.getAmount(1511), 1, "item stays with the player");
  assert.ok(player._said.some((m) => m.includes("hands are full")), "player is told");
  assert.equal(bot._chats.length, 0, "no thanks when nothing was given");
  console.log("full hands: PASS");
}

console.log("ALL CITIZENGIFTS TESTS PASSED");
