"use strict";

const { CacheDefinitions } = require("./Core.Construction");

// Ids by the cache's own gameval names (the names rsprox prints). A name this cache doesn't have
// stops the plugin loading, so a cache update can't leave a stale id behind.
function lookup(kind, find) {
  return (name) => {
    const id = find(name);
    if (id == null) throw new Error(`Construction: the cache has no ${kind} named ${name}`);
    return id;
  };
}

const loc = lookup("loc", (name) => CacheDefinitions.getLocId(name));
const npc = lookup("npc", (name) => CacheDefinitions.getNpcId(name));
const obj = lookup("obj", (name) => CacheDefinitions.getObjId(name));
const seq = lookup("seq", (name) => CacheDefinitions.getSeqId(name));
const spotanim = lookup("spotanim", (name) => CacheDefinitions.getSpotanimId(name));
const varbit = lookup("varbit", (name) => CacheDefinitions.getVarbitId(name));
const varp = lookup("varp", (name) => CacheDefinitions.getVarpId(name));
const iface = lookup("interface", (name) => CacheDefinitions.getInterfaceId(name));
const component = lookup("component", (name) => CacheDefinitions.getComponentId(name));

Object.assign(module.exports, { loc, npc, obj, seq, spotanim, varbit, varp, iface, component });
