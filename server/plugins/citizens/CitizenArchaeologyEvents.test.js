"use strict";

/**
 * CitizenArchaeologyEvents.test.js — plain node.
 * Run: node server/plugins/citizens/CitizenArchaeologyEvents.test.js
 */

const assert = require("assert");
const Arch = require("./lib/CitizenArchaeology");
const { onDigCommand, DIG_USAGE } = require("./CitizenArchaeologyEvents");

let passed = 0;
function test(name, fn) {
  Arch.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function makePlayer(username, opts) {
  const o = opts || {};
  let coins = o.coins ?? 0;
  const said = [];
  return {
    player: {
      getUsername: () => username,
      username,
      isBot: o.isBot ?? false,
      isRealPlayer: () => !(o.isBot ?? false),
      sendMessage: (t) => said.push(String(t)),
      getInventory: () => ({
        getAmount: () => coins,
        count: () => coins,
        add: (id, n) => { coins += n; return true; },
        remove: (id, n) => { if (coins >= n) { coins -= n; return true; } return false; },
      }),
    },
    said,
    coins: () => coins,
  };
}

const SITES_STUB = "./lib/../brain/CitizenSites.js";

test("bots are rejected", () => {
  const { player, said } = makePlayer("Bot1", { isBot: true });
  onDigCommand(player, ["sites"]);
  assert.ok(said.join(" ").includes("not this command"));
});

test("sites lists open digs honestly", () => {
  // Stub kingdom derivation to a fixed kingdom for the command's kingdomOf().
  const path = require("path");
  const p = path.resolve(__dirname, SITES_STUB);
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: { kingdomIdOf: () => "varrock" },
  };
  Arch.foundSiteFromDiscovery("exp-1", { name: "a lost tomb" }, "varrock", "Bob");
  const { player, said } = makePlayer("Indy");
  onDigCommand(player, ["sites"]);
  assert.ok(said.join(" ").includes("lost tomb"), "site listed");
  delete require.cache[p];
});

test("sites with no digs says so honestly", () => {
  const path = require("path");
  const p = path.resolve(__dirname, SITES_STUB);
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: { kingdomIdOf: () => "varrock" },
  };
  const { player, said } = makePlayer("Indy");
  onDigCommand(player, ["sites"]);
  assert.ok(said.join(" ").includes("No open dig sites"));
  delete require.cache[p];
});

test("dig yields an artifact with history", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a sealed crypt" }, "varrock", "Bob").site;
  const { player, said } = makePlayer("Indy");
  onDigCommand(player, ["dig", site.id]);
  const out = said.join(" ");
  assert.ok(out.includes("unearth"), "dig announced");
  assert.ok(Arch.describe().artifacts === 1, "artifact recorded");
});

test("dig at bad site fails honestly", () => {
  const { player, said } = makePlayer("Indy");
  onDigCommand(player, ["dig", "site-999"]);
  assert.ok(said.join(" ").includes("no such dig site"));
});

test("collection shows owned artifacts", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a sealed crypt" }, "varrock", "Bob").site;
  Arch.excavate("Indy", site.id);
  const { player, said } = makePlayer("Indy");
  onDigCommand(player, ["collection"]);
  assert.ok(said.join(" ").includes("art-"), "artifact listed");
});

test("donate moves artifact to museum", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a sealed crypt" }, "varrock", "Bob").site;
  const a = Arch.excavate("Indy", site.id).artifact;
  const { player, said } = makePlayer("Indy");
  onDigCommand(player, ["donate", a.id]);
  assert.ok(said.join(" ").includes("Donated"));
  assert.strictEqual(Arch.artifactOf(a.id).donated, true);
});

test("sell pays real coins from a funded museum", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a sealed crypt" }, "varrock", "Bob").site;
  const a = Arch.excavate("Indy", site.id).artifact;
  Arch.ensureMuseum("varrock").fund = a.value + 50;
  const { player, said, coins } = makePlayer("Indy", { coins: 0 });
  onDigCommand(player, ["sell", a.id]);
  assert.ok(said.join(" ").includes("Sold"));
  assert.strictEqual(coins(), a.value, "real coins paid");
});

test("sell fails honestly when museum is broke", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a sealed crypt" }, "varrock", "Bob").site;
  const a = Arch.excavate("Indy", site.id).artifact;
  const { player, said, coins } = makePlayer("Indy", { coins: 0 });
  onDigCommand(player, ["sell", a.id]);
  assert.ok(said.join(" ").includes("cannot afford"));
  assert.strictEqual(coins(), 0);
});

test("restore upgrades for a real fee", () => {
  const site = Arch.foundSiteFromDiscovery("exp-1", { name: "a sealed crypt" }, "varrock", "Bob").site;
  const a = Arch.excavate("Indy", site.id).artifact;
  if (a.condition === "pristine") {
    console.log("  (skip: pristine artifact cannot be restored)");
    return;
  }
  const { player, said, coins } = makePlayer("Indy", { coins: 100000 });
  const before = coins();
  onDigCommand(player, ["restore", a.id]);
  assert.ok(said.join(" ").includes("Restored"));
  assert.ok(coins() < before, "fee taken");
});

test("usage on unknown subcommand", () => {
  const { player, said } = makePlayer("Indy");
  onDigCommand(player, ["frobnicate"]);
  assert.ok(said.join(" ").includes("::dig"));
});

test("DIG_USAGE is a non-empty string", () => {
  assert.ok(typeof DIG_USAGE === "string" && DIG_USAGE.includes("::dig"));
});

console.log(`\n${passed} tests passed`);
