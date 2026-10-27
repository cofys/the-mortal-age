const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
let core,
    next = 700;
before(async () => {
    await CachePipeline.initialize(path.resolve(__dirname, ".."));
    PluginManager.loadFromDirectory(path.resolve(__dirname, "../plugins"));
    core = PluginManager.getCoreApi();
    core.RegionManager.init();
    core.RegionManager.loadMapFiles(3234, 3222);
});
function actor(t, { experience = "new", iron = false } = {}) {
    const channel = {
        kind: "test",
        remoteAddress: "127.0.0.1",
        isOpen: () => true,
        send: () => true,
        close() {},
        onData() {},
        onError() {},
        onClose() {},
    };
    const p = new Player(new PlayerSession(channel));
    p.setIndex(next++);
    p.setUsername("pathqa" + p.getIndex());
    p.setRegistered(true);
    p.setLocation(new core.Location(3234, 3222, 0));
    p.needsPlacement = false;
    p.setAttribute("tutorial-island:progress", 1000);
    p.setAttribute("tutorial-island:experience", experience);
    if (iron) p.setAttribute("ironman:mode", "ironman");
    const connection = new ClientConnection(channel);
    connection.player = p;
    const messages = [];
    t.mock.method(p.getPacketSender(), "sendMessage", (s) => {
        messages.push(s);
        return p.getPacketSender();
    });
    const mounts = [],
        scripts = [],
        flags = [],
        out = p.getPacketSender(),
        mount = out.sendSubInterface.bind(out),
        flag = out.sendInterfaceFlagsRange.bind(out),
        script = out.sendInterfaceScript.bind(out);
    t.mock.method(out, "sendInterfaceScript", (...args) => {
        scripts.push(args);
        return script(...args);
    });
    t.mock.method(
        out,
        "sendSubInterface",
        (target, group, type = 1, ...rest) => {
            mounts.push([target, group, type]);
            return mount(target, group, type, ...rest);
        },
    );
    t.mock.method(out, "sendInterfaceFlagsRange", (...args) => {
        flags.push(args);
        return flag(...args);
    });
    t.after(() => {
        PluginManager.emitPlayerLogout({
            player: p,
            username: p.getUsername(),
        });
        p.setRegistered(false);
    });
    return { p, connection, messages, mounts, flags, scripts };
}

const C = () => core.CacheDefinitions;
const uid = (name) => C().getComponentId(name);
const group = (name) => C().getInterfaceId(name);
function state(f) {
    const q = { player: f.p };
    PluginManager.emitCustomEvent("adventure-paths:state", q);
    return q.state;
}
function login(f) {
    PluginManager.emitPlayerLogin({
        player: f.p,
        username: f.p.getUsername(),
        isNewAccount: false,
    });
}
function advance() {
    core.TaskManager.process();
    core.TaskManager.process();
}
function click(f, name, action = 1) {
    const buttonId = uid(name);
    return PluginManager.emitInterfaceActionClick({
        player: f.p,
        buttonId,
        groupId: buttonId >>> 16,
        componentId: buttonId & 65535,
        action,
        slot: -1,
        itemId: -1,
        handled: false,
    });
}
async function resume(f, choice) {
    const g = f.p.getPacketSender().getChatboxGroupId();
    await f.connection.dispatch([
        {
            type: "dialogue_continue",
            widgetId:
                choice == null
                    ? (g << 16) | ([231, 217].includes(g) ? 5 : 0)
                    : core.MultiChatboxPrompt.OPTIONS_WIDGET_ID,
            childIndex: choice ?? -1,
        },
    ]);
    f.connection.processTurnPackets();
}
async function menu(f) {
    for (let i = 0; i < 40; i++) {
        const pending = core.MultiChatboxPrompt.getPending(f.p);
        if (pending) return pending.options;
        if (!f.p.getDialogueManager().getCurrent()) return [];
        await resume(f);
    }
    throw Error("no menu");
}
async function choose(f, text) {
    for (let i = 0; i < 5; i++) {
        const options = await menu(f),
            n = options.findIndex((x) => x === text || x.startsWith(text));
        if (n >= 0) return resume(f, n + 1);
        const more = options.findIndex((x) => /More/.test(x));
        assert.ok(more >= 0, "missing " + text + " in " + options);
        await resume(f, more + 1);
    }
}
function jon(f, clickType = 4) {
    const npc = core.NPC.create(
        C().getNpcId("ap_guide_parent"),
        new core.Location(3234, 3223, 0),
    );
    return PluginManager.emitNpcInteraction({
        player: f.p,
        npc,
        npcId: npc.getContentId(f.p),
        definition: npc.getCurrentDefinition(f.p),
        clickType,
        handled: false,
    });
}

