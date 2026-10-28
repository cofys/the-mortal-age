// ::crew, for testing: recruits crewmates without their conversations or requirements, the way
// a recruitment ends (unlocked, a free crew slot, waiting at the boat or the Pandemonium).
const common = require("./Common.Crew");

const USAGE = "Usage: ::crew all | <name or id> | reset | list";

/** A crewmate by id, data key or any part of their name ("jakob", "ex-captain siad", "5"). */
function findCrew(query) {
  const wanted = query.toLowerCase();
  return common.all().find((crew) => String(crew.id) === wanted || crew.key === wanted)
    ?? common.all().find((crew) => crew.name.toLowerCase().includes(wanted));
}

function changed(player) {
  common.sendVarbits(player);
  common.core().PluginManager.emitCustomEvent("sailing:crew-changed", { player });
}

function recruit(player, crew) {
  const slot = common.recruit(player, crew, true);
  player.sendMessage(`Recruited ${crew.name}${slot >= 0 ? ` into crew slot ${slot + 1}` : ", waiting at the Pandemonium (no crew slot free)"}.`);
}

function crewCommand({ player, parts }) {
  const query = (parts ?? []).slice(1).join(" ").trim();
  if (!query) {
    player.sendMessage(USAGE);
    return true;
  }
  if (query === "list") {
    const { recruited, slots } = common.state(player);
    for (const crew of common.all()) {
      const slot = slots.indexOf(crew.id);
      const where = !recruited.includes(crew.id) ? "not recruited" : slot >= 0 ? `slot ${slot + 1}` : "Pandemonium";
      player.sendMessage(`${crew.id}. ${crew.name} (level ${crew.level}): ${where}`);
    }
    return true;
  }
  if (query === "reset") {
    common.update(player, (state) => {
      state.met = [];
      state.recruited = [];
      state.slots.fill(0);
      state.positions.fill(common.POSITION.IDLE);
      state.onDock = false;
    });
    changed(player);
    player.sendMessage("Your crew has been reset.");
    return true;
  }
  const crews = query === "all" ? common.all() : [findCrew(query)].filter(Boolean);
  if (!crews.length) {
    player.sendMessage(`No crewmate matches "${query}". ${USAGE}`);
    return true;
  }
  for (const crew of crews) recruit(player, crew);
  changed(player);
  return true;
}

function attach(api) {
  common.init(api);
  api.registerCommand("crew", crewCommand, api.core.PlayerRights.DEVELOPER, "Sailing crewmates: ::crew all | <name or id> | reset | list");
}

module.exports = attach;
module.exports.findCrew = findCrew;
module.exports.crewCommand = crewCommand;
