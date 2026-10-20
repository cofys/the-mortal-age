/**
 * Developer commands for testing the fight (docs/hueycoatl.md):
 *   ::huey body       beat the body segments (opens the path)
 *   ::huey shield     the head to half health (the shield and the tail)
 *   ::huey tail       break the tail (the final phase)
 *   ::huey hp <n>     set the head's hitpoints
 *   ::huey braziers   light the braziers
 *   ::huey intro      mark Taala's explanation as heard
 *   ::huey symbol [glow|strike]   glowing symbols on the 3x3 around you (no damage): the glow
 *                     (loc, 4 ticks) then the strike (graphic delayed 120 cycles), or one part
 * They act on the fight of the player's camp (their private one, else the public one).
 */
const Shared = require("./Shared.Hueycoatl");
const Area = require("./Area.Hueycoatl");
const Fight = require("./Fight.Hueycoatl");
const Attacks = require("./Attacks.Hueycoatl");

const USAGE = "Usage: ::huey body | shield | tail | hp <n> | braziers | intro | symbol [glow|strike]";

let core = null;

function huey({ player, parts }) {
  const session = Area.campSession(player);
  const fight = session?.fight;
  if (!fight) {
    player.sendMessage("There is no Hueycoatl fight here.");
    return true;
  }
  switch (parts[1]) {
    case "body":
      for (const segment of fight.segments.filter((entry) => !entry.down)) Fight.segmentDown(session, segment.npc);
      break;
    case "shield":
      fight.head.setHitpoints(Shared.SHIELD_AT);
      break;
    case "tail":
      if (fight.tail) Fight.breakTail(session);
      break;
    case "hp": {
      const hitpoints = Number(parts[2]);
      if (!Number.isInteger(hitpoints) || hitpoints < 1 || hitpoints > Shared.HEAD_HITPOINTS) {
        player.sendMessage(USAGE);
        return true;
      }
      fight.head.setHitpoints(hitpoints);
      break;
    }
    case "braziers":
      session.pillars.lit = true;
      for (const pillar of Shared.PILLARS) {
        session.setLoc(pillar.tile, Shared.PILLAR_BRAZIER_SHAPE, Shared.PILLAR_BRAZIER_ROTATION, pillar.on);
      }
      break;
    case "symbol":
      Attacks.testSymbols(session, player, parts[2] === "glow" || parts[2] === "strike" ? parts[2] : "both");
      break;
    case "intro":
      player.setAttribute(Area.TAALA_INTRO_ATTRIBUTE, true);
      player.getPacketSender().sendVarbit(Shared.VARBIT.INTRO, 1);
      break;
    default:
      player.sendMessage(USAGE);
      return true;
  }
  player.sendMessage(`Hueycoatl: ${fight.phase}, head ${fight.head.getHitpoints()} hitpoints.`);
  return true;
}

module.exports = function attachCommands(api) {
  core = api.core;
  api.registerCommand("huey", huey, core.PlayerRights.DEVELOPER, "Drive the Hueycoatl fight (body, shield, tail, hp, braziers, intro)");
};
