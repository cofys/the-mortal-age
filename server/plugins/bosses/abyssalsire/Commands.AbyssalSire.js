/**
 * Developer command: ::sire [sw|nw|ne|se] goes to that chamber (south-west unless named), in
 * front of its Sire's alcove; ::sire reset puts every chamber back as it was. In a fight,
 * ::sire lungs destroys the lungs that are left (phase 1's end) and ::sire hp <n> sets the Sire's
 * hitpoints. A Sire wakes only for a player on task: ::slayertask 20 abyssal demons.
 */
const Common = require("./Common.AbyssalSire");
const Lair = require("./Lair.AbyssalSire");
const Lungs = require("./Lungs.AbyssalSire");

const SHORT = { sw: "south-west", nw: "north-west", ne: "north-east", se: "south-east" };
/** In front of the alcove, between the phase 2 and phase 3 tiles. */
const STAND_OFFSET = [2, -12];

function sire({ player, parts }) {
  const arg = String(parts?.[1] ?? "sw").toLowerCase();
  if (arg === "reset") {
    for (const lair of Lair.lairs) lair.reset();
    player.sendMessage("Every Abyssal Sire chamber has been reset.");
    return;
  }
  if (arg === "lungs" || arg === "hp") {
    const fight = Lair.lairAt(player.getLocation())?.fight;
    if (!fight || fight.player !== player) {
      player.sendMessage("You aren't fighting a Sire.");
      return;
    }
    if (arg === "lungs") {
      for (const lung of [...fight.lair.lungs]) if (!lung.dead && lung.npc) Lungs.lungDeath({ npc: lung.npc, preventDeath: false });
    } else {
      fight.sire.setHitpoints(Math.max(1, Math.min(fight.maxHitpoints, Number(parts?.[2]) || 1)));
    }
    return;
  }
  const lair = Lair.lairs.find((entry) => entry.name === (SHORT[arg] ?? arg));
  if (!lair) {
    player.sendMessage("Usage: ::sire [sw|nw|ne|se|reset|lungs|hp <n>]");
    return;
  }
  player.moveTo(lair.offset(STAND_OFFSET));
  player.sendMessage(`The ${lair.name} Abyssal Sire chamber${lair.fight ? " (in a fight)" : ""}.`);
}

module.exports = function attachCommands(api) {
  api.registerCommand("sire", sire, Common.core.PlayerRights.DEVELOPER, "Abyssal Sire chambers: ::sire [sw|nw|ne|se|reset|lungs|hp <n>]");
};
