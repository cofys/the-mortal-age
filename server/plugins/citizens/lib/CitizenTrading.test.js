// CitizenTrading unit checks — pure logic, no running server.
const assert = require("node:assert/strict");

const Trading = require("./CitizenTrading");
const { attachTradingInteraction, createTradingInteraction } = Trading;
const { resetForTests } = require("../chat/CitizenSayPublic");

resetForTests();

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function mockItem(entry) {
  return {
    getId: () => entry.id,
    getAmount: () => entry.amount,
    setAmount(a) {
      entry.amount = a;
      return this;
    },
    isTradeable: () => entry.tradeable !== false,
    getDefinition: () => ({ isStackable: () => entry.stackable !== false }),
    clone() {
      return mockItem({ ...entry });
    },
  };
}

/** In-memory item container with a faithful switchItem (moves items). */
function mockContainer(entries = []) {
  const items = entries.map((e) => ({ ...e }));
  return {
    _items: items,
    getItems() {
      return this._items.map((e) => (e ? mockItem(e) : null));
    },
    getValidItems() {
      return this._items.filter((e) => e && e.amount > 0).map(mockItem);
    },
    getAmount(id) {
      return this._items.reduce((s, e) => s + (e && e.id === id ? e.amount : 0), 0);
    },
    getFreeSlots() {
      return 28 - this._items.filter((e) => e && e.amount > 0).length;
    },
    containsNumber(id) {
      return this._items.some((e) => e && e.id === id && e.amount > 0);
    },
    refreshItems() {},
    _addItem(id, amount, stackable = true) {
      const ex = this._items.find((e) => e && e.id === id && e.stackable && stackable);
      if (ex) ex.amount += amount;
      else this._items.push({ id, amount, stackable, tradeable: true });
    },
    switchItem(to, item, sort, slot, refresh) {
      const cur = this._items[slot];
      if (!cur || cur.id !== item.getId()) return this;
      cur.amount -= item.getAmount();
      if (cur.amount <= 0) this._items[slot] = null;
      to._addItem(item.getId(), item.getAmount(), item.getDefinition().isStackable());
      return this;
    },
  };
}

function mockTrading({ calls = [], interact = null, container = null } = {}) {
  return {
    _calls: calls,
    getState: () => ({ isTrading: () => false }),
    requestTrade: (requester) => {
      calls.push(["requestTrade", requester?.getUsername?.()]);
      return true;
    },
    acceptTrade: () => {
      calls.push(["acceptTrade"]);
    },
    getInteract: () => interact,
    getContainer: () => container ?? mockContainer(),
  };
}

function mockBot({ name = "TestCitizen", attrs = {}, invEntries = [], trading = null } = {}) {
  const said = [];
  const inventory = mockContainer(invEntries);
  const t = trading ?? mockTrading();
  return {
    said,
    _inventory: inventory,
    _trading: t,
    isPlayerBot: () => true,
    getUsername: () => name,
    getAttribute: (k) => attrs[k],
    getPacketSender: () => ({ sendPublicChat: (text) => said.push(text) }),
    forceChat: (text) => said.push(text),
    getLocalPlayers: () => [],
    getInventory: () => inventory,
    getTrading: () => t,
  };
}

const WARE_ITEM = "citizens:ware-item";
const WARE_PRICE = "citizens:ware-price";
const WORK_KIND = "citizens:work-kind";
const PERSONALITY = "citizens:personality";
const BREAD = 2309;
const COINS = 995;

// Trade opens against a partner whose container we control.
function openTradeWith(bot, partnerContainer) {
  const partner = {
    getUsername: () => "Jon",
    isPlayerBot: () => false,
    getTrading: () => ({ getContainer: () => partnerContainer }),
  };
  bot._trading.getInteract = () => partner;
  const interaction = bot.getTradingInteraction();
  interaction.addItemsToTrade(mockContainer(), partner);
  return interaction;
}