test("first enrollment restores the native focus journal after login defaults", (t) => {
    const f = actor(t);
    login(f);
    advance();
    assert.equal(state(f).journal, true);
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        true,
    );
    assert.ok(
        f.mounts.some(
            ([target, g, type]) =>
                target === uid("side_journal:tab_container") &&
                g === group("adventurepath_side") &&
                type === 1,
        ),
    );
    assert.equal(
        f.p.getPacketSender().getVarbit(C().getVarbitId("side_journal_tab")),
        3,
    );
});

test("native Adventure Paths header opens the journal and Disable requires real confirmation", async (t) => {
    const f = actor(t);
    login(f);
    click(f, "side_journal:adventurepath_list");
    assert.ok(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
    );
    click(f, "side_journal:adventurepath_list", 2);
    assert.ok(core.MultiChatboxPrompt.getPending(f.p));
    assert.equal(state(f).disabled, undefined);
    await resume(f, 2);
    assert.equal(state(f).disabled, undefined);
    click(f, "side_journal:adventurepath_list", 2);
    await resume(f, 1);
    advance();
    assert.equal(state(f).disabled, true);
    assert.equal(state(f).journal, false);
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        false,
    );
    assert.equal(
        f.p
            .getPacketSender()
            .isSubInterfaceOpen(group("account_summary_sidepanel")),
        true,
    );
    assert.equal(
        f.p.getPacketSender().getVarbit(C().getVarbitId("side_journal_tab")),
        0,
    );
    assert.ok(
        f.flags.some(
            ([widget, from, to]) =>
                widget === ((712 << 16) | 3) && from === 3 && to === 4,
        ),
    );
});

test("other journal selection cancels a pending AP restore even when its click is consumed", (t) => {
    const f = actor(t);
    login(f);
    click(f, "side_journal:quest_list");
    advance();
    assert.equal(state(f).journal, false);
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        false,
    );
    assert.equal(
        f.p.getPacketSender().getVarbit(C().getVarbitId("side_journal_tab")),
        1,
    );
});

test("header Show defers while the overview owns its side panel and restores it after closing", (t) => {
    const f = actor(t);
    login(f);
    click(f, "side_journal:adventurepath_list");
    jon(f);
    assert.equal(f.p.getInterfaceId(), group("adventurepath"));
    const count = f.mounts.filter(
        ([target, g]) =>
            target === uid("side_journal:tab_container") &&
            g === group("adventurepath_side"),
    ).length;
    click(f, "side_journal:adventurepath_list");
    advance();
    assert.equal(f.p.getInterfaceId(), group("adventurepath"));
    assert.equal(
        f.mounts.filter(
            ([target, g]) =>
                target === uid("side_journal:tab_container") &&
                g === group("adventurepath_side"),
        ).length,
        count,
    );
    f.p.getPacketSender().sendInterfaceRemoval();
    advance();
    assert.equal(f.p.getInterfaceId(), -1);
    assert.ok(
        f.mounts.some(
            ([target, g, type]) =>
                target === uid("side_journal:tab_container") &&
                g === group("adventurepath_side") &&
                type === 1,
        ),
    );
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        true,
    );
});

test("a replacement main modal delays restoration until it closes", (t) => {
    const f = actor(t);
    login(f);
    jon(f);
    f.p.getPacketSender().sendInterfaceRemoval();
    f.p.getPacketSender().sendInterface(300);
    advance();
    assert.equal(f.p.getInterfaceId(), 300);
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        false,
    );
    f.p.getPacketSender().sendInterfaceRemoval();
    advance();
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        true,
    );
});

test("native journal varp selection and a real save/load preserve the user preference", async (t) => {
    const {
        PlayerSave,
    } = require("../dist/game/entity/impl/player/persistence/PlayerSave");
    const f = actor(t);
    login(f);
    click(f, "side_journal:adventurepath_list");
    const b = C().getVarbit(C().getVarbitId("side_journal_tab")),
        old = f.p.getPacketSender().getVarp(b.baseVar),
        value = (old & ~(7 << b.startBit)) | (1 << b.startBit);
    await f.connection.dispatch([
        { type: "varp_transmit", varpId: b.baseVar, value },
    ]);
    f.connection.processTurnPackets();
    assert.equal(state(f).journal, false);
    const saved = PlayerSave.fromPlayer(f.p),
        g = actor(t);
    saved.applyToPlayer(g.p);
    login(g);
    advance();
    assert.equal(state(g).journal, false);
    assert.equal(
        g.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        false,
    );
});

