/**
 * Varrock politics — reframed ambient dialogue.
 *
 * Injects the succession vacuum into existing Varrock NPCs WITHOUT editing
 * npc-dialogues.json and without changing any canon line: the
 * "npc-dialogue:line" event's mutable `text` lets us append a short muttered
 * aside to a specific canon line. The canon words play verbatim; the aside is
 * the politics.
 *
 * A new player hears about the heirless king within minutes of entering
 * Varrock — from the palace guard, the priest, the bartender, and the
 * street-level brokers — quest or no quest. (The quest plugin consumes
 * Talk-to on its own stages, so these asides never double up with quest
 * dialogue.)
 *
 * No onNpcDialogueVariant hook: the canon variants for these NPCs carry no
 * succession content to select, so variant selection would add nothing.
 */
"use strict";

/** Same normalization the transcript runtime uses for text matching. */
function normText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Varrock Palace ground floor. Mirrors the quest plugin's rect. */
function inPalace(location) {
  if (!location || typeof location.getX !== "function") return false;
  const x = location.getX();
  const y = location.getY();
  return location.getZ() === 0 && x >= 3215 && x <= 3242 && y >= 3458 && y <= 3502;
}

function palaceGuardOnly(event) {
  if (event.definition?.getName?.() !== "Guard") return false;
  const location = event.npc?.getLocation?.() ?? event.npc?.getSpawnLocation?.() ?? null;
  return inPalace(location);
}

/**
 * npcId -> [{ match, aside, guard? }]. `match` is pre-normalized canon line
 * text; `guard` is an optional extra scope check.
 */
const ASIDES = new Map([
  [
    1312, // Bartender, Blue Moon Inn (tavern rumors)
    [
      {
        match: normText("What can I do yer for?"),
        aside: "Quiet in here. Everyone's too busy whispering about the king's health to drink.",
      },
    ],
  ],
  [
    5038, // Father Lawrence (the Church's growing power)
    [
      {
        match: normText("Hello adventurer, do you seek a quest?"),
        aside: "The Church grows strong while the crown withers. Pray for the king, adventurer - someone must.",
      },
    ],
  ],
  [
    2881, // Baraek (gang-adjacent info broker)
    [
      {
        match: normText("Sorry kiddo, I'm a fur trader not a damsel in distress."),
        aside:
          "Though if it's secrets you're after - both gangs are buying old church records these days. Ledgers, birth rolls. Odd, that.",
      },
    ],
  ],
  [
    5209, // Charlie the Tramp (Black Arm-adjacent)
    [
      {
        match: normText(
          "Charles. Charles E. Trampin' at your service. Now, about that change you were going to give me..."
        ),
        aside: "You didn't hear it from me, but the Black Arm's paying good coin for old church papers. Ask yourself why.",
      },
    ],
  ],
]);

/** Palace guards have no transcript page — they play the engine fallback line. */
const PALACE_GUARD_FALLBACK_MATCH = normText("Sorry, i've nothing interesting to talk about yet");
const PALACE_GUARD_ASIDE = "The king's not been seen in weeks. Don't quote me on that.";

function handleDialogueLine(event) {
  const text = normText(event.text);

  const rules = ASIDES.get(event.npcId);
  if (rules) {
    for (const rule of rules) {
      if (rule.guard && !rule.guard(event)) continue;
      if (text === rule.match) {
        event.text = `${event.text} ${rule.aside}`;
        return;
      }
    }
  }

  if (text === PALACE_GUARD_FALLBACK_MATCH && palaceGuardOnly(event)) {
    event.text = `${event.text} ${PALACE_GUARD_ASIDE}`;
  }
}

module.exports = {
  name: "VarrockPolitics",
  register(api) {
    api.onCustomEvent("npc-dialogue:line", handleDialogueLine);
  },
};
