/**
 * A bucket used on the pool of slime under the Ectofuntus fills every bucket in the inventory, one
 * after another (Wiki). As captured (rsprox recording 377, rev 231): quest_ahoy_human_filling_bucket
 * on the use, and two ticks later a bucket becomes a bucket of slime with synth 1132 and, the first
 * time only, "You fill the bucket with ectoplasm."; each next bucket starts two ticks after the
 * last fill, so one fills every four ticks (rev 229's recording 2765 was every three).
 */
const Common = require("./Common.Ectofuntus");

const FILL_SEQ = "quest_ahoy_human_filling_bucket";
const FILL_SOUND = 1132;
const FILL_TICKS = 2;
const GAP = 2;

/** Fills one bucket; false when none is left. */
function fill(player, first) {
  const { ItemIdentifiers } = Common.core;
  if (!Common.swap(player, ItemIdentifiers.BUCKET, ItemIdentifiers.BUCKET_OF_SLIME)) return false;
  Common.sound(player, FILL_SOUND);
  if (first) Common.spam(player, "You fill the bucket with ectoplasm.");
  return player.getInventory().contains(ItemIdentifiers.BUCKET);
}

function fillBuckets({ player }) {
  Common.animate(player, FILL_SEQ);
  let fillAt = FILL_TICKS;
  let animateAt = -1;
  let filled = 0;
  Common.run(player, (tick) => {
    if (tick === animateAt) Common.animate(player, FILL_SEQ);
    if (tick !== fillAt) return true;
    if (!fill(player, filled++ === 0)) return false;
    animateAt = tick + GAP;
    fillAt = animateAt + FILL_TICKS;
    return true;
  });
  return true;
}

module.exports = function attachSlime(api) {
  api.onItemOnObject("Bucket", "Pool of Slime", fillBuckets);
};
