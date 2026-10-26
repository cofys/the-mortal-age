/**
 * Shortest Path's TransportType: each bundled transport TSV, the config keys that enable it and
 * price it, and the radius under which a permutation's origin and destination count as the same.
 * POH, seasonal (Leagues) and jewellery-box rows are left out (see README).
 */
export type TransportTypeDef = {
    readonly name: string;
    readonly resourcePath: string | null;
    readonly enabledKey: string | null;
    readonly costKey: string | null;
    readonly radiusThreshold: number;
    readonly isTeleport: boolean;
    /** QUETZAL and QUETZAL_WHISTLE land on the same tiles and compete in the queue. */
    readonly sharesDestinationsWith: string | null;
    readonly differentialCostKey: string | null;
};

function type(name: string, resourcePath: string | null, enabledKey: string | null, costKey: string | null,
    options: Partial<Pick<TransportTypeDef, "radiusThreshold" | "isTeleport" | "sharesDestinationsWith" | "differentialCostKey">> = {}): TransportTypeDef {
    return {
        name,
        resourcePath,
        enabledKey,
        costKey,
        radiusThreshold: options.radiusThreshold ?? 0,
        isTeleport: options.isTeleport ?? false,
        sharesDestinationsWith: options.sharesDestinationsWith ?? null,
        differentialCostKey: options.differentialCostKey ?? null,
    };
}

export const TransportType = {
    TRANSPORT: type("TRANSPORT", "transports/transports.tsv", null, null),
    AGILITY_SHORTCUT: type("AGILITY_SHORTCUT", "transports/agility_shortcuts.tsv", "useAgilityShortcuts", "costAgilityShortcuts"),
    GRAPPLE_SHORTCUT: type("GRAPPLE_SHORTCUT", null, "useGrappleShortcuts", "costGrappleShortcuts"),
    BOAT: type("BOAT", "transports/boats.tsv", "useBoats", "costBoats"),
    CANOE: type("CANOE", "transports/canoes.tsv", "useCanoes", "costCanoes"),
    CHARTER_SHIP: type("CHARTER_SHIP", "transports/charter_ships.tsv", "useCharterShips", "costCharterShips"),
    SHIP: type("SHIP", "transports/ships.tsv", "useShips", "costShips"),
    FAIRY_RING: type("FAIRY_RING", "transports/fairy_rings.tsv", "useFairyRings", "costFairyRings", { radiusThreshold: 6 }),
    GNOME_GLIDER: type("GNOME_GLIDER", "transports/gnome_gliders.tsv", "useGnomeGliders", "costGnomeGliders", { radiusThreshold: 6 }),
    HOT_AIR_BALLOON: type("HOT_AIR_BALLOON", "transports/hot_air_balloons.tsv", "useHotAirBalloons", "costHotAirBalloons", { radiusThreshold: 7 }),
    MAGIC_CARPET: type("MAGIC_CARPET", "transports/magic_carpets.tsv", "useMagicCarpets", "costMagicCarpets"),
    MAGIC_MUSHTREE: type("MAGIC_MUSHTREE", "transports/magic_mushtrees.tsv", "useMagicMushtrees", "costMagicMushtrees", { radiusThreshold: 5 }),
    MINECART: type("MINECART", "transports/minecarts.tsv", "useMinecarts", "costMinecarts"),
    QUETZAL: type("QUETZAL", "transports/quetzals.tsv", "useQuetzals", "costQuetzals", { radiusThreshold: 5, sharesDestinationsWith: "QUETZAL_WHISTLE" }),
    QUETZAL_WHISTLE: type("QUETZAL_WHISTLE", "transports/quetzal_whistle.tsv", "useQuetzals", "costQuetzalWhistle",
        { isTeleport: true, sharesDestinationsWith: "QUETZAL", differentialCostKey: "costQuetzalWhistle" }),
    SPIRIT_TREE: type("SPIRIT_TREE", "transports/spirit_trees.tsv", "useSpiritTrees", "costSpiritTrees", { radiusThreshold: 5 }),
    TELEPORTATION_ITEM: type("TELEPORTATION_ITEM", "transports/teleportation_items.tsv", null, "costNonConsumableTeleportationItems", { isTeleport: true }),
    TELEPORTATION_LEVER: type("TELEPORTATION_LEVER", "transports/teleportation_levers.tsv", "useTeleportationLevers", "costTeleportationLevers"),
    TELEPORTATION_MINIGAME: type("TELEPORTATION_MINIGAME", "transports/teleportation_minigames.tsv", "useTeleportationMinigames", "costTeleportationMinigames", { isTeleport: true }),
    TELEPORTATION_PORTAL: type("TELEPORTATION_PORTAL", "transports/teleportation_portals.tsv", "useTeleportationPortals", "costTeleportationPortals"),
    TELEPORTATION_SPELL: type("TELEPORTATION_SPELL", "transports/teleportation_spells.tsv", "useTeleportationSpells", "costTeleportationSpells", { isTeleport: true }),
    TELEPORTATION_SPELL_HOME: type("TELEPORTATION_SPELL_HOME", "transports/teleportation_spells_home.tsv", "useTeleportationSpellsHome", "costTeleportationSpellsHome", { isTeleport: true }),
    WILDERNESS_OBELISK: type("WILDERNESS_OBELISK", "transports/wilderness_obelisks.tsv", "useWildernessObelisks", "costWildernessObelisks"),
} as const;

export type TransportTypeName = keyof typeof TransportType;

export const TRANSPORT_TYPES: readonly TransportTypeDef[] = Object.values(TransportType);

export function transportTypeByName(name: string): TransportTypeDef | undefined {
    return (TransportType as Record<string, TransportTypeDef>)[name];
}