test("logout, state replacement, death and trade invalidate delayed journal restores", (t) => {
    for (const mode of ["logout", "state", "dead", "trade"]) {
        const f = actor(t);
        login(f);
        if (mode === "logout") {
            PluginManager.emitPlayerLogout({
                player: f.p,
                username: f.p.getUsername(),
            });
            f.p.setRegistered(false);
        }
        if (mode === "state")
            f.p.setAttribute("adventure-paths:state", {
                ...JSON.parse(JSON.stringify(state(f))),
                journal: false,
            });
        if (mode === "dead") f.p.setHitpoints(0);
        if (mode === "trade") f.p.setStatus(core.PlayerStatus.TRADING);
        advance();
        assert.equal(
            f.p
                .getPacketSender()
                .isSubInterfaceOpen(group("adventurepath_side")),
            false,
            mode,
        );
    }
});

test("ineligible accounts cannot open or disable the native AP journal", (t) => {
    for (const opts of [{ experience: "experienced" }, { iron: true }]) {
        const f = actor(t, opts);
        login(f);
        click(f, "side_journal:adventurepath_list");
        click(f, "side_journal:adventurepath_list", 2);
        advance();
        assert.equal(
            f.p
                .getPacketSender()
                .isSubInterfaceOpen(group("adventurepath_side")),
            false,
        );
        assert.equal(core.MultiChatboxPrompt.getPending(f.p), null);
    }
});

test("Jon opt-in restores participation and the native journal after header opt-out", async (t) => {
    const f = actor(t);
    login(f);
    click(f, "side_journal:adventurepath_list");
    click(f, "side_journal:adventurepath_list", 2);
    await resume(f, 1);
    assert.equal(state(f).disabled, true, "header confirmation opted out");
    jon(f, 1);
    await choose(f, "Yes please.");
    await choose(f, "Yes");
    await menu(f);
    advance();
    assert.equal(state(f).disabled, false);
    assert.equal(state(f).journal, true);
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        true,
    );
});

test("Disable never opens a modal-closing prompt over an existing main screen", async (t) => {
    for (const g of [300, group("adventurepath")])
        for (const option of [1, 2]) {
            const f = actor(t);
            login(f);
            click(f, "side_journal:adventurepath_list");
            if (g === group("adventurepath")) jon(f);
            else f.p.getPacketSender().sendInterface(g);
            click(f, "side_journal:adventurepath_list", 2);
            await resume(f, option);
            assert.equal(
                f.p.getInterfaceId(),
                g,
                "main window remains for choice " + option,
            );
            assert.notEqual(state(f).disabled, true);
            assert.equal(core.MultiChatboxPrompt.getPending(f.p), null);
        }
});
test("Jon opt-out restores summary when a closed AP modal already removed its side panel", async (t) => {
    const f = actor(t);
    login(f);
    click(f, "side_journal:adventurepath_list");
    jon(f);
    f.p.getPacketSender().sendInterfaceRemoval();
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("adventurepath_side")),
        false,
    );
    jon(f, 1);
    await choose(f, "Disable Adventure Paths.");
    await choose(f, "Yes");
    await menu(f);
    advance();
    assert.equal(state(f).disabled, true);
    assert.equal(
        f.p.getPacketSender().getVarbit(C().getVarbitId("side_journal_tab")),
        0,
    );
    assert.equal(
        f.p
            .getPacketSender()
            .isSubInterfaceOpen(group("account_summary_sidepanel")),
        true,
    );
});
test("Jon opt-out preserves an actual different journal selection", async (t) => {
    const f = actor(t);
    login(f);
    click(f, "side_journal:adventurepath_list");
    click(f, "side_journal:quest_list");
    jon(f, 1);
    await choose(f, "Disable Adventure Paths.");
    await choose(f, "Yes");
    await menu(f);
    advance();
    assert.equal(state(f).disabled, true);
    assert.equal(
        f.p.getPacketSender().getVarbit(C().getVarbitId("side_journal_tab")),
        1,
    );
    assert.equal(
        f.p.getPacketSender().isSubInterfaceOpen(group("questlist")),
        true,
    );
});

test("welcome Play restores the preferred journal after the raw gameframe bootstrap", async (t) => {
    const f = actor(t);
    login(f);
    await Promise.resolve();
    advance();
    const before = f.mounts.filter(
        ([, g]) => g === group("adventurepath_side"),
    ).length;
    await f.connection.dispatch([
        {
            type: "widget_action",
            widgetId: (378 << 16) | 72,
            groupId: 378,
            childId: 72,
            buttonNum: 1,
        },
    ]);
    f.connection.processTurnPackets();
    advance();
    assert.equal(
        f.mounts.filter(([, g]) => g === group("adventurepath_side")).length,
        before + 1,
    );
    assert.equal(state(f).journal, true);
});

async function nativeWidget(f, name, slot, action = 1) {
    const widgetId = uid(name);
    await f.connection.dispatch([{
        type: "widget_action", widgetId, groupId: widgetId >>> 16,
        childId: widgetId & 65535, slot, itemId: -1, buttonNum: action,
    }]);
    f.connection.processTurnPackets();
}

