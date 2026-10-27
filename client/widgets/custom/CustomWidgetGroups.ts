import { getDynamicWidgetGroup } from "../../common/gamemode/GamemodeContentStore";
import { SMITHING_BAR_MODAL_GROUP_ID } from "../../common/ui/widgets";
import type { WidgetNode } from "../WidgetNode";
import { buildSmithingBarModalGroup } from "./smithing.cs2";

type WidgetGroupLoadResult = { root: WidgetNode | undefined; widgets: Map<number, WidgetNode> };

export function loadCustomWidgetGroup(groupId: number): WidgetGroupLoadResult | undefined {
    if ((groupId | 0) === SMITHING_BAR_MODAL_GROUP_ID) {
        return buildSmithingBarModalGroup();
    }
    // Check dynamically loaded widgets (from GAMEMODE_DATA)
    const dynamic = getDynamicWidgetGroup(groupId);
    if (dynamic) {
        // A copy: the loaded widgets change while open, and a reopened group starts again
        // from its definition, as a cache group does from the cache.
        return structuredClone(dynamic) as WidgetGroupLoadResult;
    }
    return undefined;
}
