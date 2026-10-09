"use strict";

/**
 * CitizenTheaterEvents.test.js — ::stage command contracts.
 * Plain node, no jest. Run: node server/plugins/citizens/CitizenTheaterEvents.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const Theater = require("./lib/CitizenTheater");
Theater._setSavePathForTests(path.join(os.tmpdir(), `citizen-stage-test-${process.pid}.json`));
const SAVE_PATH = path.join(os.tmpdir(), `citizen-stage-test-${process.pid}.json`);
const { onStageCommand } = require("./CitizenTheaterEvents");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    try { require("fs").unlinkSync(SAVE_PATH); } catch { /* fresh */ }
    Theater.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

function stubPlayer(username, opts) {
  const o = opts || {};
  const inv = {
    coins: o.coins ?? 500,
    papyrus: o.papyrus ?? 5,
    getAmount(id) {
      if (id === 995) return this.coins;
      if (id === 970) return this.papyrus;
      return 0;
    },
    // Real ItemContainer API: getAmount(id), adds(id, amount), deleteNumber(id, amount).
    adds(id, n) {
      if (id === 995) this.coins += n;
      if (id === 970) this.papyrus += n;
    },
    deleteNumber(id, n) {
      if (id === 995 && this.coins >= n) this.coins -= n;
      if (id === 970 && this.papyrus >= n) this.papyrus -= n;
    },
  };
  const messages = [];
  return {
    username,
    getUsername: () => username,
    isPlayerBot: () => !!(o.bot ?? false),
    getInventory: () => inv,
    sendMessage: (t) => messages.push(t),
    _messages: messages,
    _inv: inv,
  };
}

function lastMessage(p) {
  return p._messages[p._messages.length - 1] || "";
}

test("bots are rejected", () => {
  const bot = stubPlayer("Bot1", { bot: true });
  onStageCommand(bot, "theaters");
  assert(lastMessage(bot).includes("not this command"), "bot rejected");
});

test("theaters lists venues", () => {
  const p = stubPlayer("Alice");
  Theater.ensureTheater("misthalin");
  onStageCommand(p, "theaters");
  assert(lastMessage(p).includes("Playhouse"), "theater listed");
});

test("write registers and drafts a play", () => {
  const p = stubPlayer("Alice");
  onStageCommand(p, "write tragedy");
  assert(lastMessage(p).includes("Wrote"), `play written: ${lastMessage(p)}`);
  assert.strictEqual(p._inv.papyrus, 4, "papyrus consumed");
});

test("write rejects bad genres honestly", () => {
  const p = stubPlayer("Alice");
  onStageCommand(p, "write opera");
  assert(lastMessage(p).includes("Could not write"), "honest rejection");
});

test("form and join work", () => {
  const a = stubPlayer("Alice");
  onStageCommand(a, "form The Stars");
  assert(lastMessage(a).includes("Formed"), "troupe formed");
  const b = stubPlayer("Bob");
  onStageCommand(b, "join The Stars");
  assert(lastMessage(b).includes("Joined"), "troupe joined");
});

test("full flow: write, repertoire, book, ticket", () => {
  const a = stubPlayer("Alice");
  onStageCommand(a, "write comedy");
  const plays = Theater.playsBy("Alice");
  assert(plays.length >= 1, "play exists");
  onStageCommand(a, "form The Stars");
  onStageCommand(a, `repertoire The Stars ${plays[0].id}`);
  assert(lastMessage(a).includes("repertoire"), "added to repertoire");
  // booking needs the troupe in the player's kingdom — the events module
  // uses the real kingdom derivation; use the data tier directly for the
  // booking leg and test the ticket leg through the command.
  const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
  const kid = kingdomIdOf({ username: "Alice" }) || "misthalin";
  // re-setup in the real kingdom
  try { require("fs").unlinkSync(SAVE_PATH); } catch {}
  Theater.resetForTests();
  const a2 = stubPlayer("Alice");
  Theater.registerPlaywright("Alice", kid);
  const wp = Theater.writePlay(a2, "comedy");
  assert(wp.ok, "play written in real kingdom");
  Theater.formTroupe("Alice", kid, "The Stars");
  Theater.addToRepertoire("The Stars", wp.play.id);
  const book = Theater.bookPerformance("The Stars", wp.play.id, kid, 20);
  assert(book.ok, `booked: ${book.reason}`);
  const fan = stubPlayer("Fan", { coins: 100 });
  onStageCommand(fan, `ticket ${book.performance.id}`);
  assert(lastMessage(fan).includes("Ticket bought"), `ticket bought: ${lastMessage(fan)}`);
  assert.strictEqual(fan._inv.coins, 80, "coins taken");
});

test("ticket fails honestly when broke", () => {
  const { kingdomIdOf } = require("./lib/../brain/CitizenSites");
  const kid = kingdomIdOf({ username: "Alice" }) || "misthalin";
  const a = stubPlayer("Alice");
  Theater.registerPlaywright("Alice", kid);
  const wp = Theater.writePlay(a, "comedy");
  Theater.formTroupe("Alice", kid, "The Stars");
  Theater.addToRepertoire("The Stars", wp.play.id);
  const book = Theater.bookPerformance("The Stars", wp.play.id, kid, 50);
  const broke = stubPlayer("Broke", { coins: 5 });
  onStageCommand(broke, `ticket ${book.performance.id}`);
  assert(lastMessage(broke).includes("No ticket"), "honest failure");
  assert.strictEqual(broke._inv.coins, 5, "no coins taken");
});

test("unknown subcommand shows usage", () => {
  const p = stubPlayer("Alice");
  onStageCommand(p, "frobnicate");
  assert(lastMessage(p).includes("::stage"), "usage shown");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
