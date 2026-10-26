/**
 * Dominic Onion, as recorded (rsprox 234/03279, 224/01512; nightmare-zone.json `lines`):
 * - Talk-to: "Welcome to the Nightmare Zone!..." and the menu (who he is, the place, the dreams,
 *   choosing a dream); with a dream prepared, "You haven't started that dream..." (Wiki);
 * - Dream (op3): straight to "Which dream would you like to experience?", or, with one prepared,
 *   "I've already created a dream for you. Do you want me to cancel it?";
 * - a dream: Practice (free; the boss from the list menu, an unfinished quest shown "not
 *   complete"), Endurance (1,000 / 5,000) or Rumble (2,000 / 6,000), each Normal or Hard; the fee
 *   is agreed now and taken from the coffer when the dream starts (Dream.NightmareZone);
 * - "Previous: <dream>" repeats the last one started.
 * Wiki: a dream needs at least five of the bosses' quests done. Customisable Rumbles (the boss
 * toggles) are not offered yet.
 */
const Common = require("./Common.NightmareZone");

const MODES = ["practice", "endurance", "rumble"];
const MODE_NAMES = { practice: "Practice", endurance: "Endurance", rumble: "Rumble" };
const lines = (name) => Common.data.lines[name];

function describe(dream) {
  const difficulty = dream.difficulty === "hard" ? " (hard)" : "";
  if (dream.mode === "practice") return `Practice: ${Common.bossName(dream.boss)}${difficulty}`;
  return `${MODE_NAMES[dream.mode]}${difficulty}`;
}

function mainMenu(player) {
  return ["Select an option", [
    ["Who are you?", () => Common.talk(player, lines("whoAreYou"), { menu: mainMenu(player) })],
    ["What is this place?", () => Common.talk(player, lines("whatIsThisPlace"), { menu: mainMenu(player) })],
    ["Can you tell me about the dreams?", () => Common.talk(player, lines("aboutDreams"), { menu: mainMenu(player) })],
    ["Can I choose a dream?", () => Common.talk(player, lines("chooseDream"), { done: () => dreamMenu(player) })],
    ["I'll come back another time.", () => Common.talk(player, lines("comeBack"))],
  ]];
}

function talkTo({ player }) {
  if (Common.preparedDream(player)) {
    Common.talk(player, lines("notStarted"), {
      menu: ["Select an option", [
        ["I want to change my dream.", () => Common.talk(player, lines("changeDream"), { at: { 1: () => Common.setPreparedDream(player, null) }, done: () => dreamMenu(player) })],
        ...mainMenu(player)[1].filter(([text]) => text !== "Can I choose a dream?"),
      ]],
    });
    return true;
  }
  Common.talk(player, lines("greeting"), { menu: mainMenu(player) });
  return true;
}

/** Op3: the dream menu at once, or the offer to cancel the one prepared. */
function dreamOption({ player }) {
  if (!Common.preparedDream(player)) {
    dreamMenu(player);
    return true;
  }
  Common.talk(player, lines("alreadyPrepared"), {
    menu: ["Discard the dream you set up?", [
      ["Yes, please cancel it.", () => Common.talk(player, lines("cancelIt"), { at: { 1: () => Common.setPreparedDream(player, null) } })],
      ["No, don't cancel it.", () => Common.talk(player, lines("keepIt"))],
    ]],
  });
  return true;
}

function dreamMenu(player) {
  if (Common.unlockedBosses(player).length < Common.data.questsNeeded) {
    player.sendMessage(Common.message("notEnoughQuests", { needed: Common.data.questsNeeded }));
    return;
  }
  const options = MODES.map((mode) => [MODE_NAMES[mode], () => difficultyMenu(player, mode)]);
  const previous = Common.previousDream(player);
  if (previous) options.push([`Previous: ${describe(previous)}`, () => agree(player, previous)]);
  Common.choose(player, "Which dream would you like to experience?", options);
}

function difficultyMenu(player, mode) {
  Common.choose(player, `${MODE_NAMES[mode]} - choose a difficulty mode.`, ["normal", "hard"].map((difficulty) => [
    difficulty === "normal" ? "Normal" : "Hard",
    () => (mode === "practice" ? bossMenu(player, difficulty) : agree(player, { mode, difficulty })),
  ]));
}

/** Recorded: the list menu "Practice: Normal mode", an unfinished quest's boss "not complete". */
function bossMenu(player, difficulty) {
  const labels = Common.data.bosses.map((boss) => {
    if (Common.questComplete(player, boss.quest)) return boss.label;
    return `${boss.label.split(": ")[0]}: ${Common.message("notComplete")}`;
  });
  const title = `Practice: ${difficulty === "normal" ? "Normal" : "Hard"} mode`;
  Common.listMenu(player, title, labels, (boss) => {
    if (!Common.questComplete(player, Common.data.bosses[boss].quest)) return;
    prepare(player, { mode: "practice", difficulty, boss });
  });
}

/** A paid dream: the price, "Agree to pay N coins?", then prepared. Practice is free. */
function agree(player, dream) {
  const cost = Common.data.prices[dream.mode]?.[dream.difficulty] ?? 0;
  if (!cost) {
    prepare(player, dream);
    return;
  }
  const article = dream.mode === "endurance" ? "an" : "a";
  const price = [["npc", Common.fill(lines("price")[0][1], { article, mode: MODE_NAMES[dream.mode], difficulty: dream.difficulty, cost: Common.commas(cost) }), lines("price")[0][2]]];
  Common.talk(player, price, {
    menu: [`Agree to pay ${Common.commas(cost)} coins?`, [
      ["Yes", () => prepare(player, dream)],
      ["No", () => {}],
    ]],
  });
}

function prepare(player, dream) {
  const cost = Common.data.prices[dream.mode]?.[dream.difficulty] ?? 0;
  const name = dream.mode === "practice" ? "preparedPractice" : dream.mode === "endurance" ? "preparedEndurance" : "preparedRumble";
  const [page] = lines(name);
  Common.setPreparedDream(player, dream);
  player.getPacketSender().sendSound?.(Common.data.sounds.prepared, 100, 0);
  Common.talk(player, [["npc", Common.fill(page[1], { cost: Common.commas(cost) }), page[2]]]);
}

function attachDominic(api) {
  api.onNpcInteraction("Dominic Onion", { "Talk-to": talkTo, Dream: dreamOption });
  api.onInterfaceActionClick(Common.listPicked);
  api.onCustomEvent("interface:close", Common.forgetList);
  api.onPlayerLogout(Common.forgetList);
}

module.exports = { attachDominic, talkTo, dreamOption, dreamMenu, bossMenu, agree, prepare, describe };
