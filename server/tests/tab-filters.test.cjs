// Run after `yarn build`: node --test tests/tab-filters.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const TabFilters = require("../plugins/interface/TabFilters.plugin");
const { toggleFilter, restoreFilters, hideSpellsLackingLevel, showSpellsLackingLevel } = TabFilters._test;

const PRAYER_FILTER_MENU = (541 << 16) | 42;
const MAGIC_FILTER_MENU = (218 << 16) | 206;

function createPlayer(saved = {}) {
  const log = [];
  const attributes = new Map(Object.entries(saved));
  const sender = { sendVarbit: (id, value) => { log.push(`varbit ${id}=${value}`); return sender; } };
  return {
    log,
    getPacketSender: () => sender,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
  };
}

const click = (player, buttonId, slot) => toggleFilter({ player, buttonId, slot });

test("as captured: a row click flips only its own varbit, in the cache's row order", () => {
  const player = createPlayer();
  assert.equal(click(player, PRAYER_FILTER_MENU, 0), true);
  click(player, PRAYER_FILTER_MENU, 0);
  click(player, MAGIC_FILTER_MENU, 1);
  click(player, MAGIC_FILTER_MENU, 3);
  click(player, MAGIC_FILTER_MENU, 4);
  click(player, MAGIC_FILTER_MENU, 5);
  assert.deepEqual(player.log, [
    "varbit 6574=1", // prayer_filter_blocklowtier
    "varbit 6574=0",
    "varbit 6609=1", // magic_filter_blockteleport
    "varbit 6607=1", // magic_filter_blocklacklevel
    "varbit 6608=1", // magic_filter_blocklackrunes
    "varbit 12137=1", // magic_filter_blocklocked
  ]);
  assert.equal(player.getAttribute("tab-filters:prayer"), 0);
  assert.equal(player.getAttribute("tab-filters:magic"), 0b111010);
});

test("rows past the menu and other buttons are left alone", () => {
  const player = createPlayer();
  assert.equal(click(player, PRAYER_FILTER_MENU, 5), false);
  assert.equal(click(player, MAGIC_FILTER_MENU, 7), false);
  assert.equal(click(player, MAGIC_FILTER_MENU, undefined), false);
  assert.deepEqual(player.log, []);
});

test("login sends the saved filters", () => {
  const player = createPlayer({ "tab-filters:prayer": 0b10001, "tab-filters:magic": 0b1000001 });
  restoreFilters({ player });
  assert.deepEqual(player.log, ["varbit 6574=1", "varbit 6578=1", "varbit 6605=1", "varbit 6548=1"]);
});

test("as captured: Tutorial Island hides spells the player lacks the level for, and leaving shows them", () => {
  const player = createPlayer({ "tab-filters:magic": 0b1 });
  hideSpellsLackingLevel({ player });
  assert.equal(player.getAttribute("tab-filters:magic"), 0b1001);
  showSpellsLackingLevel({ player });
  assert.equal(player.getAttribute("tab-filters:magic"), 0b1);
  assert.deepEqual(player.log, ["varbit 6607=1", "varbit 6607=0"]);
});
