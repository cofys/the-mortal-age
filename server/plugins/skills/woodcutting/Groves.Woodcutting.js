/**
 * Woodcutting groves: where you chop matters as much as what you chop.
 *
 * Named groves drawn on real OSRS geography (the world comes from the cache),
 * each with its own character: safe bankside groves for the steady living,
 * the Blightwood's haunted bounty, the Frozen Copse's lonely pines. A grove
 * multiplies the cut chance and XP of every roll inside it, and stamps
 * event.grove on "woodcutting:cut-chance"/"woodcutting:success" for the later
 * depth modules.
 *
 * The Timber Drive: the crown's timber gangs mark one grove at a time for
 * ~30 minutes (+50% cut chance, +50% XP). Nobody is told directly - arrival
 * and departure seed citizen rumors and gossip, so the first axe there gets
 * rich. Every log cut on a drive feeds the war effort (see Supply.Woodcutting).
 *
 * Kingdom forestry policy: while a kingdom's quartermaster cries for supplies
 * ("kingdom:war-demand" inside the quota window), that kingdom's groves work
 * wartime quotas - +15% XP, and citizens talk about it.
 *
 * Attaches first of the depth modules: it stamps event.grove / event.drive
 * for Weather/Wilderness/Mastery/Supply.
 */
const { spreadRumor } = require("./Rumors.Woodcutting");

const GROVES = Object.freeze([
  {
    name: "the Seers' Village groves", short: "seers",
    x1: 2680, x2: 2735, y1: 3420, y2: 3475, z: 0, kingdom: "kandarin",
    cut: 1.0, xp: 1.0, blurb: "yews and maples by the bank",
  },
  {
    name: "the Lumbridge pines", short: "lumbridge",
    x1: 3200, x2: 3260, y1: 3190, y2: 3240, z: 0, kingdom: "misthalin",
    cut: 1.05, xp: 1.0, blurb: "fast young wood for learning axes",
  },
  {
    name: "the Woodcutting Guild grounds", short: "guild",
    x1: 1560, x2: 1660, y1: 3470, y2: 3520, z: 0, kingdom: "kandarin",
    cut: 1.0, xp: 1.0, blurb: "yew, magic and redwood under the guild's eye",
  },
  {
    name: "the Blightwood", short: "blightwood",
    x1: 3540, x2: 3600, y1: 3230, y2: 3300, z: 0, kingdom: "morytania",
    cut: 1.2, xp: 1.1, blurb: "blisterwood in the haunted woods - the trees are not the danger",
  },
  {
    name: "the Frozen Copse", short: "frozen",
    x1: 2840, x2: 2900, y1: 3930, y2: 3980, z: 0, kingdom: "kandarin",
    cut: 1.1, xp: 1.0, blurb: "arctic pine, far from everything",
  },
]);

const KINGDOM_NAMES = Object.freeze({
  asgarnia: "Asgarnia",
  misthalin: "Misthalin",
  kandarin: "Kandarin",
  morytania: "Morytania",
  keldagrim: "Keldagrim",
});

const DRIVE_CUT_MULTIPLIER = 1.5;
const DRIVE_XP_BONUS = 0.5;
const QUOTA_XP_BONUS = 0.15;
// A war demand keeps wartime quotas up for half an hour after the last cry.
const QUOTA_WINDOW_MS = 30 * 60 * 1000;
// The drive lasts ~30 minutes, then the gangs move on for 15-40 minutes.
const DRIVE_TICKS = 3000;
const DRIVE_COOLDOWN_MIN_TICKS = 1500;
const DRIVE_COOLDOWN_JITTER_TICKS = 2500;
// Checked every 5 minutes.
const CHECK_TICKS = 500;
const FOUND_ATTRIBUTE = "woodcutting:grove-drive-found";

let api = null;
let core = null;
let drive = null; // { groveIndex, endsAt, id }
let driveCooldownUntil = 0;
let lastGroveIndex = -1;
let driveId = 0;
// kingdomId -> timestamp of the last war demand heard.
const lastWarDemandAt = new Map();

function inRect(rect, x, y, z) {
  return z === rect.z && x >= rect.x1 && x <= rect.x2 && y >= rect.y1 && y <= rect.y2;
}

function groveAt(x, y, z = 0) {
  if (x == null || y == null) return null;
  return GROVES.find((grove) => inRect(grove, x, y, z)) ?? null;
}

function driveGrove() {
  return drive ? GROVES[drive.groveIndex] : null;
}

function isActiveAt(x, y, z = 0) {
  const grove = driveGrove();
  return !!grove && inRect(grove, x, y, z);
}

