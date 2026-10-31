"use strict";
// The bridge asks for state it was not given: `requests: [{kind, id}]` alongside `MISSING_STATE`.
// The browser answers them in QuestHelperPlugin.onMessage by recording the ids and including them
// in every later snapshot. A headless snapshot is built from server state, so nothing would ever
// answer them — the first step that reads a puzzle varbit (Ernest the Chicken's levers, for
// example) would come back as `activeStep: null`, which looks like a quest bug.
//
// Only what the server actually knows is filled. An unfillable request is reported instead of
// guessed: a made-up varp would make the guide disagree with the game for no visible reason.
const MAX_REQUESTS = 256;

/** Splits a bridge request list into the ids a headless snapshot can satisfy and the rest. */
function classify(requests) {
  const varbits = new Set();
  const unsupported = [];
  for (const request of (Array.isArray(requests) ? requests : []).slice(0, MAX_REQUESTS)) {
    const kind = String(request?.kind ?? "").split(".")[0];
    const id = Number(request?.id);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    if (kind === "varbit" || kind === "varbitDefinition") varbits.add(id);
    else unsupported.push({ kind, id });
  }
  return { varbits: [...varbits].sort((a, b) => a - b), unsupported };
}

/**
 * A copy of `snapshot` with the requested varbits and their definitions added, or null when none
 * could be read. `read.varbit(id)` is the server's own reader for the player's current value;
 * `read.definition(id)` is the cache's bit layout. QuestHelperRuntime.authoritative() then packs
 * each value back into its parent varp, so the bridge sees both the varbit and the varp.
 */
function fillRequested(snapshot, requests, read) {
  const { varbits, unsupported } = classify(requests);
  const values = { ...(snapshot.varbits ?? {}) };
  const definitions = { ...(snapshot.varbitDefinitions ?? {}) };
  const ids = [];
  for (const id of varbits) {
    const definition = read.definition(id);
    const value = read.varbit(id);
    if (!definition || !Number.isFinite(value)) continue;
    const varp = definition.baseVar ?? definition.varp;
    const lsb = definition.startBit ?? definition.lsb;
    const msb = definition.endBit ?? definition.msb;
    if (!Number.isInteger(varp) || !Number.isInteger(lsb) || !Number.isInteger(msb)) continue;
    definitions[id] = { varp, lsb, msb };
    values[id] = value | 0;
    ids.push(id);
  }
  if (ids.length === 0) return null;
  return { snapshot: { ...snapshot, varbits: values, varbitDefinitions: definitions }, ids, unsupported };
}

module.exports = { classify, fillRequested, MAX_REQUESTS };
