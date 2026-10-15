# Logging out

How the logout button and a lost connection end a session, and the live OSRS facts behind them.

## Logout button

- The press is queued and answered on the next game tick (`World.answerLogoutRequest`), not when
  the packet arrives. Live sends `logout_withreason reason=requested` 0-2 ticks after the click.
- Plugins refuse first through `onCanLogout` (Fight Caves mid-wave). Then the combat check: a
  player hit in the last **16 ticks** is refused with
  "You can't log out until 10 seconds after the end of combat." (an `engine` message). Nothing
  else is sent with a refusal. Only hits taken count: a player who hits an NPC can still log out
  before it hits back, as on live (checked in game).
- An accepted logout sends the logout response, closes the socket and leaves the world on the
  same tick.

## Lost connection

- A player whose connection closes is queued for removal and leaves on the next tick, unless
  they were hit in the last 16 ticks. Then they stay in the world, can still be attacked and
  fight back, until combat ends or **60 seconds** (100 ticks) pass (`Player.readyToLeaveWorld`).
- `onPlayerDisconnect` hooks fire when the player leaves the world, not when the socket closes,
  so area and minigame state stays in place while a disconnected player is held.
- `forcedLogoutTimer.start(0)` still removes a player at once (bots, Castle Wars, Pest Control).

## Sources

- rsprox captures: 2,415 `logout:logout` clicks in 2,296 recordings (rev 223-239). Refusals
  stop at 15 ticks after the player's last hit taken; logouts succeed from 16 ticks on. The
  refusal text, with its number, was checked in 98 places.
- OSRS Wiki, Logout button: the 60 second timer before the game forcibly logs out a player who
  disconnects during combat.

## Not done yet

- Reconnecting to a held player. Live sends a `reconnect` packet that resumes the same character
  (57 in the captures); here a new login while held gets "Your account is already logged in."
- Fight Caves: live accepts the logout and pauses the run at the end of the wave
  (`tzhaar_fightcave_logout` varbit); tsps refuses it until the wave ends.
- Escape with nothing open should open the logout tab.
