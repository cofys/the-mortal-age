"use strict";

// Plain-node tests for the ::libguild command.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const origRequire = Module.prototype.require;

// --- Set up Guilds with a temp save BEFORE requiring events ---
const Guilds = require("./lib/CitizenLibrarianGuilds");
const savePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lge-")), "save.json");
Guilds._setSavePathForTests(savePath);
Guilds.resetForTests();

let careers = {};
let books = {};

const librariesStub = {
  booksIn: (kid) => Object.values(books).filter((b) => b.kingdomId === kid),
  bookById: (id) => books[id] || null,
  archivesIn: () => [],
  isLibrarian: () => false,
  libraryTile: () => ({ x: 3200, y: 3200, z: 0 }),
};
const careersStub = { careerOf: (u) => careers[String(u || "").toLowerCase()] || null };
const reputationStub = { awardDeed: () => {} };
const bankAccounts = {};
const bankingStub = {
  // Real contract: accountFor(username) -> live account record,
  // markDirty() -> persist. creditAccount does NOT exist.
  accountFor: (u) => {
    const key = String(u || "").toLowerCase().trim();
    bankAccounts[key] = bankAccounts[key] || { balance: 0 };
    return bankAccounts[key];
  },
  markDirty: () => {},
};
const bondsStub = { normalizeName: (s) => String(s || "").toLowerCase().trim() };

