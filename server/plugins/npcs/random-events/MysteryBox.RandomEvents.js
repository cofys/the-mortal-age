"use strict";

// Mystery box (Quiz Master reward). OSRS rolls 1/256 for the stale baguette, then either the
// free-to-play or the members table. The members clue-scroll and rare-drop-table slots are
// represented by their common outcomes here; see SOURCES.md.
const ids = { COINS: 995, LAMP: 2528, CABBAGE: 1965, DIAMOND: 1601, BUCKET: 1925, FLYER: 956,
  STEEL_PLATEBODY: 1119, OLD_BOOT: 685, BODY_RUNE: 559, ONION: 1957, MITHRIL_SCIMITAR: 1329,
  CASKET: 405, NATURE_RUNE: 561, STALE_BAGUETTE: 20590, LAW_RUNE: 563, DEATH_RUNE: 560,
  RUNE_JAVELIN: 830, UNCUT_DRAGONSTONE: 1631, TOOTH_HALF_OF_KEY: 985, LOOP_HALF_OF_KEY: 987,
  CLUE_SCROLL: 713 };

function pick(table) {
  return table[Math.floor(Math.random() * table.length)];
}

function roll(api) {
  if (Math.floor(Math.random() * 256) === 0) return [{ id: ids.STALE_BAGUETTE, amount: 1 }];
  const members = api.core.WorldDefinition.isMembersWorld();
  const table = [[ids.LAMP, 1], [ids.CABBAGE, 1], [ids.DIAMOND, 1], [ids.BUCKET, 1], [ids.FLYER, 1]];
  if (members) {
    table.push([ids.OLD_BOOT, 1], [ids.BODY_RUNE, 1], [ids.ONION, 1], [ids.MITHRIL_SCIMITAR, 1],
      [ids.CASKET, 1], [ids.STEEL_PLATEBODY, 1], [ids.NATURE_RUNE, 20],
      // Clue table: one easy scroll in five of them, otherwise a medium.
      [ids.CLUE_SCROLL, 1],
      // Rare drop table: its common useful outcomes.
      pick([[ids.RUNE_JAVELIN, 5], [ids.UNCUT_DRAGONSTONE, 1], [ids.TOOTH_HALF_OF_KEY, 1],
        [ids.LOOP_HALF_OF_KEY, 1], [ids.LAW_RUNE, 50], [ids.DEATH_RUNE, 50]]));
  } else {
    table.push([ids.STEEL_PLATEBODY, 1]);
  }
  const reward = pick(table);
  return [{ id: reward[0], amount: reward[1] }];
}

module.exports = { roll };
