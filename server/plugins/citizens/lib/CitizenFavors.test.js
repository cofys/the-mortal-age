// CitizenFavors unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenFavors.test.js (plain node)
const assert = require("node:assert/strict");
const Favors = require("./CitizenFavors");
const { getMemory } = require("./CitizenMemory");

function fresh() {
  getMemory().resetForTests();
  Favors.getFavorStore().resetForTests();
  return Favors.getFavorStore();
}

function mockInventory(seed = {}) {
  const amounts = { ...seed };
  return {
    getAmount: (id) => amounts[id] ?? 0,
    deleteNumber: (id, qty) => {
      amounts[id] = Math.max(0, (amounts[id] ?? 0) - qty);
    },
    adds: (id, qty) => {
      amounts[id] = (amounts[id] ?? 0) + qty;
    },
    _amounts: amounts,
  };
}

function mockPlayer(name, invSeed = {}) {
  const said = [];
  const inv = mockInventory(invSeed);
  return {
    getUsername: () => name,
    getInventory: () => inv,
    sendMessage: (m) => said.push(m),
    _said: said,
  };
}

function mockBot(name, invSeed = {}) {
  const chats = [];
  const inv = mockInventory(invSeed);
  return {
    getUsername: () => name,
    getInventory: () => inv,
    forceChat: (m) => chats.push(m),
    getPosition: () => ({ getX: () => 3200, getY: () => 3200 }),
    _chats: chats,
    _inv: inv,
  };
}

function meet(citizen, player, n = 1) {
  for (let i = 0; i < n; i++) getMemory().recordMeeting(citizen, player);
}

// --- accept / decline / ignore ---
{
  const s = fresh();
  meet("Maren", "Dave");
  const favor = {
    id: "maren|dave|1",
    citizen: "Maren",
    citizenKey: "maren",
    player: "Dave",
    playerKey: "dave",
    kind: Favors.FAVOR_FETCH,
    itemId: 1511,
    itemName: "Logs",
    qty: 5,
    reward: 75,
    state: Favors.ASKED,
    askedAt: Date.now(),
    acceptedAt: 0,
    guardTicks: 0,
  };
  s.add(favor);
  const accepted = Favors.acceptFavor("Maren", "Dave");
  assert.ok(accepted, "yes accepts the pending ask");
  assert.equal(accepted.state, Favors.ACCEPTED);
  assert.ok(getMemory().getEntry("Maren", "Dave").tone >= 1, "accept warms tone");

  const none = Favors.acceptFavor("Maren", "Dave");
  assert.equal(none, null, "no double-accept");

  const favor2 = {
    ...favor,
    id: "maren|dave|2",
    state: Favors.ASKED,
    askedAt: Date.now(),
  };
  s.add(favor2);
  const declined = Favors.declineFavor("Maren", "Dave");
  assert.ok(declined, "no declines the pending ask");
  assert.equal(declined.state, Favors.DECLINED);
  assert.ok(getMemory().getEntry("Maren", "Dave").tone < 1, "decline cools tone");

  assert.equal(Favors.declineFavor("Maren", "Stranger"), null, "no ask, no decline");
}

// --- fetch completion hands over items and pays ---
{
  fresh();
  meet("Maren", "Dave");
  const s = Favors.getFavorStore();
  const player = mockPlayer("Dave", { 1511: 10, 995: 100 });
  const bot = mockBot("Maren", { 995: 5000 });
  const favor = {
    id: "maren|dave|1",
    citizen: "Maren",
    citizenKey: "maren",
    player: "Dave",
    playerKey: "dave",
    kind: Favors.FAVOR_FETCH,
    itemId: 1511,
    itemName: "Logs",
    qty: 5,
    reward: 75,
    state: Favors.ACCEPTED,
    askedAt: Date.now(),
    acceptedAt: Date.now(),
    guardTicks: 0,
  };
  s.add(favor);
  const done = Favors.attemptComplete("Maren", "Dave", bot, player);
  assert.equal(done.state, Favors.DONE, "fetch completes when the player has the goods");
  assert.equal(player.getInventory().getAmount(1511), 5, "items taken");
  assert.equal(player.getInventory().getAmount(995), 175, "reward paid");
  assert.equal(bot.getInventory().getAmount(995), 4925, "citizen paid out");
  assert.ok(getMemory().getEntry("Maren", "Dave").tone >= 2, "completion warms tone");
}

