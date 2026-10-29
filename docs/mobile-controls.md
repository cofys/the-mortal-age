# Mobile controls

Touch gestures map taps, holds and drags onto the same input paths as mouse clicks and camera
orbit. Camera orbit is disabled until the client is logged in, so dragging the login world list
scrolls it. The input manager also registers ordinary mouse handlers independently of touch
support, which keeps desktop browsers usable without PointerEvent or Touch APIs.

A gesture that starts on a draggable item (the inventory, the LMS load-out grid) holds the left
button for the existing widget drag path instead of orbiting the camera. A stationary hold still
opens the context menu; a pinch or cancelled touch clears the pending item action. Items inside
a scrolling layer (the bank, the LMS item list) keep swipe scrolling: a finger that moves at
once scrolls the list, and one that rests on the item for 200 ms before moving drags it.

The mobile chat keyboard uses a hidden HTML input to receive soft-keyboard text. When that input
is focused, the gameplay viewport follows the keyboard-shrunk visual viewport so the chat input
stays in view. Forced-landscape sizing follows the smaller viewport while keeping its current
rotation. Login fields keep their stable layout while the keyboard is open.
The keyboard button focuses the input synchronously inside the tap's `touchend` event: WebKit
[grants user activation on touchend](https://webkit.org/blog/13862/the-user-activation-api/),
and the later clientscript frame cannot summon the iOS keyboard on its own.
Menu cleanup preserves focus on that input so subsequent frames cannot dismiss the keyboard.
The bridge initializes an unset chat-keyboard toggle to closed before the tap's script runs and
clears it on explicit hide, so the first tap and taps after closing both open chat.