// ---------------------------------------------------------------------------
// attachTradingInteraction
// ---------------------------------------------------------------------------
{
  const bot = mockBot();
  attachTradingInteraction(bot);
  assert.equal(typeof bot.getTradingInteraction, "function", "interaction attached");

  const first = bot.getTradingInteraction;
  attachTradingInteraction(bot);
  assert.equal(bot.getTradingInteraction, first, "attach is idempotent");

  const human = { isPlayerBot: () => false };
  attachTradingInteraction(human);
  assert.equal(human.getTradingInteraction, undefined, "humans untouched");
}

// --- interaction shape ------------------------------------------------------
{
  const bot = mockBot();
  attachTradingInteraction(bot);
  const interaction = bot.getTradingInteraction();
  for (const method of ["acceptTradeRequest", "addItemsToTrade", "acceptTrade", "receivedItems"]) {
    assert.equal(typeof interaction[method], "function", `${method} implemented`);
  }
}

// --- acceptTradeRequest: happy path ------------------------------------------
{
  const bot = mockBot();
  attachTradingInteraction(bot);
  const interaction = bot.getTradingInteraction();
  const requester = { getUsername: () => "Jon", isPlayerBot: () => false };
  const ok = interaction.acceptTradeRequest(requester);
  assert.equal(ok, true, "trade request accepted");
  assert.deepEqual(bot._trading._calls[0], ["requestTrade", "Jon"], "handshake completed");
}

// --- acceptTradeRequest: already trading --------------------------------------
{
  const bot = mockBot();
  bot._trading.getState = () => ({ isTrading: () => true });
  bot._trading.requestTrade = () => {
    throw new Error("must not request while trading");
  };
  attachTradingInteraction(bot);
  const ok = bot.getTradingInteraction().acceptTradeRequest({ getUsername: () => "Jon" });
  assert.equal(ok, false, "refused while already trading");
}

