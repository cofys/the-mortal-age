"use strict";

/**
 * Asides.Arrival — bartender dialogue asides.
 *
 * Follows the VarrockPolitics pattern exactly: canon lines play VERBATIM and
 * a short muttered aside is appended to a specific canon line. Canon is never
 * edited, npc-dialogues.json is never touched.
 *
 * Asides are flag-gated at dialogue time, so the tavern talk flips the moment
 * the world's state flips. Misthalin is deliberately skipped — the
 * bastard-of-varrock plugin owns Varrock's tavern politics; this module covers
 * the other four powers.
 *
 * The plague whisper in East Ardougne is the lie as ambient rumor (wanted).
 * The questline that exposes it is phase 10 and is not built here.
 */

const Common = require("./Common.Arrival");
const Rumors = require("./Rumors.Arrival");

/** Same normalization the transcript runtime uses for text matching. */
function normText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** npcId -> [{ match, aside, flag }]. `match` is pre-normalized canon text. */
const ASIDES = new Map([
  [
    1316, // Kaylee, The Rising Sun Inn, Falador (canon: "Heya! What can I get you?")
    [
      {
        match: normText("Heya! What can I get you?"),
        aside:
          "Mind the regent's men if you head up to the castle. They've been asking questions all week.",
        flag: { kingdomId: "asgarnia", key: "asgarnia:regency", equals: true },
      },
      {
        match: normText("Heya! What can I get you?"),
        aside:
          "Quiet in here lately. Everyone's still celebrating the king's return — even the regent's men.",
        flag: { kingdomId: "asgarnia", key: "asgarnia:regency", equals: false },
      },
    ],
  ],
  [
    1317, // Tina, The Flying Horse Inn, East Ardougne (canon: "Would you like to buy a drink?")
    [
      {
        match: normText("Would you like to buy a drink?"),
        aside:
          "…You didn't hear it from me, but my cousin swears no one's actually sick behind that wall.",
        flag: { kingdomId: "kandarin", key: "ardougne:plague-lie-active", equals: true },
      },
      {
        match: normText("Would you like to buy a drink?"),
        aside:
          "First round's on the house tonight — the wall's down and West Ardougne breathes again!",
        flag: { kingdomId: "kandarin", key: "ardougne:plague-lie-active", equals: false },
      },
    ],
  ],
]);

/** Engine fallback line for NPCs with no transcript page (VarrockPolitics precedent). */
const FALLBACK_MATCH = normText("Sorry, i've nothing interesting to talk about yet");

/**
 * Fallback-line bartenders in Morytania/Keldagrim: no transcript page, so any
 * line they speak is the engine fallback. Territory decides the aside.
 */
const FALLBACK_ASIDES = [
  {
    kingdomId: "morytania",
    aside: (flags) =>
      flags["morytania:salve-integrity"] >= 50
        ? "Drink up. The Salve holds — for now."
        : "Drink up. The river's gone quiet and the old magic's thinning.",
  },
  {
    kingdomId: "keldagrim",
    aside: (flags) =>
      flags["keldagrim:red-axe-threat"] === "war"
        ? "Ale's on short pour tonight. War in the deep tunnels."
        : "Ale's cold, the companies are jumpy, and the Red Axe stirs. Same as always, worse than ever.",
  },
];

function flagLive(rule) {
  const flags = Rumors.flagsFor(rule.kingdomId);
  const value = flags[rule.key];
  return rule.equals === undefined ? value !== undefined : value === rule.equals;
}

function handleDialogueLine(event) {
  const text = normText(event.text);

  const rules = ASIDES.get(event.npcId);
  if (rules) {
    for (const rule of rules) {
      if (text === rule.match && flagLive(rule.flag)) {
        event.text = `${event.text} ${rule.aside}`;
        return;
      }
    }
    return;
  }

  // Fallback-line bartenders outside Varrock's owned territory.
  if (text !== FALLBACK_MATCH) return;
  if (event.definition?.getName?.() !== "Bartender") return;
  const location = event.npc?.getLocation?.() ?? event.npc?.getSpawnLocation?.() ?? null;
  const kingdomId = Common.kingdomAt(location);
  const rule = FALLBACK_ASIDES.find((r) => r.kingdomId === kingdomId);
  if (rule) {
    event.text = `${event.text} ${rule.aside(Rumors.flagsFor(kingdomId))}`;
  }
}

module.exports = function attachAsides(api) {
  api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
};
