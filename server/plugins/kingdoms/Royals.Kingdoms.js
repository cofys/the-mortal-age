"use strict";

/**
 * Royals.Kingdoms — the ROYAL CALENDAR. Marriages, births, deaths, and
 * coronations are realm announcements that shift tension and give the
 * citizens something to talk about.
 *
 * Every ~60 minutes, if a great power's court has been quiet for a while
 * (72h cooldown), something happens in the royal household:
 *
 *   marriage    a dynastic wedding — between two kingdoms half the time,
 *               which cools their border (-15 tension) and seals a royal
 *               marriage bond (Diplomacy's stewards negotiate easier).
 *   birth       celebration in the royal household; the streets gossip.
 *   death       a courtier or royal kin dies — mourning calms every border
 *               a little (-3). Never the great rulers: Roald, Lathas,
 *               Lowerniel, Amik Varze and the Consortium do not die in
 *               ambient events. Their fates are questline content (the
 *               bible locks this). A Misthalin death also stirs the
 *               succession whispers (see Succession.Kingdoms).
 *   coronation  a consort crowned after a recent wedding, or a lesser
 *               title changing hands — never a great throne. New reign,
 *               new hope: -10 tension on every border of the kingdom.
 *
 * Out (custom events, AGENTS.md: plugins talk through events):
 *   kingdom:royal-event { kingdomId, type: "marriage"|"birth"|"death"|"coronation",
 *                         text, parties? }
 *   kingdom:rumor { kingdomId, text }
 *
 * State: per-kingdom flags `royals:last-event-at`, `royals:last-marriage-at`,
 * `royals:marriage-bond:<otherId>`, and a rolling `royals:log` (last 3 events,
 * read by ::alliances). Announcement throttles are in-memory.
 *
 * Numbers live in DESIGN.md. Logging uses console.info/warn — api.log?.()
 * never reaches the log file.
 */

const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const Store = require("./KingdomStore");

// ~60 minutes at 600ms/tick. Royal news is rare by design.
const ROYALS_TICK_TICKS = 6000;
// A court's calendar: no more than one royal event per kingdom per 3 days.
const ROYAL_EVENT_COOLDOWN_MS = 72 * 60 * 60 * 1000;
// A coronation needs a recent wedding to crown.
const MARRIAGE_CORONATION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// Not every quiet court gets news every tick.
const EVENT_FIRE_CHANCE = 0.5;

const MARRIAGE_TENSION_DROP = 15;
const MOURNING_TENSION_DROP = 3;
const CORONATION_TENSION_DROP = 10;

let pluginApi = null;

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function nameOf(kingdomId) {
  return Store.getKingdom(kingdomId)?.name ?? kingdomId;
}

/** Send a message to every online player. Cosmetic; never throws. */
function announceToRealm(message) {
  try {
    pluginApi.core.World.getPlayers()
      .stream()
      .filter(Boolean)
      .forEach((p) => {
        try {
          p.sendMessage(message);
        } catch {
          // One deaf player doesn't silence the realm.
        }
      });
  } catch {
    // World not ready: nothing to announce to.
  }
}

// Noble names for the royal calendar. Minor houses and courtiers only —
// the great rulers never appear in these events (see header).
const NOBLES = {
  asgarnia: {
    male: ["Ser Baldrick", "Ser Osmund", "Ser Corvin", "Lord Harlan"],
    female: ["Dame Ysolde", "Lady Maren", "Lady Cressa", "Dame Elswyth"],
    houses: ["House Marbrand", "House Thorne", "House Wyndham"],
  },
  misthalin: {
    male: ["Lord Bannon", "Lord Cassian", "Ser Emeric", "Lord Dunstan"],
    female: ["Lady Serenna", "Lady Odilia", "Lady Rosalind", "Dame Petronel"],
    houses: ["House Bannon", "House Fitzwarren", "House Hallow"],
  },
  kandarin: {
    male: ["Lord Anselm", "Ser Roland", "Lord Percival", "Ser Gareth"],
    female: ["Lady Isolde", "Lady Vivienne", "Dame Arabella", "Lady Celandine"],
    houses: ["House Anselm", "House Mourne", "House Kestrel"],
  },
  morytania: {
    male: ["Lord Vasili", "Lord Morvain", "Dreadlord Sarn", "Lord Cazimir"],
    female: ["Lady Vesper", "Lady Morana", "Dreadlady Ilsa", "Lady Nocturne"],
    houses: ["House Vasili", "House Morvain", "the Dredge line"],
  },
  keldagrim: {
    male: ["Director Haldor", "Director Bromm", "Foreman Stenn", "Director Jarl"],
    female: ["Director Sanna", "Director Brynhild", "Foreman Astrid", "Director Liv"],
    houses: ["the Goldsmith company", "the Opal company", "the Coal company"],
  },
};

