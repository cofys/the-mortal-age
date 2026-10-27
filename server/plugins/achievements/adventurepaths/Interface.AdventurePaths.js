const Journal = require("./Journal.AdventurePaths");
const Items = require("./Items.AdventurePaths");
const Common = require("./Common.AdventurePaths");
const Progress = require("./Progress.AdventurePaths");
const Rewards = require("./Rewards.AdventurePaths");
const Data = require("./Data.AdventurePaths");
// Cache241 CS2 2974 creates a stone button's label at start+9. CS2 2946
// allocates 39 children per path, with its op4 eye as the final child (38/77).
const REWARD_BACK_CHILD = 9;
const PATH_ROW_CHILDREN = 39;
const PATH_FOCUS_OP = 4;
const CLIENT_SETTINGS = [
    "path_in_focus", "combat_task_focus", "gatherer_task_focus",
    "settings_selected", "main_if_tab", "disable_task_message",
    "disable_path_message", "disable_task_focus_message",
    "disable_path_focus_message", "disable_notification",
];
const group = (name) => Common.core.CacheDefinitions.getInterfaceId(name);
const uid = (name) => Common.core.CacheDefinitions.getComponentId(name);
const focusSlot = (index) => (index + 1) * PATH_ROW_CHILDREN - 1;
function settingsMask(varpId) {
    const C = Common.core.CacheDefinitions;
    let mask = 0;
    for (const name of CLIENT_SETTINGS) {
        const b = C.getVarbit(C.getVarbitId("adventurepath_" + name));
        if (b.baseVar === varpId)
            mask |= ((1 << (b.endBit - b.startBit + 1)) - 1) << b.startBit;
    }
    return mask;
}
function focusPath(player, path) {
    const C = Common.core.CacheDefinitions,
        out = player.getPacketSender(),
        id = C.getVarbitId("adventurepath_path_in_focus"),
        b = C.getVarbit(id),
        none = (1 << (b.endBit - b.startBit + 1)) - 1,
        value = out.getVarbit(id) === path.id ? none : path.id;
    out.sendVarbit(id, value);
    Common.state(player).settings[b.baseVar] = out.getVarp(b.baseVar) & settingsMask(b.baseVar);
    const trigger = C.getVarpId("adventurepath_focus_trigger");
    out.sendConfig(trigger, (out.getVarp(trigger) + 1) | 0);
    Common.save(player);
}
function open(player) {
    if (!Progress.active(player)) return;
    const out = player.getPacketSender();
    out.sendInterfaceRemoval();
    Progress.update({ player });
    Journal.prefer(player, true);
    out.sendConfig(
        Common.core.CacheDefinitions.getVarpId("adventurepath_selected_path"),
        Common.state(player).settings[
            Common.core.CacheDefinitions.getVarpId("adventurepath_selected_path")
        ] ?? -1,
    );
    out.sendConfig(
        Common.core.CacheDefinitions.getVarpId("adventurepath_selected_task"),
        Common.state(player).settings[
            Common.core.CacheDefinitions.getVarpId("adventurepath_selected_task")
        ] ?? 0,
    );
    out.sendInterfaceScript(917, [-1, -1]);
    out.sendInterface(group("adventurepath"));
    out.sendSubInterface(uid("toplevel_osrs_stretch:sidemodal"), group("adventurepath_side"), 0);
    for (const name of [
        "path_menu",
        "paths",
        "tasks",
        "task_focus",
        "path_reward",
        "navigation",
        "back",
        "extra_back_button",
    ])
        out.sendInterfaceFlagsRange(uid("adventurepath:" + name), -1, 100, 6);
    for (const [index] of Data.paths().entries())
        out.sendInterfaceFlagsRange(
            uid("adventurepath:paths"), focusSlot(index), focusSlot(index), 1 << PATH_FOCUS_OP,
        );
}
function interact(event) {
    if (event.definition?.getName() !== "Adventurer Jon") return;
    const { player, npc } = event;
    if (!Common.near(player, npc)) {
        event.handled = true;
        return;
    }
    if (!Common.eligible(player)) {
        const option = event.definition.getActions()?.[(event.clickType ?? 1) - 1]?.toLowerCase();
        if (option !== "talk-to") event.handled = true;
        return;
    }
    Common.sessions.set(player, { npc, state: Common.state(player) });
    const option = (
        event.definition.getActions()?.[(event.clickType ?? 1) - 1] ?? ""
    ).toLowerCase();
    if (option === "open adventure paths") {
        event.handled = true;
        open(player);
    } else if (option === "claim") {
        event.handled = true;
        Rewards.claim(player, Items.recover(player));
    }
}
function focused(player) {
    const C = Common.core.CacheDefinitions,
        out = player.getPacketSender();
    const path = out.getVarbit(C.getVarbitId("adventurepath_path_in_focus"));
    if (path !== 0 && path !== 1) return null;
    const local =
        out.getVarbit(
            C.getVarbitId("adventurepath_" + (path === 0 ? "combat" : "gatherer") + "_task_focus"),
        ) ||
        out.getVarbit(
            C.getVarbitId(
                "adventurepath_" + (path === 0 ? "combat" : "gatherer") + "_task_recommended",
            ),
        );
    return Data.paths()
        .find((p) => p.id === path)
        ?.tasks.find((t) => t.index === local - 1);
}
// Search only the player's loaded scene; cache932/938 supplies the off-scene/depleted fallback.
const HINT_SCENE_RADIUS = 15;
function hint(player, task, remove) {
    const core = Common.core,
        out = player.getPacketSender();
    if (remove) {
        out.clearHintArrow();
        return;
    }
    if (!task) return;
    const p = core.CacheDefinitions.getStructParams(task.struct),
        packed = p.get(927),
        fallback = p.get(932);
    if (!Number.isInteger(packed) || !Number.isInteger(fallback)) return;
    const location = (value) =>
            new core.Location((value >>> 14) & 16383, value & 16383, value >>> 28),
        center = location(packed);
    let found = false;
    if (center.isWithinDistance(player.getLocation(), HINT_SCENE_RADIUS)) {
        if (p.has(935)) {
            const candidates = core.World.getNpcsNear(
                player.getLocation(),
                HINT_SCENE_RADIUS,
                player.getPrivateArea(),
            ).filter(
                (npc) =>
                    npc &&
                    npc.isRegistered() &&
                    (!npc.isOwnerOnly() || npc.getOwner() === player) &&
                    core.CacheDefinitions.getNpc(npc.getContentId(player)).category === p.get(935),
            );
            candidates.sort(
                (a, b) => a.getLocation().getDistance(center) - b.getLocation().getDistance(center),
            );
            if (candidates[0]) {
                out.sendEntityHint(candidates[0]);
                found = true;
            }
        } else {
            let target = null,
                best = Infinity;
            for (
                let x = player.getLocation().getX() - HINT_SCENE_RADIUS;
                x <= player.getLocation().getX() + HINT_SCENE_RADIUS;
                x++
            )
                for (
                    let y = player.getLocation().getY() - HINT_SCENE_RADIUS;
                    y <= player.getLocation().getY() + HINT_SCENE_RADIUS;
                    y++
                ) {
                    for (const object of core.MapObjects.mapObjects.get(
                        core.MapObjects.getHash(x, y, player.getLocation().getZ()),
                    ) ?? []) {
                        if (object.getPrivateArea() !== player.getPrivateArea()) continue;
                        const definition = core.ObjectDefinition.forPlayer(object.getId(), player);
                        if (!definition) continue;
                        const type = core.CacheDefinitions.getObject(definition.id);
                        if (
                            !(p.has(934) && definition.id === p.get(934)) &&
                            !(p.has(933) && type.category === p.get(933))
                        )
                            continue;
                        const distance = object.getLocation().getDistance(center);
                        if (distance < best) {
                            best = distance;
                            target = object;
                        }
                    }
                }
            if (target) {
                out.sendPositionalHint(target.getLocation());
                found = true;
            }
        }
    }
    if (!found) out.sendPositionalHint(location(fallback));
    const message = p.get(found ? 936 : 938);
    if (message) player.sendMessage(message);
}
function click(event) {
    const { player, buttonId, action } = event,
        main = player.getInterfaceId();
    if (
        !Progress.active(player) ||
        player.getHitpoints() <= 0 ||
        player.getStatus() !== Common.core.PlayerStatus.NONE
    )
        return;
    if (
        main === group("adventurepath") &&
        buttonId === uid("adventurepath:paths") && action === PATH_FOCUS_OP
    ) {
        const path = Data.paths().find((_, index) => event.slot === focusSlot(index));
        if (!path || path.tasks.every((task) => Common.state(player).completed.includes(task.id))) return;
        event.handled = true;
        focusPath(player, path);
        return;
    }
    if (![1, 2].includes(action)) return;
    if (buttonId >>> 16 === group("adventurepath_side")) {
        if (!player.getPacketSender().isSubInterfaceOpen(group("adventurepath_side"))) return;
        if (
            ["open_interface", "path_name"].some((n) => buttonId === uid("adventurepath_side:" + n))
        ) {
            event.handled = true;
            open(player);
            return;
        }
        if (
            ["task_name", "task_description"].some(
                (n) => buttonId === uid("adventurepath_side:" + n),
            )
        ) {
            event.handled = true;
            const task = focused(player);
            if (!task) return;
            const s = Common.state(player),
                C = Common.core.CacheDefinitions;
            s.settings[C.getVarpId("adventurepath_selected_path")] = task.path;
            s.settings[C.getVarpId("adventurepath_selected_task")] = task.id;
            Common.save(player);
            open(player);
            return;
        }
        if (buttonId === uid("adventurepath_side:hint")) {
            event.handled = true;
            hint(player, focused(player), action === 2);
        }
        return;
    }
    if (
        main === group("adventurepath_reward") &&
        buttonId === uid("adventurepath_reward:item_holder") &&
        event.slot === REWARD_BACK_CHILD &&
        action === 1
    ) {
        event.handled = true;
        open(player);
        return;
    }
    if (main !== group("adventurepath")) return;
    if (buttonId === uid("adventurepath:navigation")) {
        event.handled = true;
        hint(
            player,
            Data.tasks().find(
                (t) =>
                    t.id ===
                    player
                        .getPacketSender()
                        .getVarp(
                            Common.core.CacheDefinitions.getVarpId("adventurepath_selected_task"),
                        ),
            ),
            action === 2,
        );
        return;
    }
    if (buttonId !== uid("adventurepath:path_reward")) return;
    event.handled = true;
    const path = Data.paths().find(
        (p) =>
            p.id ===
            player
                .getPacketSender()
                .getVarp(Common.core.CacheDefinitions.getVarpId("adventurepath_selected_path")),
    );
    if (!path) return;
    player.getPacketSender().sendInterface(group("adventurepath_reward"));
    player
        .getPacketSender()
        .sendInterfaceFlagsRange(uid("adventurepath_reward:item_holder"), REWARD_BACK_CHILD, REWARD_BACK_CHILD, 2);
    player.getPacketSender().sendClientScript(2843, path.struct);
}
function logout({ player }) {
    Common.sessions.delete(player);
}
function transmit(event) {
    const { player, varpId, value } = event,
        C = Common.core.CacheDefinitions;
    if (
        ![group("adventurepath"), group("adventurepath_reward")].includes(
            player.getInterfaceId(),
        ) &&
        !player.getPacketSender().isSubInterfaceOpen(group("adventurepath_side"))
    )
        return;
    if (
        !Progress.active(player) ||
        player.getHitpoints() <= 0 ||
        player.getStatus() !== Common.core.PlayerStatus.NONE ||
        !Number.isInteger(value)
    )
        return;
    const s = Common.state(player);
    let valid = false,
        writable = value;
    if (varpId === C.getVarpId("adventurepath_selected_path")) valid = [-1, 0, 1].includes(value);
    else if (varpId === C.getVarpId("adventurepath_selected_task"))
        valid = value === 0 || Data.tasks().some((t) => t.id === value);
    else {
        const mask = settingsMask(varpId);
        valid =
            mask !== 0 && (value & ~mask) === (player.getPacketSender().getVarp(varpId) & ~mask);
        writable = value & mask;
    }
    if (!valid) return;
    event.handled = true;
    s.settings[varpId] = writable;
    player.getPacketSender().sendConfig(varpId, value);
    Common.save(player);
}
function attach(api) {
    api.onCustomEvent("player:varp-transmit", transmit);
    api.onBeforeNpcInteraction(interact);
    api.onInterfaceActionClick(click);
    api.onPlayerLogout(logout);
}
module.exports = { attach, open, interact };
