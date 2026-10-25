import { fetchContent } from "../contentApi";

/** stockmarket_value statuses, as the rev 241 GE scripts read them: they retry until ready. */
export const PRICE_LOADING = 1;
export const PRICE_READY = 2;

let prices: Map<number, number> | undefined;
let loading: Promise<void> | undefined;
let revision = 0;

/** Loads the connected world's guide prices (/api/item-prices); a new login loads them again. */
export function loadItemPrices(): Promise<void> {
    prices = undefined;
    revision++;
    const request = fetchContent("/api/item-prices")
        .then((table: Record<string, number>) => {
            if (loading !== request) return;
            prices = new Map(Object.entries(table ?? {}).map(([id, price]) => [Number(id), Number(price)]));
            revision++;
        })
        .catch((error) => {
            if (loading !== request) return;
            console.warn("[item-prices] guide prices unavailable; store values are shown", error);
            prices = new Map();
            revision++;
        });
    loading = request;
    return request;
}

/** Changes when a login invalidates prices and when its request finishes. */
export function getItemPricesRevision(): number {
    return revision;
}

/** The guide price of an (unnoted) item: 0 when it has no quote, undefined while the table loads. */
export function guidePrice(itemId: number): number | undefined {
    if (!prices) {
        if (!loading) loadItemPrices();
        return undefined;
    }
    return prices.get(itemId) ?? 0;
}
