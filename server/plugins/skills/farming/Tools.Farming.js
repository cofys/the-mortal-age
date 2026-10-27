// Native leprechaun storage: cache125/126, scripts1055-1064; RSProx238/04221.
const core = require("./Core.Farming");
const Data = require("./Data.Farming");
const Patches = require("./Patches.Farming");
const Services = require("./Services.Farming");
const SESSIONS = new WeakMap();
const MAX_AMOUNT = 2147483647;
const MAINMODAL_BACKGROUND = 917;
const WATERING_CAN_ENUM = 136;
const ROWS = [
    { key: "rake", names: ["Rake"], split: ["rake", "extrarakes", 1] },
    { key: "dibber", names: ["Seed dibber"], split: ["dibber", "extradibbers", 1] },
    { key: "spade", names: ["Spade"], split: ["spade", "extraspades", 1] },
    { key: "secateurs", names: ["Secateurs", "Magic secateurs"], split: ["secateurs", "extrasecateurs", 1] },
    { key: "wateringcan", names: ["Gricoller's can"], single: true },
    { key: "trowel", names: ["Gardening trowel"], split: ["trowel", "extratrowels", 1] },
    { key: "plantcure", names: ["Plant cure"] },
    { key: "bottomless_bucket", names: ["Bottomless compost bucket"], single: true },
    { key: "bucket", names: ["Bucket"] },
    { key: "compost", names: ["Compost"], split: ["compost", "extracompost", 8] },
    { key: "supercompost", names: ["Supercompost"], split: ["supercompost", "extrasupercompost", 8] },
    { key: "ultracompost", names: ["Ultracompost"] },
];
const uid = name => core.CacheDefinitions.getComponentId(name);
const group = name => core.CacheDefinitions.getInterfaceId(name);
const bit = name => core.CacheDefinitions.getVarbitId("farming_tools_" + name);
function rowFor(id) {
    const definition = core.CacheDefinitions.getItem(id);
    const plain = definition.noteTemplate >= 0 ? definition.note : id;
    const name = core.CacheDefinitions.getItem(plain).name;
    return ROWS.find(row => row.names.includes(name) || row.key === "wateringcan" && /^Watering can(?:\([1-8]\))?$/.test(name));
}
function entries(player, row) {
    return Object.entries(Patches.farmFor(player).tools).filter(([id, n]) => n > 0 && rowFor(+id) === row);
}
function displayedItem(player, row, main) {
    if (main) return Number(entries(player, row)[0]?.[0] ?? Data.itemId(row.names[0]));
    const inventory = player.getInventory();
    if (row.key === "secateurs" && inventory.contains(Data.itemId("Magic secateurs"))) return Data.itemId("Magic secateurs");
    if (row.key === "wateringcan") {
        // Script1064 scans enum136 from high to low, retaining the last carried variant.
        for (const [, id] of core.CacheDefinitions.getEnumValues(WATERING_CAN_ENUM)) if (inventory.contains(id)) return id;
    }
    const id = inventory.getValidItems().find(item => rowFor(item.getId()) === row)?.getId() ?? Data.itemId(row.names[0]);
    const definition = core.CacheDefinitions.getItem(id);
    return definition.noteTemplate >= 0 ? definition.note : id;
}
function sync(player) {
    const sender = player.getPacketSender(), farm = Patches.farmFor(player);
    const put = (name, n) => sender.sendVarbit(bit(name), n);
    for (const row of ROWS) {
        const stored = entries(player, row), count = stored.reduce((sum, [, n]) => sum + n, 0);
        if (row.split) {
            const [low, high, shift] = row.split;
            put(low, count & ((1 << shift) - 1)); put(high, count >> shift);
            if (row.key === "secateurs") put("fairysecateurs", stored.some(([id]) => core.CacheDefinitions.getItem(+id).name === "Magic secateurs") ? 1 : 0);
        } else if (row.key === "bucket") {
            put("buckets", count & 31); put("extrabuckets", count >> 5 & 7); put("extra2buckets", count >> 8);
        } else if (row.key === "wateringcan") {
            const id = Number(stored[0]?.[0] ?? -1);
            const variant = [...core.CacheDefinitions.getEnumValues(WATERING_CAN_ENUM)].find(([, item]) => item === id)?.[0] ?? 0;
            put("wateringcan", variant);
        } else if (row.key === "bottomless_bucket") {
            const meta = farm.toolMeta?.[stored[0]?.[0]], charges = Number(meta?.["farming:charges"] ?? 0);
            put("bottomless_bucket_type", count ? charges ? Number(meta?.["farming:tier"] ?? 0) + 1 : 1 : 0);
            put("bottomless_bucket_quantity", charges);
        } else put(row.key, count);
    }
}
function near(player, npc) {
    return player.getHitpoints() > 0 && player.getStatus() === core.PlayerStatus.NONE
        && !player.isNeedsPlacement() && !player.isTeleportingReturn() && !player.getForceMovement()
        && player.getLocation().isWithinDistance(npc.getLocation(), 5);
}
function current(player) {
    const session = SESSIONS.get(player), sender = player.getPacketSender();
    return session && near(player, session.npc) && player.getInterfaceId() === group("farming_tools")
        && sender.isSubInterfaceOpen(group("farming_tools")) && sender.isSubInterfaceOpen(group("farming_tools_side")) ? session : null;
}
function open(player, npc) {
    if (!near(player, npc) || player.busy() && !current(player)) return;
    const session = { npc, selected: 0, amount: 0 };
    SESSIONS.set(player, session);
    sync(player);
    const sender = player.getPacketSender();
    sender.sendVarbit(bit("selectedquantity"), 0);
    player.setInterfaceId(group("farming_tools"));
    sender.sendInterface(group("farming_tools"));
    sender.sendSubInterface(uid("toplevel_osrs_stretch:sidemodal"), group("farming_tools_side"), 0);
    for (const name of ["quantity_1", "quantity_5", "quantity_all", "quantity_x"])
        sender.sendInterfaceFlagsRange(uid("farming_tools:" + name), -1, -1, 1 << 1);
    sender.sendInterfaceScript(MAINMODAL_BACKGROUND, [-1, -1]);
}
function withdraw(player, row, requested, noted) {
    const farm = Patches.farmFor(player), inventory = player.getInventory();
    let remaining = requested;
    for (const [key, count] of entries(player, row)) {
        const id = +key, definition = core.CacheDefinitions.getItem(id), meta = farm.toolMeta?.[key];
        if (noted && (meta || definition.note < 0)) continue;
        const item = new core.Item(noted ? definition.note : id, Math.min(count, remaining), core.Item.cloneMeta(meta));
        const amount = Math.min(item.getAmount(), inventory.getAddableAmount(item));
        if (amount <= 0) { inventory.full(); break; }
        inventory.add(item.setAmount(amount), false);
        farm.tools[key] -= amount;
        if (!farm.tools[key]) delete farm.toolMeta?.[key];
        remaining -= amount;
        if (!remaining) break;
    }
    inventory.refreshItems();
    sync(player);
}
function deposit(player, row, requested) {
    const inventory = player.getInventory();
    let remaining = requested;
    for (let slot = 0; slot < inventory.capacity() && remaining > 0; slot++) {
        const item = inventory.forSlot(slot);
        if (!item || item.getId() < 0 || item.getAmount() <= 0 || row && rowFor(item.getId()) !== row) continue;
        const id = item.getId(), before = inventory.getAmount(id);
        Services.storeTool(player, slot, remaining);
        remaining -= before - inventory.getAmount(id);
    }
    sync(player);
}
function prompt(player, session, done) {
    const action = { acceptsZero: true, execute(amount) {
        if (current(player) !== session || player.getEnteredAmountAction() !== action) return;
        player.setEnteredAmountAction(null);
        if (!Number.isSafeInteger(amount) || amount <= 0) return;
        done(Math.min(MAX_AMOUNT, amount));
    } };
    player.setEnteredAmountAction(action);
    player.getPacketSender().sendEnterAmountPrompt("How many would you like to transfer?");
}
function click(event) {
    const { player, buttonId } = event;
    const main = buttonId >>> 16 === group("farming_tools"), side = buttonId >>> 16 === group("farming_tools_side");
    if ((!main && !side) || event.handled) return;
    event.handled = true;
    const session = current(player);
    if (!session) return;
    const pin = { player, feature: "tool-leprechaun", resume: () => click({ ...event, handled: false }) };
    core.PluginManager.emitCustomEvent("bank-pin:guard", pin);
    if (pin.locked) return;
    const op = event.opId ?? event.action;
    if (!Number.isInteger(op) || op < 1 || op > 10) return;
    if (main) {
        const modes = ["quantity_1", "quantity_5", "quantity_all", "quantity_x"];
        const selected = modes.findIndex(name => buttonId === uid("farming_tools:" + name));
        if (selected >= 0) {
            if (op !== 1) return;
            session.selected = selected;
            player.getPacketSender().sendVarbit(bit("selectedquantity"), selected);
            if (selected === 3) prompt(player, session, amount => { session.amount = amount; });
            return;
        }
        if (buttonId === uid("farming_tools:deposit_all")) { if (op === 1) deposit(player, null, MAX_AMOUNT); return; }
    }
    const row = ROWS.find(row => buttonId === uid((main ? "farming_tools:" : "farming_tools_side:") + row.key));
    if (!row) return;
    if (row.single && op !== 1 && op !== 10) return;
    if (op === 10) { player.sendMessage(core.CacheDefinitions.getItem(displayedItem(player, row, main)).examine ?? "Farming equipment."); return; }
    if (op > 4 && !(main && op === 9)) return;
    const mode = main && op === 9 ? session.selected : row.single ? 0
        : [[0, 1, 3, 2], [1, 0, 3, 2], [2, 0, 1, 3], [3, 0, 1, 2]][session.selected][op - 1];
    const transfer = amount => main ? withdraw(player, row, amount, op === 9) : deposit(player, row, amount);
    if (mode === 3 && !session.amount) prompt(player, session, transfer);
    else transfer([1, 5, MAX_AMOUNT, session.amount][mode]);
}
function logout({ player }) { SESSIONS.delete(player); }
Object.assign(module.exports, { open, sync, click, logout });
