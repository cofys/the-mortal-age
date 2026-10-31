"use strict";
// The cache's own completion contract, independent of Quest Helper and of our plugins.
//
// Quest DB table 0 column `endstate` is the progress value at or above which script 4029
// (QUEST_STATUS_GET) reports the quest complete. Comparing it against the value we actually send
// separates a wrong wire mapping from a wrong saved stage, and it does so without trusting either
// the guide or the plugin that mirrors it. Clock Tower is the worked example: the helper's last
// steps are 5-7, the cache requires 8.
//
// Table 0 also carries the quest's row name, so a quest is matched by name rather than by assuming
// RuneLite's Quest enum ordering equals the row id.
const QUEST_TABLE = 0;
const ENDSTATE_NAME = "endstate";
// Only used when this cache's gamevals do not name the column.
const ENDSTATE_COLUMN = 19;
const NAME_COLUMN = 2;
const normalise = (value) =>
  String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^(?:the|a|an)/, "");
let index;

/** The quest rows of this cache, by normalised display name. Memoised per cache instance. */
function rows(cache) {
  if (index?.cache === cache) return index.rows;
  const map = new Map();
  let columns = null;
  try {
    columns = cache?.getDbColumns?.(QUEST_TABLE) ?? null;
  } catch {
    columns = null;
  }
  try {
    for (const row of cache?.getDbTableRows?.(QUEST_TABLE) ?? []) {
      const nameAt = columns ? columns.indexOf("displayname") : -1;
      const name = row.string(nameAt >= 0 ? nameAt : NAME_COLUMN);
      const endstateAt = columns ? columns.indexOf(ENDSTATE_NAME) : -1;
      const endstate = row.int(endstateAt >= 0 ? endstateAt : ENDSTATE_COLUMN, Number.NaN);
      if (name && Number.isFinite(endstate)) map.set(normalise(name), { rowId: row.id, name, endstate });
    }
  } catch {
    // A cache without quest rows simply has no contract to offer.
  }
  index = { cache, rows: map };
  return map;
}

/** `{ rowId, name, endstate }` for a quest by name, or null when this cache has no such row. */
function contractFor(cache, questName) {
  if (!questName) return null;
  return rows(cache).get(normalise(questName)) ?? null;
}

/**
 * The contract against what the player's client would hold. `completeAt` reads the wire, `complete`
 * reads the saved stage; `agrees` is the point of the exercise.
 */
function contractState(cache, questName, wire, complete) {
  const contract = contractFor(cache, questName);
  if (!contract) return null;
  const completeAt = wire ? Number(wire.value) >= contract.endstate : null;
  return {
    rowId: contract.rowId,
    endstate: contract.endstate,
    completeAt,
    complete: complete === true,
    agrees: completeAt === null ? null : completeAt === complete,
  };
}

module.exports = { contractFor, contractState, QUEST_TABLE };
