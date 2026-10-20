// Reports where the Construction plugin's hand data (plugins/skills/construction/data) and the
// cache's POH tables part ways. The plugin reads names, levels, materials, menu icons, room costs
// and the viewer's furniture rows from the cache when it loads; the data files hold only what the
// cache lacks (experience, built loc ids, build animation, tools, upgrade sources, room
// templates). After a cache update this lists:
//   - furniture rows or rooms the data names that the cache no longer has (exit 1),
//   - furniture rows (table 110) and rooms (table 111) with no hand data yet: new furniture
//     needs its experience and built loc ids added to furniture.json,
//   - trophies (enum 5215) with no experience in trophy-experience.json.
//
//   yarn dump:construction
//
// Needs the cache in server/caches - run `yarn ensure-cache` first.
import * as fs from "fs";
import path = require("path");

import { CachePipeline } from "../src/main/typescript/elvarg/game/cache/CachePipeline";
import { CacheDefinitions } from "../src/main/typescript/elvarg/game/cache/CacheDefinitions";

const dataDir = path.resolve(__dirname, "..", "plugins", "skills", "construction", "data");

function readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
}

async function main() {
    await CachePipeline.initialize(path.resolve(__dirname, ".."));
    const furnitureTable = CacheDefinitions.getDbTableId("furniture")!;
    const roomTable = CacheDefinitions.getDbTableId("poh_room")!;
    const furnitureName = CacheDefinitions.getDbColumn(furnitureTable, "name")!;
    const roomName = CacheDefinitions.getDbColumn(roomTable, "name")!;
    const roomType = CacheDefinitions.getDbColumn(roomTable, "room_type")!;
    const problems: string[] = [];
    const notes: string[] = [];

    const furniture = readJson<{ key: string; menuRowId?: number }[]>("furniture.json");
    const usedRows = new Set<number>();
    for (const entry of furniture) {
        if (entry.menuRowId == null) continue; // not POH furniture (raid storage units)
        const row = CacheDefinitions.getDbRow(entry.menuRowId);
        if (row?.tableId !== furnitureTable) problems.push(`${entry.key}: furniture row ${entry.menuRowId} is gone`);
        usedRows.add(entry.menuRowId);
    }
    for (const row of CacheDefinitions.getDbTableRows(furnitureTable)) {
        if (!usedRows.has(row.id)) {
            notes.push(`furniture row ${row.id} ${CacheDefinitions.getDbRowName(row.id)} ("${row.column(furnitureName)[0]}") is not in furniture.json`);
        }
    }

    const rooms = readJson<{ key: string; id: number }[]>("rooms.json");
    const roomRows = new Map(CacheDefinitions.getDbTableRows(roomTable).map((row) => [row.int(roomType, -1), row]));
    for (const room of rooms) if (!roomRows.has(room.id)) problems.push(`room ${room.key}: no poh_room row with id ${room.id}`);
    for (const [id, row] of roomRows) {
        if (id > 0 && !rooms.some((room) => room.id === id)) notes.push(`poh_room id ${id} ("${row.column(roomName)[0]}") is not in rooms.json`);
    }

    const experience = readJson<Record<string, unknown>>("trophy-experience.json");
    for (const value of CacheDefinitions.getEnumValues(5215).values()) {
        const name = CacheDefinitions.getDbRowName(Number(value));
        if (name && !experience[name]) notes.push(`trophy ${name} has no experience in trophy-experience.json`);
    }

    for (const problem of problems) console.log(`problem: ${problem}`);
    for (const note of notes) console.log(`note: ${note}`);
    if (problems.length) process.exit(1);
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