const stubs = {
  // Keys as the events module requires them (relative to citizens/).
  "./lib/CitizenLibrarianGuilds": Guilds,
  "./brain/CitizenSites": {
    // Real brain contract: KINGDOM_IDS[0] for anything without the kingdom attribute.
    KINGDOM_IDS: ["varrock", "falador"],
    kingdomIdOf: (player) => {
      const id = player?.getAttribute?.("kingdom:id");
      return typeof id === "string" && (id === "varrock" || id === "falador") ? id : "varrock";
    },
  },
  "./lib/CitizenLibraries": librariesStub,
  "./lib/CitizenCareers": careersStub,
  "./lib/CitizenReputation": reputationStub,
  "./lib/CitizenBanking": bankingStub,
  "./lib/CitizenBonds": bondsStub,
  // Keys as the Guilds data tier lazily requires them (relative to lib/).
  "./CitizenLibraries": librariesStub,
  "./CitizenCareers": careersStub,
  "./CitizenReputation": reputationStub,
  "./CitizenBanking": bankingStub,
  "./CitizenBonds": bondsStub,
  "../brain/CitizenSites": {
    // Real brain contract: KINGDOM_IDS[0] for anything without the
    // kingdom attribute (plain records, mock players).
    KINGDOM_IDS: ["varrock", "falador"],
    kingdomIdOf: (player) => {
      const id = player?.getAttribute?.("kingdom:id");
      return typeof id === "string" && (id === "varrock" || id === "falador") ? id : "varrock";
    },
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

Module.prototype.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
  return origRequire.apply(this, arguments);
};

const { onLibrarianGuildCommand, LIBGUILD_USAGE } = require("./CitizenLibrarianGuildEvents");

const coinsRef = { coins: 1000 };
function makePlayer(username, opts = {}) {
  const messages = [];
  return {
    username,
    getUsername: () => username,
    isPlayerBot: () => !!opts.isBot,
    getInventory: () => ({
      // Real engine ItemContainer shape: getAmount(id), adds(id, amount),
      // delete(id, amount), deleteNumber(id, amount).
      // add(id, amount) / remove / count do NOT exist.
      getAmount: (id) => (id === 995 ? coinsRef.coins : 0),
      adds: (id, amt) => { if (id === 995 && amt > 0) coinsRef.coins += amt; },
      delete: (id, amt) => { if (id === 995) coinsRef.coins -= amt; },
      deleteNumber: (id, amt) => { if (id === 995) coinsRef.coins -= amt; },
    }),
    sendMessage: (text) => messages.push(text),
    _messages: messages,
  };
}

let passed = 0;
function test(name, fn) {
  // Fresh guild state per test.
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lge2-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  coinsRef.coins = 1000;
  careers = {};
  books = {};
  for (const k of Object.keys(bankAccounts)) delete bankAccounts[k];
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("bots are rejected", () => {
  const player = makePlayer("BotBob", { isBot: true });
  onLibrarianGuildCommand(player, "status");
  assert.ok(player._messages[0].includes("Citizens work the guild"));
});

test("status shows guild info", () => {
  const player = makePlayer("Alice");
  onLibrarianGuildCommand(player, "status");
  assert.ok(player._messages[0].includes("Librarians' Guild") || player._messages[0].includes("No Librarians' Guild"));
});

test("code shows the librarians' code", () => {
  const player = makePlayer("Alice");
  onLibrarianGuildCommand(player, "code");
  assert.ok(player._messages[0].includes("Librarians' Code"));
});

test("join works for librarian-career players", () => {
  careers = { "bookish berta": "librarian" };
  const player = makePlayer("Bookish Berta");
  onLibrarianGuildCommand(player, "join");
  assert.ok(player._messages[0].includes("Welcome to the Librarians' Guild"));
  assert.ok(Guilds.isGuildMember("bookish berta"));
});

test("join rejects non-librarians", () => {
  const player = makePlayer("NotALibrarian");
  onLibrarianGuildCommand(player, "join");
  assert.ok(player._messages[0].includes("not-a-librarian"));
});

test("certify grades a real book and pays the bounty", () => {
  careers = { "bookish berta": "librarian" };
  books = {
    b1: { id: "b1", title: "Histories", author: "bookish berta", subject: "history", kingdomId: "varrock", quality: 9 },
  };
  const player = makePlayer("Bookish Berta");
  onLibrarianGuildCommand(player, "join");
  Guilds.creditTreasury("varrock", 1000);
  onLibrarianGuildCommand(player, "certify b1");
  assert.ok(player._messages[1].includes("Grade A"), `got: ${player._messages[1]}`);
  assert.ok(player._messages[1].includes("Bounty paid"));
  // Fee was taken.
  assert.strictEqual(coinsRef.coins, 1000 - Guilds.CERT_FEE);
});

test("certify refunds the fee on failure", () => {
  careers = { "bookish berta": "librarian" };
  const player = makePlayer("Bookish Berta");
  onLibrarianGuildCommand(player, "join");
  onLibrarianGuildCommand(player, "certify nope");
  assert.ok(player._messages[1].includes("Certification failed"));
  assert.strictEqual(coinsRef.coins, 1000); // refunded
});

test("seals reports the best grade", () => {
  careers = { "bookish berta": "librarian" };
  books = {
    b1: { id: "b1", title: "Histories", author: "bookish berta", subject: "history", kingdomId: "varrock", quality: 9 },
  };
  const player = makePlayer("Bookish Berta");
  onLibrarianGuildCommand(player, "join");
  Guilds.creditTreasury("varrock", 1000);
  onLibrarianGuildCommand(player, "certify b1");
  onLibrarianGuildCommand(player, "seals");
  assert.ok(player._messages[2].includes("A"));
});

test("report opens a plagiarism case", () => {
  careers = { "bookish berta": "librarian", "copy cat": "librarian" };
  books = {
    b1: { id: "b1", title: "True Tales", author: "bookish berta", subject: "lore", kingdomId: "varrock", quality: 8 },
    b2: { id: "b2", title: "True Tales", author: "copy cat", subject: "lore", kingdomId: "varrock", quality: 3 },
  };
  const p1 = makePlayer("Bookish Berta");
  const p2 = makePlayer("Copy Cat");
  onLibrarianGuildCommand(p1, "join");
  onLibrarianGuildCommand(p2, "join");
  Guilds.creditTreasury("varrock", 1000);
  onLibrarianGuildCommand(p1, "certify b1");
  onLibrarianGuildCommand(p2, "certify b2");
  const rep = makePlayer("Bookish Berta");
  onLibrarianGuildCommand(rep, "report True Tales");
  assert.ok(rep._messages[0].includes("Plagiarism case opened"), `got: ${rep._messages[0]}`);
});

test("seal archives needs archivist rank", () => {
  careers = { "bookish berta": "librarian" };
  const player = makePlayer("Bookish Berta");
  onLibrarianGuildCommand(player, "join");
  onLibrarianGuildCommand(player, "seal");
  assert.ok(player._messages[1].includes("rank-too-low") || player._messages[1].includes("not-eligible"),
    `got: ${player._messages[1]}`);
});

test("scriptorium posts a bounty and the author claims it", () => {
  careers = { "bookish berta": "librarian", "rich rita": "librarian" };
  books = {
    b1: { id: "b1", title: "Histories", author: "bookish berta", subject: "history", kingdomId: "varrock", quality: 9 },
  };
  const sponsor = makePlayer("Rich Rita");
  onLibrarianGuildCommand(sponsor, "join");
  onLibrarianGuildCommand(sponsor, "scriptorium history 200");
  assert.ok(sponsor._messages[1].includes("bounty") || sponsor._messages[1].includes("Bounty"), `got: ${sponsor._messages[1]}`);
  const bountyId = (sponsor._messages[1].match(/bounty-(\d+)/) || [])[0];
  assert.ok(bountyId, "bounty id in message");

  const author = makePlayer("Bookish Berta");
  onLibrarianGuildCommand(author, "join");
  Guilds.creditTreasury("varrock", 1000);
  onLibrarianGuildCommand(author, "certify b1");
  const certId = Object.keys(Guilds.load().certifications)[0];
  coinsRef.coins = 1000;
  onLibrarianGuildCommand(author, `claim ${bountyId} ${certId}`);
  const last = author._messages[author._messages.length - 1];
  assert.ok(last.includes("Bounty claimed") || last.includes("claimed"), `got: ${last}`);
  // The bounty really lands in the claimant's bank account.
  assert.strictEqual(bankAccounts["bookish berta"].balance, 200);
});

test("index proposes a book for the Restricted Index", () => {
  careers = { "archivist amy": "librarian" };
  books = {
    b1: { id: "b1", title: "Banned Thoughts", author: "archivist amy", subject: "politics", kingdomId: "varrock", quality: 7 },
  };
  const player = makePlayer("Archivist Amy");
  onLibrarianGuildCommand(player, "join");
  Guilds.memberOf("Archivist Amy").rank = Guilds.RANK_ARCHIVIST;
  onLibrarianGuildCommand(player, "index Banned Thoughts");
  assert.ok(player._messages[1].includes("Restricted Index"), `got: ${player._messages[1]}`);
  onLibrarianGuildCommand(player, "indexlist");
  // Still open — not yet on the list.
  assert.ok(player._messages[2].includes("empty"));
});

test("usage is shown for unknown subcommands", () => {
  const player = makePlayer("Alice");
  onLibrarianGuildCommand(player, "frobnicate");
  assert.strictEqual(player._messages[0], LIBGUILD_USAGE);
});

console.log(`\n${passed} tests passed`);