// --- merchant offers ware at the listed price, keeps reserve ------------------
{
  const bot = mockBot({
    attrs: { [WARE_ITEM]: BREAD, [WARE_PRICE]: 12 },
    invEntries: [{ id: BREAD, amount: 20, stackable: true }],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  const partner = { getUsername: () => "Jon", isPlayerBot: () => false };
  bot.getTradingInteraction().addItemsToTrade(offerBox, partner);
  assert.equal(offerBox.getAmount(BREAD), 16, "merchant offers stock above reserve");
  assert.equal(bot._inventory.getAmount(BREAD), 4, "merchant keeps reserve");
  assert.ok(bot.said.join(" ").includes("192"), "ask states the price (16 x 12)");
  assert.ok(
    bot.said.join(" ").toLowerCase().includes("selling"),
    "offer announced out loud"
  );
}

// --- merchant with an empty stall offers nothing --------------------------------
{
  const bot = mockBot({
    attrs: { [WARE_ITEM]: BREAD, [WARE_PRICE]: 12 },
    invEntries: [{ id: BREAD, amount: 3, stackable: true }],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getValidItems().length, 0, "empty stall offers nothing");
}

// --- gatherer sells surplus above the keep reserve ------------------------------
{
  const FISH = 99901; // arbitrary test id (no baseline -> ref price 1)
  const bot = mockBot({
    attrs: { [WORK_KIND]: "fishing" },
    invEntries: [{ id: FISH, amount: 50, stackable: true }],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getAmount(FISH), 40, "offers surplus above keep-10");
  assert.equal(bot._inventory.getAmount(FISH), 10, "keeps the reserve");
}

// --- greedy gatherer marks up ----------------------------------------------------
{
  const bot = mockBot({
    attrs: { [WORK_KIND]: "fishing", [PERSONALITY]: { traits: ["greedy"] } },
    invEntries: [
      { id: 99901, amount: 50, stackable: true },
      { id: COINS, amount: 5000, stackable: true }, // not broke: full greedy markup
    ],
  });
  attachTradingInteraction(bot);
  openTradeWith(bot, mockContainer());
  // 40 offered at round(1 x 1.5) = 2 each -> ask 80
  assert.ok(bot.said.join(" ").includes("80"), "greedy markup raises the ask");
}

// --- broke citizen sells even without a gatherer work-kind -----------------------
{
  const ORE = 99902;
  const bot = mockBot({
    invEntries: [
      { id: ORE, amount: 50, stackable: true },
      { id: COINS, amount: 100, stackable: true },
    ],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getAmount(ORE), 40, "broke citizen sells surplus");
}

// --- comfortable non-gatherer offers nothing --------------------------------------
{
  const ORE = 99902;
  const bot = mockBot({
    invEntries: [
      { id: ORE, amount: 50, stackable: true },
      { id: COINS, amount: 5000, stackable: true },
    ],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getValidItems().length, 0, "no reason to sell -> no offer");
}

// --- bread (HP staple) is never sold from a personal stash -------------------------
{
  const bot = mockBot({
    attrs: { [WORK_KIND]: "fishing" },
    invEntries: [{ id: BREAD, amount: 50, stackable: true }],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getValidItems().length, 0, "bread reserve protected");
}

// --- untradeables are never offered --------------------------------------------------
{
  const RELIC = 99903;
  const bot = mockBot({
    attrs: { [WORK_KIND]: "tree" },
    invEntries: [{ id: RELIC, amount: 50, stackable: true, tradeable: false }],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getValidItems().length, 0, "untradeables never offered");
}

// --- product batch: 4+ identical unstackables = crafter goods -------------------------
{
  const SWORD = 99904;
  const entries = [];
  for (let i = 0; i < 5; i++) entries.push({ id: SWORD, amount: 1, stackable: false });
  entries.push({ id: COINS, amount: 5000, stackable: true });
  const bot = mockBot({ invEntries: entries });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getAmount(SWORD), 4, "crafter batch offered, keeps one");
}

// --- a single personal sword is NOT sold ------------------------------------------------
{
  const SWORD = 99904;
  const bot = mockBot({
    invEntries: [
      { id: SWORD, amount: 1, stackable: false },
      { id: COINS, amount: 100, stackable: true }, // broke...
    ],
  });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getAmount(SWORD), 0, "personal gear protected");
}

// --- haggle: fair offer -> accept back ---------------------------------------------------
{
  const bot = mockBot({
    attrs: { [WARE_ITEM]: BREAD, [WARE_PRICE]: 12 },
    invEntries: [{ id: BREAD, amount: 20, stackable: true }],
  });
  attachTradingInteraction(bot);
  // ask = 16 x 12 = 192; 200 coins offered -> accept back
  openTradeWith(bot, mockContainer([{ id: COINS, amount: 200, stackable: true }]));
  bot._trading._calls.length = 0;
  bot.getTradingInteraction().acceptTrade();
  assert.deepEqual(bot._trading._calls[0], ["acceptTrade"], "fair price accepted");
}

// --- haggle: low offer -> refuse with a line, no accept-back ------------------------------
{
  const bot = mockBot({
    attrs: { [WARE_ITEM]: BREAD, [WARE_PRICE]: 12 },
    invEntries: [{ id: BREAD, amount: 20, stackable: true }],
  });
  attachTradingInteraction(bot);
  // 100 < 192 x 0.8 = 153.6 -> haggle
  openTradeWith(bot, mockContainer([{ id: COINS, amount: 100, stackable: true }]));
  bot._trading._calls.length = 0;
  const saidBefore = bot.said.length;
  bot.getTradingInteraction().acceptTrade();
  assert.equal(bot._trading._calls.length, 0, "no accept-back on a low offer");
  const haggle = bot.said.slice(saidBefore).join(" ");
  assert.ok(
    haggle.includes("192") || haggle.includes("54"),
    `haggle restates the ask or the shortfall, got: ${haggle}`
  );
}

// --- haggle: nothing offered -> "offer something" line --------------------------------------
{
  const bot = mockBot({
    attrs: { [WARE_ITEM]: BREAD, [WARE_PRICE]: 12 },
    invEntries: [{ id: BREAD, amount: 20, stackable: true }],
  });
  attachTradingInteraction(bot);
  openTradeWith(bot, mockContainer());
  bot._trading._calls.length = 0;
  bot.getTradingInteraction().acceptTrade();
  assert.equal(bot._trading._calls.length, 0, "no accept-back on an empty offer");
  assert.ok(
    ["offer something", "aren't free", "not free", "need something", "nothin'"].some(
      (s) => bot.said.join(" ").toLowerCase().includes(s)
    ),
    "told to offer something"
  );
}

// --- barter: items at reference value count toward the ask -----------------------------------
{
  const bot = mockBot({
    attrs: { [WARE_ITEM]: BREAD, [WARE_PRICE]: 12 },
    invEntries: [{ id: BREAD, amount: 20, stackable: true }],
  });
  attachTradingInteraction(bot);
  // 2 bread at ref 82 = 164 >= 153.6 -> barter accepted
  openTradeWith(bot, mockContainer([{ id: BREAD, amount: 2, stackable: true }]));
  bot._trading._calls.length = 0;
  bot.getTradingInteraction().acceptTrade();
  assert.deepEqual(bot._trading._calls[0], ["acceptTrade"], "fair barter accepted");
}

// --- gift flow unchanged: citizen offered nothing -> accept back -----------------------------
{
  const bot = mockBot({ invEntries: [{ id: COINS, amount: 5000, stackable: true }] });
  attachTradingInteraction(bot);
  const offerBox = mockContainer();
  bot.getTradingInteraction().addItemsToTrade(offerBox, { getUsername: () => "Jon" });
  assert.equal(offerBox.getValidItems().length, 0, "no offer made");
  bot._trading._calls.length = 0;
  bot.getTradingInteraction().acceptTrade();
  assert.deepEqual(bot._trading._calls[0], ["acceptTrade"], "gift accept-back preserved");
}

// --- receivedItems: sale journals + business line ------------------------------------------------
{
  const bot = mockBot({
    attrs: { [WARE_ITEM]: BREAD, [WARE_PRICE]: 12 },
    invEntries: [{ id: BREAD, amount: 20, stackable: true }],
  });
  attachTradingInteraction(bot);
  openTradeWith(bot, mockContainer([{ id: COINS, amount: 200, stackable: true }]));
  const saidBefore = bot.said.length;
  const from = { getUsername: () => "Jon" };
  bot.getTradingInteraction().receivedItems(
    [{ getId: () => COINS, getAmount: () => 200 }],
    from
  );
  const after = bot.said.slice(saidBefore).join(" ").toLowerCase();
  assert.ok(
    after.includes("pleasure doing business") || after.includes("thanks for the trade"),
    "sale closed with a business line"
  );
}

// --- receivedItems: gift still thanks ----------------------------------------------------------------
{
  const bot = mockBot({ invEntries: [{ id: COINS, amount: 5000, stackable: true }] });
  attachTradingInteraction(bot);
  const from = { getUsername: () => "Jon" };
  const saidBefore = bot.said.length;
  bot.getTradingInteraction().receivedItems(
    [{ getId: () => COINS, getAmount: () => 100 }],
    from
  );
  const after = bot.said.slice(saidBefore).join(" ").toLowerCase();
  assert.ok(
    after.includes("thank") || after.includes("appreciate"),
    "gift still thanked"
  );
}

// --- containerValue: coins at face, items at reference -------------------------------------------------
{
  const { _containerValue } = Trading;
  const c = mockContainer([
    { id: COINS, amount: 150, stackable: true },
    { id: BREAD, amount: 2, stackable: true }, // ref 82 each
  ]);
  assert.equal(_containerValue(c), 150 + 2 * 82, "coins face + items reference");
}

console.log("CitizenTrading tests passed.");
