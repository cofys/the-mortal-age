import { strict as assert } from "node:assert";

import { Opcodes } from "../rs/cs2/Opcodes";
import { registerWidgetOps } from "../rs/cs2/handlers/WidgetOps";
import type { HandlerMap } from "../rs/cs2/handlers/HandlerTypes";

// cc_setnpchead / if_setnpchead from a client script: the widget renderer draws an NPC's chathead
// only for widgets flagged as one. Without the flag the NPC id was drawn as a model id, so the
// Crew Management interface (script 8789, cc_setnpchead of each crewmate's boat_npc) showed
// unrelated models instead of the crew's heads.
const handlers: HandlerMap = new Map();
registerWidgetOps(handlers);

const widget: any = { uid: (938 << 16) | 7, modelType: 0, modelId: -1 };
const ctx = (ints: number[]) => ({
    intStack: Int32Array.from([...ints, 0, 0, 0, 0]),
    intStackSize: ints.length,
    activeWidget: widget,
    dotWidget: null,
    widgetManager: { getWidgetByUid: () => widget, invalidateWidgetRender() {} },
}) as any;

handlers.get(Opcodes.CC_SETNPCHEAD)!(ctx([15258]), 0, null);
assert.equal(widget.modelType, 2);
assert.equal(widget.isNpcChathead, true, "drawn as Jobless Jim's chathead");
assert.equal(widget.npcTypeId, 15258);

handlers.get(Opcodes.CC_SETMODEL)!(ctx([38000]), 0, null);
assert.equal(widget.modelType, 1);
assert.equal(widget.isNpcChathead, false, "a plain model again");
assert.equal(widget.npcTypeId, undefined);

console.log("cs2-setnpchead: ok");