test("native overview uses the centered 334px modal and enables only the cache path-eye op4 slots", (t) => {
    const f = actor(t);
    login(f);
    jon(f);
    assert.deepEqual(f.scripts.find(([id]) => id === 917)?.[1], [-1, -1]);
    for (const slot of [38, 77]) {
        const range = f.flags.filter(([id, from, to]) =>
            id === uid("adventurepath:paths") && slot >= from && slot <= to).at(-1);
        assert.equal(range?.[3] & (1 << 4), 1 << 4);
    }
    const ordinary = f.flags.filter(([id, from, to]) =>
        id === uid("adventurepath:paths") && 49 >= from && 49 <= to).at(-1);
    assert.equal(ordinary?.[3] & (1 << 4), 0);
});

test("native reward Back is child9 and child0 cannot impersonate it", async (t) => {
    const f = actor(t);
    login(f);
    jon(f);
    f.p.getPacketSender().sendConfig(C().getVarpId("adventurepath_selected_path"), 1);
    await nativeWidget(f, "adventurepath:path_reward", 9);
    assert.equal(f.p.getInterfaceId(), group("adventurepath_reward"));
    const range = f.flags.filter(([id]) => id === uid("adventurepath_reward:item_holder")).at(-1);
    assert.deepEqual(range?.slice(1), [9, 9, 2]);
    await nativeWidget(f, "adventurepath_reward:item_holder", 0);
    assert.equal(f.p.getInterfaceId(), group("adventurepath_reward"));
    await nativeWidget(f, "adventurepath_reward:item_holder", 9);
    assert.equal(f.p.getInterfaceId(), group("adventurepath"));
});

test("native path focus sets and drops both paths, preserves task/recommendation bits and survives state reload", async (t) => {
    const f = actor(t);
    login(f);
    jon(f);
    const out = f.p.getPacketSender(),
        focus = C().getVarbitId("adventurepath_path_in_focus"),
        task = C().getVarbitId("adventurepath_gatherer_task_focus"),
        base = C().getVarpId("adventurepath_in_focus"),
        trigger = C().getVarpId("adventurepath_focus_trigger"),
        before = out.getVarp(base),
        beforeTrigger = out.getVarp(trigger);
    out.sendVarbit(task, 1);
    await nativeWidget(f, "adventurepath:paths", 77, 4);
    assert.equal(out.getVarbit(focus), 1);
    assert.equal(out.getVarbit(task), 1);
    assert.equal(out.getVarp(base) & (31 << 16), before & (31 << 16));
    assert.equal(state(f).settings[base] & (31 << 16), 0, "recommendation is server-owned");
    assert.notEqual(out.getVarp(trigger), beforeTrigger, "native panel listeners must redraw");
    const g = actor(t);
    g.p.setAttribute("adventure-paths:state", JSON.parse(JSON.stringify(state(f))));
    login(g);
    assert.equal(g.p.getPacketSender().getVarbit(focus), 1);
    const def = C().getVarbit(focus), none = (1 << (def.endBit - def.startBit + 1)) - 1;
    await nativeWidget(f, "adventurepath:paths", 77, 4);
    assert.equal(out.getVarbit(focus), none);
    await nativeWidget(f, "adventurepath:paths", 38, 4);
    assert.equal(out.getVarbit(focus), 0);
    await nativeWidget(f, "adventurepath:paths", 38, 4);
    assert.equal(out.getVarbit(focus), none);
});

test("native focus rejects forged rows, wrong operations, closed windows, dead and trading players", async (t) => {
    for (const mode of ["forged", "operation", "closed", "dead", "trading"]) {
        const f = actor(t);
        login(f);
        jon(f);
        const out = f.p.getPacketSender(), id = C().getVarbitId("adventurepath_path_in_focus"),
            before = out.getVarbit(id);
        if (mode === "closed") out.sendInterfaceRemoval();
        if (mode === "dead") f.p.setHitpoints(0);
        if (mode === "trading") f.p.setStatus(core.PlayerStatus.TRADING);
        await nativeWidget(f, "adventurepath:paths", mode === "forged" ? 76 : 77, mode === "operation" ? 1 : 4);
        assert.equal(out.getVarbit(id), before, mode);
    }
});

test("a completed path's noninteractive tick cannot be forged into a focus action", async (t) => {
    const f = actor(t);
    for (const skill of [core.Skill.FISHING, core.Skill.MINING, core.Skill.WOODCUTTING])
        f.p.getSkillManager().setMaxLevels(skill, 5, false);
    login(f);
    jon(f);
    assert.ok([16, 17, 18].every(id => state(f).completed.includes(id)));
    const id = C().getVarbitId("adventurepath_path_in_focus"), before = f.p.getPacketSender().getVarbit(id);
    await nativeWidget(f, "adventurepath:paths", 77, 4);
    assert.equal(f.p.getPacketSender().getVarbit(id), before);
});
