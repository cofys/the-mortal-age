// Run after `yarn build`: node --test tests/quest-name-lookup.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const QuestRuntime = require("../plugins/quests/QuestRuntime");

const handlers = new Map();
const api = new Proxy({
  core: {},
  onCustomEvent(name, handler) { handlers.set(name, handler); },
}, { get: (target, key) => (key in target ? target[key] : () => {}) });

const ham = QuestRuntime.registerQuest(api, { key: "another_slice_of_ham", name: "Another Slice of H.A.M.", varpId: 3000, completionValue: 10 });
QuestRuntime.registerQuest(api, { key: "the_grand_tree_lookup", name: "The Grand Tree", varpId: 3001, completionValue: 160 });
QuestRuntime.registerQuestWidgets(api);

function createPlayer() {
  const attributes = new Map();
  const sender = new Proxy({}, { get: () => () => sender });
  return {
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getPacketSender: () => sender,
  };
}

const ask = (event, request) => { handlers.get(event)(request); return request; };

test("quest:is-complete answers by name as the cache's music hints spell it, or leaves an unknown one alone", () => {
  const player = createPlayer();
  assert.equal(ask("quest:is-complete", { player, name: "Another Slice of H.A.M" }).complete, false, "punctuation does not count");
  ham.setStage(player, 10);
  assert.equal(ask("quest:is-complete", { player, name: "Another Slice of H.A.M" }).complete, true);
  assert.equal(ask("quest:is-complete", { player, name: "another slice of h.a.m." }).complete, true, "nor case");
  assert.equal(ask("quest:is-complete", { player, name: "Grand Tree" }).complete, false, 'a leading "The" does not count');
  assert.equal(ask("quest:is-complete", { player, name: "While Guthix Sleeps" }).complete, undefined, "unregistered: unanswered");
  assert.equal(ask("quest:is-complete", { player, key: "another_slice_of_ham" }).complete, true, "keys still work");
  assert.equal(ask("quest:is-started", { player, name: "The Grand Tree" }).started, false);
  assert.equal(ask("quest:get-stage", { player, name: "Another Slice of H.A.M." }).stage, 10);
});
