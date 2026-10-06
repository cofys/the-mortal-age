/**
 * The Run: a migrating shoal that moves around the world's waters on a timer.
 *
 * Every so often a great shoal gathers at one of the known fishing grounds and
 * stays about half an hour, then moves on. While it is there, catches at its
 * spots come much faster and richer (+50% catch chance, +50% XP) - but the feeding
 * frenzy strips bait twice as fast. Nobody is told where it is directly: when the
 * shoal arrives, anglers' rumors seed the citizen gossip network and citizens
 * speak of it aloud, so word spreads the way news does. The fisher who finds the
 * boiling water first gets rich.
 *
 * Site rects are drawn around real fishing-spot spawns (server/data/definitions/
 * npc-spawns.json): the River Lum, Barbarian Village, Shilo Village, Catherby
 * shore, the Fishing Guild docks, and Piscatoris.
 */
const { spreadRumor } = require("./Rumors.Fishing");

const SITES = Object.freeze([
  { name: "the River Lum", x1: 3220, x2: 3260, y1: 3235, y2: 3265, kingdom: "misthalin" },
  { name: "Barbarian Village", x1: 3085, x2: 3125, y1: 3410, y2: 3450, kingdom: "misthalin" },
  { name: "Shilo Village", x1: 2835, x2: 2875, y1: 2960, y2: 2990, kingdom: "kandarin" },
  { name: "Catherby shore", x1: 2815, x2: 2860, y1: 3415, y2: 3445, kingdom: "kandarin" },
  { name: "the Fishing Guild docks", x1: 2570, x2: 2630, y1: 3400, y2: 3440, kingdom: "kandarin" },
  { name: "Piscatoris", x1: 2290, x2: 2360, y1: 3680, y2: 3720, kingdom: "kandarin" },
]);

const CATCH_MULTIPLIER = 1.5;
const XP_BONUS = 0.5;
// The run lasts ~30 minutes, then the shoal is gone for 15-40 minutes.
const RUN_TICKS = 3000;
const COOLDOWN_MIN_TICKS = 1500;
const COOLDOWN_JITTER_TICKS = 2500;
// Checked every 5 minutes.
const CHECK_TICKS = 500;
const FOUND_ATTRIBUTE = "fishing:shoal-found-run";

let api = null;
let core = null;
let active = null; // { siteIndex, endsAt }
let cooldownUntil = 0;
let lastSiteIndex = -1;
let runId = 0;

function currentSite() {
  return active ? SITES[active.siteIndex] : null;
}

function isActiveAt(x, y) {
  const site = currentSite();
  return !!site && x >= site.x1 && x <= site.x2 && y >= site.y1 && y <= site.y2;
}

function pickSite(random = Math.random) {
  const options = SITES.map((_, index) => index).filter((index) => index !== lastSiteIndex);
  return options[Math.floor(random() * options.length)];
}

function startRun(random = Math.random) {
  const siteIndex = pickSite(random);
  lastSiteIndex = siteIndex;
  runId += 1;
  active = { siteIndex, endsAt: Date.now() + RUN_TICKS * 600, id: runId };
  const site = SITES[siteIndex];
  spreadRumor(
    api, site.kingdom,
    `Anglers whisper the salmon are running on ${site.name} - get there before the word spreads!`,
  );
  api.log("shoal-run started", { site: site.name });
}

function endRun() {
  const site = currentSite();
  active = null;
  cooldownUntil = Date.now() + (COOLDOWN_MIN_TICKS + Math.floor(Math.random() * COOLDOWN_JITTER_TICKS)) * 600;
  if (site) {
    spreadRumor(api, site.kingdom, `The run is over on ${site.name} - the shoal has moved on.`);
    api.log("shoal-run ended", { site: site.name });
  }
}

function checkRun() {
  const now = Date.now();
  if (active && now >= active.endsAt) {
    endRun();
  } else if (!active && now >= cooldownUntil) {
    startRun();
  }
}

function onCatchChance(event) {
  const spot = event.spot;
  if (!spot || !(event.multiplier > 0)) return;
  if (isActiveAt(spot.x, spot.y)) {
    event.multiplier *= CATCH_MULTIPLIER;
  }
}

function onSuccess(event) {
  const { player, spot } = event;
  if (!spot || !event.fish || !isActiveAt(spot.x, spot.y)) return;
  event.shoalRun = true;

  // First cast on a run: the water tells you before anyone else does.
  if (Number(player.getAttribute(FOUND_ATTRIBUTE)) !== active.id) {
    player.setAttribute(FOUND_ATTRIBUTE, active.id);
    player.sendMessage("The water boils with fish - a shoal is running here!");
  }

  player.getSkillManager().addExperiences(core.Skill.FISHING, event.fish.experience * XP_BONUS);

  // The frenzy strips bait fast: one extra bait per catch while the run is on.
  if (event.baitId != null && player.getInventory().contains(event.baitId)) {
    player.getInventory().deleteNumber(event.baitId, 1);
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("fishing:catch-chance", onCatchChance);
  api.onCustomEvent("fishing:success", onSuccess);
  api.getTaskManager().submit(new (class extends core.Task {
    constructor() { super(CHECK_TICKS); }
    execute() { checkRun(); }
  })());
  api.log("registered", { sites: SITES.length });
}

module.exports = {
  attach, currentSite, isActiveAt, startRun, endRun, checkRun,
  SITES, CATCH_MULTIPLIER, XP_BONUS, FOUND_ATTRIBUTE,
  _test: { onCatchChance, onSuccess, pickSite },
};