// --- fetch completion refuses without the goods ---
{
  fresh();
  meet("Maren", "Dave");
  const s = Favors.getFavorStore();
  const player = mockPlayer("Dave", { 1511: 2 });
  const bot = mockBot("Maren", { 995: 5000 });
  const favor = {
    id: "maren|dave|1",
    citizen: "Maren",
    citizenKey: "maren",
    player: "Dave",
    playerKey: "dave",
    kind: Favors.FAVOR_FETCH,
    itemId: 1511,
    itemName: "Logs",
    qty: 5,
    reward: 75,
    state: Favors.ACCEPTED,
    askedAt: Date.now(),
    acceptedAt: Date.now(),
    guardTicks: 0,
  };
  s.add(favor);
  const pending = Favors.attemptComplete("Maren", "Dave", bot, player);
  assert.equal(pending.state, Favors.ACCEPTED, "stays accepted without the goods");
  assert.equal(player.getInventory().getAmount(1511), 2, "nothing taken");
}

// --- coins favor records generosity ---
{
  fresh();
  meet("Maren", "Dave");
  const s = Favors.getFavorStore();
  const player = mockPlayer("Dave", { 995: 200 });
  const bot = mockBot("Maren", { 995: 10 });
  const favor = {
    id: "maren|dave|1",
    citizen: "Maren",
    citizenKey: "maren",
    player: "Dave",
    playerKey: "dave",
    kind: Favors.FAVOR_COINS,
    coins: 50,
    state: Favors.ACCEPTED,
    askedAt: Date.now(),
    acceptedAt: Date.now(),
    guardTicks: 0,
  };
  s.add(favor);
  Favors.attemptComplete("Maren", "Dave", bot, player);
  assert.equal(favor.state, Favors.DONE);
  assert.equal(player.getInventory().getAmount(995), 150, "coins taken");
  assert.equal(bot.getInventory().getAmount(995), 60, "citizen receives the gift");
  const entry = getMemory().getEntry("Maren", "Dave");
  assert.ok(entry.tone >= 3, "generosity warms tone a lot");
  assert.ok(entry.spent >= 50, "coins given count as spend");
}

// --- guard favor completes after standing close ---
{
  fresh();
  meet("Maren", "Dave");
  const s = Favors.getFavorStore();
  const player = mockPlayer("Dave", { 995: 0 });
  player.getPosition = () => ({ getX: () => 3202, getY: () => 3201 }); // 2-3 tiles away
  const bot = mockBot("Maren", { 995: 1000 });
  const favor = {
    id: "maren|dave|1",
    citizen: "Maren",
    citizenKey: "maren",
    player: "Dave",
    playerKey: "dave",
    kind: Favors.FAVOR_GUARD,
    state: Favors.ACCEPTED,
    askedAt: Date.now(),
    acceptedAt: Date.now(),
    guardTicks: 0,
  };
  s.add(favor);
  // Record shape expected by tickFavors: director records keyed by username.
  const record = { username: "Maren", role: "commoner" };
  const getBot = () => bot;
  const nearby = [player];
  for (let i = 0; i < Favors.GUARD_REQUIRED_TICKS - 1; i++) {
    Favors.tickFavors(record, getBot, nearby, {});
    assert.equal(favor.state, Favors.ACCEPTED, "not done before enough ticks");
  }
  Favors.tickFavors(record, getBot, nearby, {});
  assert.equal(favor.state, Favors.DONE, "guard favor completes on the tick");
  assert.equal(player.getInventory().getAmount(995), 50, "thank-you paid");
}

// --- spam gates ---
{
  const s = fresh();
  meet("Maren", "Dave");
  assert.ok(s.canAsk("Maren", "Dave"), "fresh pair can ask");
  s.recordAsk("Maren", "Dave");
  assert.ok(!s.canAsk("Maren", "Dave"), "pair cooldown blocks re-ask");
  assert.ok(!s.canAsk("Maren", "Zed"), "citizen throttle blocks any ask");
  // Daily budget respected.
  s.spendBudget("Maren", Favors.FAVOR_DAILY_BUDGET);
  assert.equal(s.budgetLeft("Maren"), 0, "budget drains");
  assert.ok(s.budgetLeft("Maren", Date.now() + 25 * 3600 * 1000) === Favors.FAVOR_DAILY_BUDGET, "budget resets next day");
}

// --- per-player cap ---
{
  const s = fresh();
  meet("Maren", "Dave");
  meet("Zed", "Dave");
  meet("Amy", "Dave");
  const mk = (c, p, i) => ({
    id: `${c.toLowerCase()}|${p.toLowerCase()}|${i}`,
    citizen: c,
    citizenKey: c.toLowerCase(),
    player: p,
    playerKey: p.toLowerCase(),
    kind: Favors.FAVOR_COINS,
    coins: 25,
    state: Favors.ASKED,
    askedAt: Date.now(),
    acceptedAt: 0,
    guardTicks: 0,
  });
  s.add(mk("Maren", "Dave", 1));
  s.add(mk("Zed", "Dave", 2));
  assert.ok(!s.canAsk("Amy", "Dave"), "player at cap gets no third ask");
  s.finish("maren|dave|1", Favors.DECLINED);
  assert.ok(s.canAsk("Amy", "Dave"), "declined favors free the slot");
}

console.log("CitizenFavors.test.js: all checks passed");
