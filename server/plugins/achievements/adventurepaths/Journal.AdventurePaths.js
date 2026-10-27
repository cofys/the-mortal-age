const Common = require("./Common.AdventurePaths");
const Progress = require("./Progress.AdventurePaths");
const pending = new WeakMap();
const frameReset = new WeakSet();
const AP_TAB = 3;
const group = (name) => Common.core.CacheDefinitions.getInterfaceId(name);
const uid = (name) => Common.core.CacheDefinitions.getComponentId(name);
function valid(player) {
    return (
        player.isRegistered() &&
        player.getHitpoints() > 0 &&
        player.getStatus() === Common.core.PlayerStatus.NONE
    );
}
function prefer(player, value) {
    const s = Common.state(player);
    if (s.journal === value) return;
    s.journal = value;
    Common.save(player);
}
function mount(player) {
    const request = {
        player,
        groupId: group("adventurepath_side"),
        tabIndex: AP_TAB,
    };
    Common.api.emitCustomEvent("side-journal:mount", request);
}
function restore({ player }) {
    if (
        !Progress.active(player) ||
        !Common.state(player).journal ||
        pending.has(player)
    )
        return;
    const token = { state: Common.state(player) };
    pending.set(player, token);
    Common.core.TaskManager.submit(
        new (class extends Common.core.Task {
            constructor() {
                super(1);
            }
            execute() {
                this.stop();
                if (pending.get(player) !== token) return;
                pending.delete(player);
                if (
                    !valid(player) ||
                    !Progress.active(player) ||
                    Common.state(player) !== token.state ||
                    !token.state.journal ||
                    player.getInterfaceId() >= 0 ||
                    (!frameReset.has(player) &&
                        player
                            .getPacketSender()
                            .isSubInterfaceOpen(group("adventurepath_side")))
                )
                    return;
                frameReset.delete(player);
                mount(player);
            }
        })(),
    );
}
function closed({ player }) {
    if (
        Common.eligible(player) &&
        Common.state(player).journal &&
        (frameReset.has(player) ||
            !player
                .getPacketSender()
                .isSubInterfaceOpen(group("adventurepath_side")))
    )
        restore({ player });
}
function gameframeReady({ player }) {
    frameReset.add(player);
    restore({ player });
}
function mounted({ player, groupId, tabIndex }) {
    if (!Common.eligible(player)) return;
    pending.delete(player);
    frameReset.delete(player);
    prefer(
        player,
        Progress.active(player) &&
            tabIndex === AP_TAB &&
            groupId === group("adventurepath_side"),
    );
}
function transmit({ player, varpId, value }) {
    if (!Common.eligible(player) || !Number.isInteger(value)) return;
    const C = Common.core.CacheDefinitions,
        b = C.getVarbit(C.getVarbitId("side_journal_tab"));
    if (varpId !== b.baseVar) return;
    const tab =
        (value >>> b.startBit) & ((1 << (b.endBit - b.startBit + 1)) - 1);
    if (tab > 4) return;
    pending.delete(player);
    prefer(player, Progress.active(player) && tab === AP_TAB);
}
function setEnabled(player, enabled) {
    if (!Common.eligible(player) || !valid(player)) return;
    const state = Common.state(player),
        out = player.getPacketSender();
    const hadPanel = out.isSubInterfaceOpen(group("adventurepath_side"));
    const selectedAP =
        out.getVarbit(
            Common.core.CacheDefinitions.getVarbitId("side_journal_tab"),
        ) === AP_TAB;
    state.disabled = !enabled;
    state.journal = enabled;
    pending.delete(player);
    Progress.update({ player });
    Common.save(player);
    if (enabled) restore({ player });
    else {
        if (hadPanel) out.closeInterface(group("adventurepath_side"));
        if (selectedAP)
            Common.api.emitCustomEvent("side-journal:mount", {
                player,
                groupId: group("account_summary_sidepanel"),
                tabIndex: 0,
            });
    }
}
function click(event) {
    if (
        event.buttonId !== uid("side_journal:adventurepath_list") ||
        ![1, 2].includes(event.action)
    )
        return;
    event.handled = true;
    const { player } = event;
    if (!Progress.active(player) || !valid(player)) return;
    if (event.action === 1) {
        prefer(player, true);
        pending.delete(player);
        if (player.getInterfaceId() < 0) mount(player);
        else restore({ player });
        return;
    }
    if (player.getInterfaceId() >= 0) {
        player.sendMessage(
            "Close the current window before disabling Adventure Paths.",
        );
        return;
    }
    const state = Common.state(player);
    Common.api.sendMultiChatboxPrompt(
        player,
        "Are you sure you wish to opt out of Adventure Paths?",
        "Yes",
        () => {
            if (
                Common.state(player) === state &&
                Progress.active(player) &&
                valid(player)
            )
                setEnabled(player, false);
        },
        "No",
        () => {},
    );
}
function logout({ player }) {
    pending.delete(player);
    frameReset.delete(player);
}
function attach(api) {
    api.onPlayerLogin(restore);
    api.onPlayerLogout(logout);
    api.onInterfaceActionClick(click);
    api.onCustomEvent("interface:closed", closed);
    api.onCustomEvent("gameframe:ready", gameframeReady);
    api.onCustomEvent("side-journal:mounted", mounted);
    api.onCustomEvent("player:varp-transmit", transmit);
    api.onCustomEvent("tutorial:completed", restore);
}
module.exports = { attach, prefer, setEnabled };
