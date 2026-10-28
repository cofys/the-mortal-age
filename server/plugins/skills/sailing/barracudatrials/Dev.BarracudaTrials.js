// Developer commands for trying the trials: ::bt start <trial> <rank 0-3>, ::bt complete,
// ::bt intro <trial> (the next Talk-to plays the intro again), ::bt go <trial> (the boat to the
// trial's start), ::bt tp <x> <y> (the boat to a tile), ::bt npcs (the masters on their decks, by
// index, and the NPCs sent to you). Trials by the start of their name: tempor, jubbly, gwenith.
const common = require("./Common.BarracudaTrials");
const run = require("./Run.BarracudaTrials");

const USAGE = "::bt start <tempor|jubbly|gwenith> <0-3> | complete | intro <trial> | go <trial> | tp <x> <y> | npcs";

function trialNamed(name) {
  return common.trials.find((trial) => name && trial.key.startsWith(String(name).toLowerCase()));
}

function command({ player, parts }) {
  const [, action, name, rank] = parts;
  const trial = trialNamed(name);
  const boat = common.core().Sailing.instanceAboard(player);
  if (action === "start" && trial && boat) {
    run.start(player, trial, Math.max(0, Math.min(3, Number(rank) || 0)));
    return true;
  }
  if (action === "complete") {
    const current = common.runs.get(player);
    if (!current) player.sendMessage("You aren't in a Barracuda Trial.");
    else {
      current.remaining.clear();
      run.finish(player, current);
    }
    return true;
  }
  if (action === "intro" && trial) {
    common.updateProgress(player, trial, (saved) => { saved.intro = false; });
    common.sendProgress(player);
    player.sendMessage(`The ${trial.name}'s intro plays on the next Talk-to.`);
    return true;
  }
  if (action === "npcs") {
    for (const each of common.trials) {
      const master = require("./Ships.BarracudaTrials").masterOf(each);
      player.sendMessage(`${each.master.name}: ${master ? `index ${master.getIndex()}` : "not spawned"}`);
    }
    // What this player is sent: each local NPC's index, id and the boat it stands on.
    const { BoatManager } = common.core();
    const sent = player.getLocalNpcs().map((npc) => `${npc.getIndex()}:${npc.getId()}${BoatManager.getBoatAboard(npc) ? `@${BoatManager.getBoatAboard(npc).entityIndex}` : ""}`);
    player.sendMessage(`Sent to you: ${sent.join(", ") || "none"}`);
    return true;
  }
  if (action === "tp" && boat && Number.isInteger(Number(name)) && Number.isInteger(Number(rank))) {
    common.core().BoatManager.teleport(boat, { fineX: Number(name) * 128 + 64, fineY: Number(rank) * 128 + 64 });
    return true;
  }
  if (action === "go" && trial && boat) {
    common.core().BoatManager.teleport(boat, trial.start);
    return true;
  }
  player.sendMessage(boat || !trial ? USAGE : "You need to be aboard your boat.");
  return true;
}

function attach(api) {
  common.init(api);
  api.registerCommand("bt", command, api.core.PlayerRights.DEVELOPER, `Barracuda Trials: ${USAGE}`);
}

module.exports = attach;
