"use strict";

/**
 * Data.Backgrounds — the six pasts a new life can come from.
 *
 * Picked right after the home (Origin) in the creation flow. Each background
 * carries:
 *   id            — kebab-case background id, persisted as `background:id`
 *   name          — display name ("Farmer")
 *   epithet       — one short line under the name on the pick list
 *   lens          — one paragraph of "your past": who you were and why you left
 *   skills        — starting boosts as [Skill key, level] pairs. Modest:
 *                   a primary at 10, a secondary at 5. Never combat-maxing.
 *   kit           — starting items as [ItemIdentifiers key, amount] pairs.
 *                   Flavor and a head start, not power.
 *   contactRole   — citizen roster role to find as the player's contact in
 *                   their home city (guard, merchant, commoner). The flow
 *                   picks a real citizen of that role in the player's kingdom.
 *   contactBlurb  — how the contact is introduced when no matching citizen
 *                   exists (fallback text).
 *   hook          — the story hook: one or two sentences of unfinished
 *                   business, shown once at creation. Seeds for future quests.
 *
 * Item keys must exist on api.core.ItemIdentifiers; Backgrounds.Origins
 * validates them at attach so a typo fails loudly at startup.
 * Skill keys must exist on api.core.Skill.
 */

const BACKGROUNDS = [
  {
    id: "farmer",
    name: "Farmer",
    epithet: "Hands that know the soil",
    lens:
      "You were raised on a smallholding outside the city walls — up before dawn, " +
      "hands in the dirt, the seasons for a master. The farm is still there, and " +
      "whoever works it now is barely keeping it. You left to earn coin the land " +
      "couldn't give you, but the land doesn't let go of its own.",
    skills: [
      ["FARMING", 10],
      ["COOKING", 5],
    ],
    kit: [
      ["MARIGOLD_SEED", 5],
      ["BREAD", 2],
    ],
    contactRole: "commoner",
    contactBlurb: "a market gardener who remembers your family",
    hook: "Your family's smallholding is failing. Someone back home is waiting for coin only you can send.",
  },
  {
    id: "soldier",
    name: "Soldier",
    epithet: "Discharged, not defeated",
    lens:
      "You wore a kingdom's colors and learned the spear the hard way — in " +
      "formation, in mud, in the quiet after. Your service ended the way most " +
      "do: not with glory, with a paper and a handshake. The drills never " +
      "leave you, though. Neither do the names of the ones who didn't come home.",
    skills: [
      ["ATTACK", 10],
      ["DEFENCE", 5],
    ],
    kit: [
      ["BRONZE_MED_HELM", 1],
      ["COINS", 15],
    ],
    contactRole: "guard",
    contactBlurb: "a veteran of the watch who served in your company",
    hook: "Your old sergeant owes you a favor — and favors in wartime are worth more than coin.",
  },
  {
    id: "merchant",
    name: "Merchant",
    epithet: "Coin finds coin",
    lens:
      "You grew up behind a stall counter, weighing goods and reading faces " +
      "before you could read letters. You know what things are worth and, " +
      "more importantly, what people will pay. Your last venture went bad — " +
      "a caravan, a storm, a partner who vanished — and you're starting over " +
      "with empty pockets and a full head.",
    skills: [
      ["CRAFTING", 5],
      ["THIEVING", 5],
    ],
    kit: [["COINS", 150]],
    contactRole: "merchant",
    contactBlurb: "an old trade partner who still trusts your eye",
    hook: "Your vanished partner was last seen heading for the markets. Someone knows where the caravan money went.",
  },
  {
    id: "urchin",
    name: "Urchin",
    epithet: "Raised by the streets",
    lens:
      "No farm, no colors, no stall. The city raised you — its alleys for " +
      "hallways, its rooftops for a roof. You learned to move quietly, to " +
      "take what the careless leave, to be gone before anyone looks twice. " +
      "Nobody gave you anything. Everything you have, you earned the hard way.",
    skills: [
      ["THIEVING", 10],
      ["AGILITY", 5],
    ],
    kit: [["BREAD", 3]],
    contactRole: "commoner",
    contactBlurb: "a fence who bought your first stolen loaf",
    hook: "Someone from the old crew is in real trouble with the watch — and they know where you sleep.",
  },
  {
    id: "crafter",
    name: "Crafter",
    epithet: "Apprenticed to a master",
    lens:
      "Seven years at a master's bench: the chisel, the hammer, the patience. " +
      "You can look at a thing and see how it was made — and how to make it " +
      "better. Then the workshop burned, master and all, and the guild " +
      "apprenticeship papers with it. Your hands remember, even if no guild " +
      "will vouch for you yet.",
    skills: [
      ["CRAFTING", 10],
      ["SMITHING", 5],
    ],
    kit: [
      ["CHISEL", 1],
      ["HAMMER", 1],
    ],
    contactRole: "commoner",
    contactBlurb: "a master artisan who knew your master",
    hook: "The fire that took the workshop wasn't an accident. Your master kept a second ledger — and someone wants it.",
  },
  {
    id: "fisher",
    name: "Fisher",
    epithet: "The water provides",
    lens:
      "Dawn on the water, nets heavy, gulls screaming — that was your whole " +
      "world. You know the currents, the seasons of fish, the moods of the " +
      "sea better than you know most people. But the sea gives and the sea " +
      "takes, and lately it has been taking more than its share.",
    skills: [
      ["FISHING", 10],
      ["COOKING", 5],
    ],
    kit: [
      ["FISHING_ROD", 1],
      ["FEATHER", 50],
    ],
    contactRole: "commoner",
    contactBlurb: "an old fisher who taught you the currents",
    hook: "Your father's boat went down in a storm last season. The wreck was never found — and neither was its cargo.",
  },
];

const BY_ID = new Map(BACKGROUNDS.map((b) => [b.id, b]));

/** Fail loudly at startup on a bad ItemIdentifiers key (same rule as origins). */
function validateItemKeys(Items) {
  for (const bg of BACKGROUNDS) {
    for (const [key] of bg.kit) {
      if (Items[key] === undefined) {
        throw new Error(`[backgrounds] unknown ItemIdentifiers key '${key}' in background '${bg.id}' kit`);
      }
    }
  }
}

/** Fail loudly at startup on a bad Skill key. */
function validateSkillKeys(Skill) {
  for (const bg of BACKGROUNDS) {
    for (const [key] of bg.skills) {
      if (Skill[key] === undefined) {
        throw new Error(`[backgrounds] unknown Skill key '${key}' in background '${bg.id}' skills`);
      }
    }
  }
}

module.exports = { BACKGROUNDS, BY_ID, validateItemKeys, validateSkillKeys };
