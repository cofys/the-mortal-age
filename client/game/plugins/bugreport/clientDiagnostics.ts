import { isMobileMode } from "../../../common/utils/DeviceUtil";
import { getCurrentTick } from "../../../network/serverConnection/timing";
import { getLatestSkills } from "../../../network/serverConnection/subscriptions/ui";
import { chatHistory } from "../../../rs/cs2/ChatHistory";
import type { Inventory } from "../../../rs/inventory/Inventory";
import { getSkillName } from "../../../rs/skill/skills";
import type { OsrsClient } from "../../OsrsClient";
import { getRendererName } from "../../GameRenderers";
import type { ClientLogBuffer } from "./ClientLogBuffer";
import { formatErrorLines, resolvePlayer, type BugReportDiagnostics } from "./bugReportLink";

/** A section that fails to read is left out rather than losing the report. */
function read<T>(section: () => T): T | undefined {
    try {
        return section();
    } catch (error) {
        console.warn("[bug-report] diagnostics section failed", error);
        return undefined;
    }
}

/**
 * What the client already knows and is safe to share on a public issue. No user agent,
 * language, timezone, page URL, world address or full console: anything identifying a
 * real person is out. Account and client state (name, position, skills, inventory,
 * renderer, errors) is in, each section short enough to survive the ~8KB issue URL.
 * Anything that fails to read is left out.
 */
export function collectBugDiagnostics(client: OsrsClient, logs: ClientLogBuffer): BugReportDiagnostics {
    const loggedIn = read(() => client.isLoggedIn()) ?? false;
    // Name and position resolve through the login gate: after a logout the client still
    // holds the previous account's name, which a logged-out report must never emit.
    const player = loggedIn
        ? read(() => {
              const index = client.playerEcs.getIndexForServerId(client.controlledPlayerServerId);
              const position =
                  index === undefined || index < 0
                      ? undefined
                      : {
                            x: client.playerEcs.getX(index) >> 7,
                            y: client.playerEcs.getY(index) >> 7,
                            plane: client.playerEcs.getLevel(index),
                        };
              return resolvePlayer(true, client.localPlayerName, position);
          })
        : resolvePlayer(false, undefined, undefined);
    const failedPlugins = read(() => {
        const failed: Record<string, string> = {};
        const manager = client.runeLite.pluginManager;
        for (const pluginClass of manager.getPluginClasses()) {
            const failure = manager.getFailure(pluginClass);
            if (failure) failed[pluginClass.descriptor.name] = failure;
        }
        return failed;
    });
    const errors = read(() =>
        formatErrorLines(
            logs.recent().filter((entry) => entry.level === "warn" || entry.level === "error").map((entry) => entry.text),
        ),
    );
    const skills = read(() => {
        const latest = getLatestSkills();
        if (!latest) return undefined;
        const levels = latest.skills
            .map((skill) => `${getSkillName(skill.id)} ${skill.baseLevel}`)
            .join(", ");
        return `total ${latest.totalLevel} (combat ${latest.combatLevel}): ${levels}`;
    });
    const pack = (inventory: Inventory): string =>
        inventory
            .getSlots()
            .filter((slot) => slot.itemId >= 0 && slot.quantity > 0)
            .map((slot) => {
                const name = client.objTypeLoader.load(slot.itemId)?.name ?? `#${slot.itemId}`;
                return slot.quantity > 1 ? `${name} x${slot.quantity}` : name;
            })
            .join(", ");
    const inventory = read(() => pack(client.inventory));
    const equipment = read(() => pack(client.equipment));
    const varps = read(() => {
        const set: string[] = [];
        client.varManager.values.forEach((value, id) => {
            if (value !== 0) set.push(`${id}=${value}`);
        });
        return set.length === 0 ? "none set" : `${set.length} set: ${set.join(", ")}`;
    });
    const interfaces = read(() => {
        const parents = [...client.widgetManager.interfaceParents.keys()].slice(0, 8);
        const open = client.widgetManager.interfaceParents.size;
        const list = parents.length > 0 ? `: ${parents.join(", ")}${open > parents.length ? ", …" : ""}` : "";
        return `root ${client.widgetManager.rootInterface} (${open} open${list})`;
    });
    const messages = read(() =>
        chatHistory
            .getAllMessageNodes()
            .filter((message) => message.type === 0)
            .slice(-8)
            .map((message) => String(message.text ?? "")),
    );
    return {
        loggedIn,
        player: player?.name ?? "(logged out)",
        position: player?.position,
        world: read(() => client.loginState.serverName) ?? "(unknown world)",
        worldId: read(() => client.loginState.serverWorldId),
        members: read(() => client.isMembersWorld) ?? true,
        tick: read(() => getCurrentTick()) ?? -1,
        transport: read(() => client.loginState.serverTransport) ?? "websocket",
        renderer: read(() => getRendererName(client.renderer.type)) ?? "unknown",
        viewport: read(
            () => `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio ?? 1}x`,
        ) ?? "unknown",
        fps: read(() => Math.round(client.renderer.stats.frameTimeFps)) ?? 0,
        mobile: isMobileMode,
        cache: read(() => client.loadedCache?.info.name),
        failedPlugins: failedPlugins ?? {},
        errors: errors ?? "(no recent warnings or errors)",
        skills,
        // Empty string stays empty (a successful empty read); only failure is undefined.
        inventory,
        equipment,
        varps,
        interfaces,
        messages: messages ?? [],
    };
}

