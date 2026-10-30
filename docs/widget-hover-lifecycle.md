# Hover callbacks after dynamic widget rebuilds

Dynamic CS2 interfaces can delete and recreate children during an operation. The previous
frame still retains references to hovered children and a collected hit list can also become
stale during callback execution. Running those old listeners can mutate the new interface.

The real Present box hat chooser exposed this: revision-241 item_transmog script6858
selects Simple, changes the active-object varp3703 and calls script7978, which uses
CC_DELETEALL to rebuild the choice children. Simple is correctly highlighted gold at that
point. The old child's mouse-leave script6860 retains the prior selected index and recolours
the new Simple border grey. The server's item/varp state remains correct throughout.

The hover input processor now dispatches only to the exact WidgetNode still registered at
that runtime UID. It applies the guard to both last-frame leave references and current-frame
hit candidates, and compares references when deciding whether mouse-over is new. This is
the same registry-identity ownership rule already used for widget timers. No chooser-specific
client branch or extra server refresh packet is involved.

The regression initializes the real cache VM, runs the actual chooser initialization and
onOp scripts, and then calls processWidgetHoverInput. Before the fix, stale leave changes
gold16750623 to grey7496785, and a stale hit changes it to hover colour12099970. Both must
preserve the new gold border. A live selected child's normal leave remains valid. The
tests use the real WidgetManager/CS2 children/listeners; the unrelated world-map hover call
is a no-op fixture boundary.

These are local native-client observations and active-cache script expectations. No RSProx
recording of this client-only hover transition is claimed. Cache files are unchanged.
