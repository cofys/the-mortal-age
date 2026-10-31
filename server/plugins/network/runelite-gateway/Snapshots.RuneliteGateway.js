"use strict";

// Leave room for the envelope and numeric chunk metadata inside the existing16KiB limit.
const CHUNK_BYTES = 14_000;

function snapshotChunks(event) {
  const chunks = [{ players: [], npcs: [] }];
  let size = 0;
  for (const kind of ["players", "npcs"]) {
    for (const source of event[kind]) {
      const value = kind === "players"
        ? { ...source, appearance: source.appearance.toString("base64") }
        : { ...source };
      const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
      if (bytes > CHUNK_BYTES) throw new Error("Actor view exceeds gateway snapshot limit");
      if (size + bytes > CHUNK_BYTES) {
        chunks.push({ players: [], npcs: [] });
        size = 0;
      }
      chunks[chunks.length - 1][kind].push(value);
      size += bytes;
    }
  }
  return chunks.map((chunk, part) => ({
    type: "sync", version: 1, tick: event.tick, localIndex: event.player.getIndex(),
    baseX: event.baseX, baseY: event.baseY, part, parts: chunks.length, ...chunk,
  }));
}

module.exports = { snapshotChunks };
