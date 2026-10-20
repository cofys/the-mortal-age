# Mobile controls

Touch gestures map taps, holds and drags onto the same input paths as mouse clicks and camera
orbit. Camera orbit is disabled until the client is logged in, so dragging the login world list
scrolls it. The input manager also registers ordinary mouse handlers independently of touch
support, which keeps desktop browsers usable without PointerEvent or Touch APIs.

The mobile chat keyboard uses a hidden HTML input to receive soft-keyboard text. When that input
is focused, the gameplay viewport follows the keyboard-shrunk visual viewport so the chat input
stays in view. Forced-landscape sizing follows the smaller viewport while keeping its current
rotation. Login fields keep their stable layout while the keyboard is open.
