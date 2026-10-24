import { writeFile, rename } from "node:fs/promises";

const pricesDestination = new URL("../data/definitions/item-prices.json", import.meta.url);
const pricesTemporary = new URL("../data/definitions/item-prices.json.tmp", import.meta.url);
const marketDestination = new URL("../plugins/interface/data/grand-exchange.json", import.meta.url);
const marketTemporary = new URL("../plugins/interface/data/grand-exchange.json.tmp", import.meta.url);
const headers = { "User-Agent": "elvarg-typescript item-price fetcher" };
const signal = AbortSignal.timeout(30_000);

const ENDPOINTS = {
  latest: "https://prices.runescape.wiki/api/v2/osrs/latest",
  day: "https://prices.runescape.wiki/api/v2/osrs/24h",
  mapping: "https://prices.runescape.wiki/api/v2/osrs/mapping",
};

async function fetchJson(label, url) {
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error(`${label} fetch failed: HTTP ${response.status}`);
  return response.json();
}

function requireData(label, payload) {
  if (!payload?.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new Error(`${label} API returned no data object`);
  }
  return payload.data;
}

const safeInt = (value) => (Number.isSafeInteger(value) ? value : null);
const volume = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);

const [latestPayload, dayPayload, mapping] = await Promise.all([
  fetchJson("latest", ENDPOINTS.latest),
  fetchJson("24h", ENDPOINTS.day),
  fetchJson("mapping", ENDPOINTS.mapping),
]);

const latest = requireData("latest", latestPayload);
const day = requireData("24h", dayPayload);
if (!Object.keys(latest).length) throw new Error("Latest price API returned no item prices");
if (!Array.isArray(mapping) || !mapping.length) throw new Error("Mapping API returned no items");

const mapped = new Map();
for (const item of mapping) {
  if (item && Number.isSafeInteger(item.id)) mapped.set(item.id, item);
}
if (!mapped.size) throw new Error("Mapping API returned no item ids");

const ids = [...new Set([...Object.keys(latest).map(Number), ...mapped.keys()])]
  .filter((id) => Number.isSafeInteger(id) && id >= 0)
  .sort((a, b) => a - b);

const prices = {};
const market = {};
for (const id of ids) {
  const live = latest[id] ?? {};
  const recent = day[id] ?? {};
  const item = mapped.get(id);

  const high = safeInt(live.high);
  const low = safeInt(live.low);
  if (high != null || low != null) {
    prices[id] = {
      high,
      highTime: safeInt(live.highTime),
      low,
      lowTime: safeInt(live.lowTime),
    };
  }

  const traded = Math.min(
    Number.MAX_SAFE_INTEGER,
    volume(recent.highPriceVolume) + volume(recent.lowPriceVolume)
  );
  const limit = item && Number.isSafeInteger(item.limit) && item.limit > 0 ? item.limit : 0;
  if (traded > 0 || limit > 0) {
    market[id] = { volume: traded, limit };
  }
}

async function writeJson(destination, temporary, payload) {
  await writeFile(temporary, JSON.stringify(payload));
  await rename(temporary, destination);
}

await writeJson(pricesDestination, pricesTemporary, { data: prices });
await writeJson(marketDestination, marketTemporary, { data: market });
console.info(
  `Saved ${Object.keys(prices).length} prices to ${pricesDestination.pathname} and ` +
    `${Object.keys(market).length} GE quotes to ${marketDestination.pathname} ` +
    `(latest=${Object.keys(latest).length}, 24h=${Object.keys(day).length}, mapping=${mapped.size})`
);
