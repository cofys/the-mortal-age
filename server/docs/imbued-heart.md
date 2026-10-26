# Imbued heart activation feedback

The inventory **Invigorate** action boosts Magic and starts the existing seven-minute
cooldown. A successful activation also plays the heart's graphic and sound; a click
while drained only sends the existing refusal message.

## Evidence

[rsprox captures](https://rsprox.net/database), recording **1763** (revision 227,
Leagues V), shows `imbued_heart_impact` and synth sound **6847** together one server
tick after the inventory click. League task notifications and nearby combat effects
are excluded from this fix. This is the only indexed imbued-heart activation;
normal-world activation feedback has not been independently captured here.

The spotanim entry in recording 1763 omits height and delay. RSProx's
[`appendSpotanimExtendedInfo`](https://github.com/blurite/rsprox/blob/d5493fb7714d057e7c97be4eda3d10b6078bb87c/transcriber/src/main/kotlin/net/rsprox/transcriber/text/TextPlayerInfoTranscriber.kt#L731)
filters both fields against zero, confirming **height 0 and delay 0**. These match
`Graphic`'s defaults and are asserted by the activation-feedback regression. The
one-tick click-to-response interval is separate from the graphic's packet delay.

The current revision 241 cache maps `imbued_heart` to item **20724** and
`imbued_heart_impact` to spotanim **1316**. Sound archive **6847** exists in index 4.
The existing cache-backed test confirms that the real item offers Invigorate and its
note and placeholder do not.

## Verification

The added registered-handler regression fails on the original implementation because
no graphic is emitted. After the fix, all eight imbued-heart tests pass, covering the
boost, item preservation, cooldown, death reset, action availability and feedback.

A fresh-account MCP run used a developer-granted ordinary imbued heart, then the
normal inventory action. It confirmed graphic 1316 and sound 6847 (one loop, zero
delay), Magic 1 -> 2, and the heart still in the inventory. An immediate second click
returned the seven-minute refusal without repeating either effect. Temporary local
observation wrappers recorded the actor graphic and sound calls, which the standard
MCP snapshot does not expose; those wrappers were removed before committing.

No generated data changed. Client rendering, audible playback and exact visual timing
were not checked. Cooldown timer varbits and saturated-heart behaviour are outside
this focused activation-feedback fix.