const FALLBACK_NOBLES = {
  male: ["Lord Aldric", "Ser Merrick"],
  female: ["Lady Elswyth", "Dame Rowan"],
  houses: ["an old house", "a proud house"],
};

function noblesOf(kingdomId) {
  return NOBLES[kingdomId] ?? FALLBACK_NOBLES;
}

function kingdomIds() {
  try {
    return Store.getKingdoms()
      .map((k) => k?.id)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Lower every tension involving this kingdom by `delta` (floored at 0). */
function calmBorders(kingdomId, delta) {
  for (const other of kingdomIds()) {
    if (other === kingdomId) continue;
    const raw = Store.getRawTension(kingdomId, other);
    const t = raw === null ? 20 : raw;
    Store.setRawTension(kingdomId, other, Math.max(0, t - delta));
  }
}

function logRoyalEvent(kingdomId, type, text) {
  const kingdom = Store.getKingdom(kingdomId);
  if (!kingdom) return;
  const log = Array.isArray(kingdom.flags?.["royals:log"]) ? kingdom.flags["royals:log"] : [];
  log.unshift({ at: Date.now(), type, text });
  Store.setFlag(kingdomId, "royals:log", log.slice(0, 3));
}

function recordEvent(kingdomId, type, text, parties = null) {
  Store.setFlag(kingdomId, "royals:last-event-at", Date.now());
  logRoyalEvent(kingdomId, type, text);
  Store.save();
  pluginApi.emitCustomEvent("kingdom:royal-event", { kingdomId, type, text, parties });
  announceToRealm(`[Realm] ${text}`);
  console.info("[royals] royal event", { kingdomId, type });
}

/** A dynastic wedding. Half the time it binds two kingdoms together. */
function royalMarriage(kingdomId) {
  const ids = kingdomIds().filter((id) => id !== kingdomId);
  const partner = ids.length > 0 && Math.random() < 0.5 ? pick(ids) : null;
  const a = noblesOf(kingdomId);
  const groom = pick(a.male);
  if (partner) {
    const b = noblesOf(partner);
    const bride = pick(b.female);
    const text =
      `${groom} of ${nameOf(kingdomId)} has wed ${bride} of ${nameOf(partner)} — ` +
      `bells rang in both capitals, and the envoys drank to open roads.`;
    Store.setFlag(kingdomId, `royals:marriage-bond:${partner}`, true);
    Store.setFlag(partner, `royals:marriage-bond:${kingdomId}`, true);
    Store.setFlag(kingdomId, "royals:last-marriage-at", Date.now());
    Store.setFlag(partner, "royals:last-marriage-at", Date.now());
    const raw = Store.getRawTension(kingdomId, partner);
    Store.setRawTension(kingdomId, partner, Math.max(0, (raw === null ? 20 : raw) - MARRIAGE_TENSION_DROP));
    recordEvent(kingdomId, "marriage", text, { a: kingdomId, b: partner });
    pluginApi.emitCustomEvent("kingdom:rumor", {
      kingdomId: partner,
      text: `They say the wedding gifts alone could fund a war — good thing it's a wedding, not a war.`,
    });
  } else {
    const house = pick(a.houses);
    const bride = pick(a.female);
    Store.setFlag(kingdomId, "royals:last-marriage-at", Date.now());
    recordEvent(
      kingdomId,
      "marriage",
      `${groom} of ${house} has wed ${bride} before the court of ${nameOf(kingdomId)}. ` +
        `The feasting lasted three days.`
    );
  }
}

/** Celebration in the royal household. Never a direct heir where the bible
 * forbids one — Misthalin gets kin of the court, never "a son for Roald". */
function royalBirth(kingdomId) {
  const texts = {
    misthalin: () => {
      const n = noblesOf(kingdomId);
      return (
        `A daughter was born to ${pick(n.houses)}, kin of the Varrock court — ` +
        `the bells rang, and the old king smiled, they say.`
      );
    },
    morytania: () =>
      `A new scion was presented at the dark court of Meiyerditch — pale, perfect, and already feared.`,
    keldagrim: () => {
      const n = noblesOf(kingdomId);
      return (
        `An heir was born to ${pick(n.houses)} — the company shares twitched before the afterbirth was buried.`
      );
    },
  };
  const text = texts[kingdomId]
    ? texts[kingdomId]()
    : `The royal household of ${nameOf(kingdomId)} celebrates a birth — ` +
      `${pick(noblesOf(kingdomId).female)} was delivered of a healthy child. The streets drank to it.`;
  recordEvent(kingdomId, "birth", text);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `They say the christening feast fed half the ${Store.getKingdom(kingdomId)?.capital ?? "capital"}.`,
  });
}

