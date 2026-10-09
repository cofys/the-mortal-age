// Cache dbtable 78 (combat_interface_weapon_category): one row per weapon category, its
// number (column 0) and its combat styles (column 1: slot, name, description, graphic).
// Shared by dump-item-combat-styles.ts and sync-weapon-types.ts.
import { CacheIndexDat2 } from "../src/main/typescript/elvarg/game/cache/codec/rs/cache/CacheIndex";
import { ByteBuffer } from "../src/main/typescript/elvarg/game/cache/codec/rs/io/ByteBuffer";
import { Gamevals, GamevalKind } from "../src/main/typescript/elvarg/game/cache/Gamevals";

export const COMBAT_STYLE_TABLE_ID = 78;
const DBROW_ARCHIVE = 38;
const STRING_TYPES = new Set([36, 42]);
const CATEGORY_ROW_PREFIX = "combat_interface_";

export type CacheStyle = { slot: number; name: string; desc: string; graphic: number };

function decodeFields(buf: ByteBuffer, types: number[]): any[] {
    const fieldCount = buf.readUnsignedShortSmart();
    const out: any[] = new Array(fieldCount * types.length);
    for (let field = 0; field < fieldCount; field++) {
        for (let i = 0; i < types.length; i++) {
            const idx = field * types.length + i;
            out[idx] = STRING_TYPES.has(types[i]) ? buf.readString() : buf.readInt();
        }
    }
    return out;
}

export function decodeRow(buf: ByteBuffer): { tableId: number; columns: Map<number, any[]> } {
    const columns = new Map<number, any[]>();
    let tableId = -1;
    while (buf.remaining > 0) {
        const opcode = buf.readUnsignedByte();
        if (opcode === 0) break;
        if (opcode === 4) {
            tableId = buf.readVarInt2();
        } else if (opcode === 3) {
            buf.readUnsignedByte();
            for (let columnId = buf.readUnsignedByte(); columnId !== 255; columnId = buf.readUnsignedByte()) {
                const typeCount = buf.readUnsignedByte();
                const types: number[] = [];
                for (let i = 0; i < typeCount; i++) types.push(buf.readUnsignedShortSmart());
                columns.set(columnId, decodeFields(buf, types));
            }
        } else {
            buf.offset = buf.length;
        }
    }
    return { tableId, columns };
}

/** Each weapon category's number -> its combat styles. */
export function readCacheStyles(configs: CacheIndexDat2): Map<number, CacheStyle[]> {
    const byCategory = new Map<number, CacheStyle[]>();
    // Load the whole dbrow archive once: per-file getFile() re-reads the archive.
    const rows = configs.getArchive(DBROW_ARCHIVE);
    for (const fileId of rows.fileIds) {
        const file = rows.getFile(fileId);
        if (!file) continue;
        const row = decodeRow(new ByteBuffer(new Int8Array(file.data)));
        if (row.tableId !== COMBAT_STYLE_TABLE_ID) continue;
        const category = (row.columns.get(0) ?? [])[0];
        const values = row.columns.get(1) ?? [];
        const styles: CacheStyle[] = [];
        for (let i = 0; i + 3 < values.length; i += 4) {
            styles.push({ slot: values[i], name: values[i + 1], desc: values[i + 2], graphic: values[i + 3] });
        }
        byCategory.set(category, styles);
    }
    return byCategory;
}

/** Each category's cache name without the prefix ("hacksword", "scythe", ...) -> its number. */
export function readCategoryNumbers(configs: CacheIndexDat2, gamevals = new Gamevals()): Map<string, number> {
    const names = gamevals.namesOf(GamevalKind.DBROW);
    const rows = configs.getArchive(DBROW_ARCHIVE);
    const numbers = new Map<string, number>();
    for (const fileId of rows.fileIds) {
        const name = names.get(fileId);
        if (!name?.startsWith(CATEGORY_ROW_PREFIX)) continue;
        const file = rows.getFile(fileId);
        if (!file) continue;
        const row = decodeRow(new ByteBuffer(new Int8Array(file.data)));
        if (row.tableId !== COMBAT_STYLE_TABLE_ID) continue;
        numbers.set(name.slice(CATEGORY_ROW_PREFIX.length), (row.columns.get(0) ?? [])[0]);
    }
    return numbers;
}
