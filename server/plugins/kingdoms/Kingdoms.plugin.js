"use strict";

/**
 * Kingdoms — the KINGDOM SYSTEM for The Mortal Age.
 *
 * Kingdoms are the weather: territory, war, succession. This plugin wires the
 * five great powers from the world bible as Area subclasses (territory with
 * edges), a JSON world-state store (rulers, treasuries, wars, story flags),
 * player membership attributes, and the kingdom:* custom-event API that the
 * rest of the server talks to. Content units live in sibling files; this file
 * is a registration list only.
 */

/**
 * Defensive content-module loader.
 *
 * The live server is redeployed by writing fresh plugin files onto the host and
 * restarting. If the process boots while a deploy is still writing files, Node
 * can read a truncated-but-syntactically-valid module: `module.exports` was
 * never reassigned, so require() returns the default `{}` instead of the
 * attach function, surfacing as `TypeError: require(...) is not a function`.
 *
 * This loader detects that case, evicts the poisoned require-cache entry, and
 * retries with backoff so a transient partial write resolves itself instead of
 * taking down every kingdom feature. A genuinely broken module still fails
 * fast with a descriptive error.
 */
function loadContentModule(relativePath) {
  const resolved = require.resolve(relativePath);
  const MAX_ATTEMPTS = 5;
  let lastSeen = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const imported = require(resolved);
    const fn = imported?.default ?? imported;
    lastSeen = typeof fn;
    if (typeof fn === "function") return fn;
    // Poisoned cache entry (very likely a partial read mid-deploy): evict it.
    delete require.cache[resolved];
    if (attempt < MAX_ATTEMPTS) {
      console.warn(
        `[kingdoms] ${relativePath} did not export a function on attempt ${attempt} ` +
          `(saw ${lastSeen}); evicted cache entry and retrying...`
      );
      // Brief blocking sleep is fine at boot; a deploy write finishes in ms.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * attempt);
    }
  }
  throw new Error(
    `[kingdoms] content module ${relativePath} did not export an attach function ` +
      `after ${MAX_ATTEMPTS} attempts (last saw ${lastSeen}). ` +
      `The file may be truncated or still being written by a deploy.`
  );
}

module.exports = {
  name: "Kingdoms",
  register(api) {
    // All player progression must survive logout. Without these, kingdom
    // membership, rank, influence, and succession state reset on every relog.
    for (const key of [
      "kingdom:id",
      "kingdom:rank",
      "kingdom:influence",
      "kingdom:titles",
      "kingdom:court-role",
      "kingdom:challenge-cooldown",
      "kingdom:trial",
      "succession:fragments",
      "succession:heat",
      "succession:heat-at",
      "succession:grey-met",
      "wartable:open",
    ]) api.persistAttribute(key);
    loadContentModule("./Seed.Kingdoms")(api);
    loadContentModule("./Areas.Kingdoms")(api);
    loadContentModule("./Events.Kingdoms")(api);
    loadContentModule("./Membership.Kingdoms")(api);
    loadContentModule("./Influence.Kingdoms")(api);
    loadContentModule("./Politics.Kingdoms")(api);
    loadContentModule("./DonationChest.Kingdoms")(api);
    loadContentModule("./Steward.Kingdoms")(api);
    loadContentModule("./Commands.Kingdoms")(api);
    loadContentModule("./Alliances.Kingdoms")(api);
    loadContentModule("./Diplomacy.Kingdoms")(api);
    loadContentModule("./Royals.Kingdoms")(api);
    loadContentModule("./Succession.Kingdoms")(api);
    loadContentModule("./SuccessionDeep.Kingdoms")(api);
    loadContentModule("./SuccessionKeepers.Kingdoms")(api);
    loadContentModule("./SuccessionTrail.Kingdoms")(api);
    loadContentModule("./SuccessionHunt.Kingdoms")(api);
    loadContentModule("./Simulation.Kingdoms")(api);
    loadContentModule("./Tension.Kingdoms")(api);
    loadContentModule("./WarConsequences.Kingdoms")(api);
    loadContentModule("./Founding.Kingdoms")(api);
    loadContentModule("./ClaimStake.Kingdoms")(api);
    loadContentModule("./WarTable.Kingdoms")(api);
    loadContentModule("./WarTableApi")(api);
    loadContentModule("./Siege.Kingdoms")(api);
    loadContentModule("./AiWarfare.Kingdoms")(api);
    loadContentModule("./AiDiplomacy.Kingdoms")(api);
    loadContentModule("./OfficeTools.Kingdoms")(api);
  },
};