function pickGrove(preferKingdom = null, random = Math.random) {
  let options = GROVES.map((_, index) => index).filter((index) => index !== lastGroveIndex);
  if (preferKingdom) {
    const home = options.filter((index) => GROVES[index].kingdom === preferKingdom);
    if (home.length > 0) options = home;
  }
  return options[Math.floor(random() * options.length)];
}

function startDrive(preferKingdom = null, random = Math.random) {
  const groveIndex = pickGrove(preferKingdom, random);
  lastGroveIndex = groveIndex;
  driveId += 1;
  drive = { groveIndex, endsAt: Date.now() + DRIVE_TICKS * 600, id: driveId };
  const grove = GROVES[groveIndex];
  const kingdom = KINGDOM_NAMES[grove.kingdom] ?? grove.kingdom;
  spreadRumor(
    api, grove.kingdom,
    `The crown's timber gangs are working ${grove.name} - axes wanted, and the pay is in full bellies! (${kingdom})`,
  );
  api.log("timber drive started", { grove: grove.name });
}

function endDrive() {
  const grove = driveGrove();
  drive = null;
  driveCooldownUntil = Date.now() + (DRIVE_COOLDOWN_MIN_TICKS + Math.floor(Math.random() * DRIVE_COOLDOWN_JITTER_TICKS)) * 600;
  if (grove) {
    spreadRumor(api, grove.kingdom, `The timber gangs have moved on from ${grove.name}.`);
    api.log("timber drive ended", { grove: grove.name });
  }
}

function checkDrive() {
  const now = Date.now();
  if (drive && now >= drive.endsAt) {
    endDrive();
  } else if (!drive && now >= driveCooldownUntil) {
    startDrive();
  }
}

/** Wartime forestry quotas: the crown wants timber, yields rise. */
function quotasActive(kingdomId) {
  const last = lastWarDemandAt.get(kingdomId) ?? 0;
  return Date.now() - last < QUOTA_WINDOW_MS;
}

function onWarDemand(event) {
  const kingdomId = event?.kingdomId;
  if (!kingdomId) return;
  const wasActive = quotasActive(kingdomId);
  lastWarDemandAt.set(kingdomId, Date.now());
  if (!wasActive) {
    const kingdom = KINGDOM_NAMES[kingdomId] ?? kingdomId;
    spreadRumor(
      api, kingdomId,
      `Wartime quotas in ${kingdom} - the crown pays full XP for every log from the groves!`,
    );
  }
  // A hungry kingdom pulls the next drive its way, if the gangs are idle.
  if (!drive && Date.now() >= driveCooldownUntil) {
    startDrive(kingdomId);
  }
}

function onCutChance(event) {
  if (!(event.multiplier > 0)) return;
  const { x, y, z } = event.location ?? {};
  const grove = groveAt(x, y, z);
  event.grove = grove;
  if (!grove) return;
  event.multiplier *= grove.cut;
  if (isActiveAt(x, y, z)) {
    event.multiplier *= DRIVE_CUT_MULTIPLIER;
  }
}

function onSuccess(event) {
  const { player, location } = event;
  const { x, y, z } = location ?? {};
  const grove = groveAt(x, y, z);
  event.grove = grove;
  if (!grove || event.xpReward == null) return;

  let xp = event.xpReward;
  if (isActiveAt(x, y, z)) {
    event.drive = true;
    xp *= 1 + DRIVE_XP_BONUS;
    // First log on a drive: the gang's foreman tells you before anyone else does.
    if (Number(player.getAttribute(FOUND_ATTRIBUTE)) !== drive.id) {
      player.setAttribute(FOUND_ATTRIBUTE, drive.id);
      player.sendMessage("The timber gang's foreman waves you over - the drive is on here!");
    }
  }
  if (quotasActive(grove.kingdom)) {
    event.quota = true;
    xp *= 1 + QUOTA_XP_BONUS;
  }
  const bonus = xp - event.xpReward;
  if (bonus > 0) {
    player.getSkillManager().addExperiences(core.Skill.WOODCUTTING, bonus);
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("woodcutting:cut-chance", onCutChance);
  api.onCustomEvent("woodcutting:success", onSuccess);
  api.onCustomEvent("kingdom:war-demand", onWarDemand);
  api.getTaskManager().submit(new (class extends core.Task {
    constructor() { super(CHECK_TICKS); }
    execute() { checkDrive(); }
  })());
  api.log("registered", { groves: GROVES.length });
}

module.exports = {
  attach, groveAt, driveGrove, isActiveAt, quotasActive, startDrive, endDrive, checkDrive,
  GROVES, DRIVE_CUT_MULTIPLIER, DRIVE_XP_BONUS, QUOTA_XP_BONUS, FOUND_ATTRIBUTE,
  _test: { onCutChance, onSuccess, onWarDemand, pickGrove, lastWarDemandAt },
};