/** A courtier or royal kin dies. The great rulers never die in ambient
 * events — their fates are questline content, locked by the world bible. */
function royalDeath(kingdomId) {
  const n = noblesOf(kingdomId);
  const texts = {
    misthalin: () =>
      `Old ${pick(n.male)}, a counselor of the Varrock court for forty years, ` +
        `has died in his sleep. The court wears black; the succession is NOT discussed. Not aloud.`,
    kandarin: () =>
      `${pick(n.female)} of East Ardougne has died — of the plague, the criers say, ` +
        `though the West wall holds and no one may ask questions.`,
    morytania: () =>
      `${pick(n.male)} was found drained in his chambers — a court honor, ` +
        `they insist, though his servants wept.`,
    asgarnia: () =>
      `${pick(n.male)}, an old knight of the regency, has died of his wounds at last. ` +
        `Falador lowers its banners for a week.`,
    keldagrim: () =>
      `${pick(n.male)} of ${pick(n.houses)} has died — the company vote for his seat ` +
        `is already bought, they whisper.`,
  };
  const text = texts[kingdomId] ? texts[kingdomId]() : `${pick(n.male)} of the ${nameOf(kingdomId)} court has died. The court mourns.`;
  calmBorders(kingdomId, MOURNING_TENSION_DROP);
  recordEvent(kingdomId, "death", text);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `They say the mourning black will hang for a month. Even the tax collectors looked solemn.`,
  });
}

/** A consort crowned after a recent wedding, or a lesser title changing
 * hands. Never a great throne — those successions are questlines. */
function royalCoronation(kingdomId) {
  const n = noblesOf(kingdomId);
  const text = pick([
    `The new consort of ${nameOf(kingdomId)} was crowned today — ${pick(n.female)} ` +
      `wore the lesser crown, and the crowds cheered themselves hoarse.`,
    `A new ${kingdomId === "keldagrim" ? "Speaker of the Eight" : "warden of the marches"} ` +
      `was invested at ${Store.getKingdom(kingdomId)?.capital ?? "the capital"} — trumpets, oaths, and hope.`,
  ]);
  calmBorders(kingdomId, CORONATION_TENSION_DROP);
  recordEvent(kingdomId, "coronation", text);
  pluginApi.emitCustomEvent("kingdom:rumor", {
    kingdomId,
    text: `They say a new reign means new chances — the ambitious are already queuing.`,
  });
}

function eligibleKingdoms() {
  const now = Date.now();
  return kingdomIds().filter((id) => {
    const last = Store.getKingdom(id)?.flags?.["royals:last-event-at"] ?? 0;
    return now - last >= ROYAL_EVENT_COOLDOWN_MS;
  });
}

function royalTick() {
  try {
    const eligible = eligibleKingdoms();
    if (eligible.length === 0 || Math.random() >= EVENT_FIRE_CHANCE) return;
    const kingdomId = pick(eligible);
    const lastMarriage = Store.getKingdom(kingdomId)?.flags?.["royals:last-marriage-at"] ?? 0;
    const canCrown = Date.now() - lastMarriage < MARRIAGE_CORONATION_WINDOW_MS;
    const roll = Math.random();
    if (roll < 0.3) royalMarriage(kingdomId);
    else if (roll < 0.6) royalBirth(kingdomId);
    else if (roll < 0.85) royalDeath(kingdomId);
    else if (canCrown) royalCoronation(kingdomId);
    else royalMarriage(kingdomId); // no recent wedding to crown: marry instead
  } catch (error) {
    console.warn("[royals] tick failed", error?.message ?? error);
  }
  Store.save();
}

function startRoyalsTask(api) {
  class RoyalsTask extends Task {
    execute() {
      try {
        royalTick();
      } catch (error) {
        console.warn("[royals] tick failed", error?.message ?? error);
      }
    }
  }
  api.getTaskManager()?.submit(new RoyalsTask(ROYALS_TICK_TICKS));
  console.info("[royals] royal calendar armed", { tickTicks: ROYALS_TICK_TICKS });
}

function attachRoyals(api) {
  pluginApi = api;
  startRoyalsTask(api);
}

module.exports = attachRoyals;
module.exports.attachRoyals = attachRoyals;
module.exports.royalTick = royalTick;
module.exports.ROYALS_TICK_TICKS = ROYALS_TICK_TICKS;
