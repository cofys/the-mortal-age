import { addTransportsFromContents, parseItemVariations, type Transport } from "./transport/Transport";
import { TRANSPORT_TYPES } from "./transport/TransportType";

/** The plugin's files under client/public (upstream's ResourceLoader paths, relative to this). */
export const RESOURCE_DIR = "shortestpath";

/**
 * ResourceLoader.transports: every bundled transport TSV, in TransportType order, as one list; a
 * transport's position in it is the index the search reports back.
 */
export async function loadTransports(readText: (path: string) => Promise<string>): Promise<Transport[]> {
    const variations = parseItemVariations(await readText(`${RESOURCE_DIR}/item-variations.tsv`));
    const byOrigin = new Map<number, Transport[]>();
    const contents = await Promise.all(TRANSPORT_TYPES.map((type) => type.resourcePath ? readText(`${RESOURCE_DIR}/${type.resourcePath}`) : null));
    TRANSPORT_TYPES.forEach((type, i) => {
        const text = contents[i];
        if (text !== null) addTransportsFromContents(byOrigin, text, type, variations);
    });
    return [...byOrigin.values()].flat();
}
