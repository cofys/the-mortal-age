const { Anim } = require("../constants");
const { ShortcutAnim, hops } = require("./builders");

/** Misthalin shortcut scripts (agility-shortcuts.json). */
module.exports = {
  /** Lumbridge castle basement: crawl through the hole, away from the player's side. */
  lumbridgeBasementHole: () => ({
    steps: ({ pos, obj }) => {
      const north = pos.y <= obj.y;
      return [{ move: [obj.x, north ? obj.y + 3 : obj.y - 1], anim: Anim.SQUEEZE_PIPE, speed: [0, 90], ticks: 2 }];
    },
  }),

  /** Draynor stepping stones over the River Lum: one stone per click, ashore off the last one. */
  draynorSteppingStones: ({ westStone, westShore, eastStone, eastShore }) => ({
    steps: ({ pos, obj }) => {
      const steps = hops([obj.x, obj.y]);
      const west = obj.x < pos.x;
      const lastStone = west ? westStone : eastStone;
      if (obj.x === lastStone[0] && obj.y === lastStone[1]) {
        steps.push({ wait: 1 }, { walk: [west ? westShore : eastShore] });
      }
      return steps;
    },
  }),

  /**
   * Zanaris jutting walls: shimmy past to the other side of `pivot`'s row. As captured (rsprox
   * 359, 424; southward): the side-step from cycle 28 to 124, sound 2489 and the message at once,
   * sound 2490 five ticks later.
   */
  zanarisJuttingWall: ({ pivot }) => ({
    steps: ({ pos, obj }) => {
      const southward = pos.y >= pivot;
      return [
        { sound: 2489 },
        { msg: "You try to squeeze past." },
        {
          move: [obj.x, southward ? obj.y - 1 : obj.y + 1],
          anim: southward ? ShortcutAnim.JUTTING_WALL_LEFT : ShortcutAnim.JUTTING_WALL_RIGHT,
          speed: [28, 124],
          ticks: 5,
        },
        { sound: 2490 },
      ];
    },
  }),
};
