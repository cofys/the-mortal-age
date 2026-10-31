# RuneLite revision241 demo gateway

**Single-client local demo.** Start with the [setup and demo walkthrough](../../docs/runelite-gateway.md). This PR demonstrates a limited native-client path; it does not provide general player rollout or remote hosting. 117 HD is optional.

Local JVM sidecar translating the genuine revision241 TCP client to the isolated TSPS WebSocket server. TSPS remains authoritative for authentication, account creation, movement and interactions. The JVM does not open player saves.

## Run

Requires Java21 and PowerShell. Set `JAVA_HOME` to your JDK21 directory, or pass `-JavaHome`.117HD is an optional client renderer and has no gateway dependency. From the worktree:

```powershell
./tools/runelite-gateway/start.ps1 -Build
```

The Gradle8.10.2 wrapper verifies the official distribution SHA256. Maven Central dependencies pin RSProt `net.rsprot:osrs-241-api:1.0.0-ALPHA-20261014`. Runtime and Gradle caches remain under this tool's ignored `.runtime/`.

Defaults use TCP43820, HTTP43920 and upstream `ws://127.0.0.1:43720`. Override `-Port`, `-HttpPort`, `-Upstream` and `-Cache` for a different isolated worktree slot. Listeners bind127.0.0.1. Default/live ports43594/3000/49700 are rejected, including upstream. The copied cache must resolve inside this worktree. A port already in use fails startup; no process is stopped.

On first launch, `.runtime/rsa.properties` stores a disposable1024-bit RSA pair; `.runtime/rsa-modulus.txt` supplies its public modulus to the isolated client launcher:

```powershell
./tools/runelite-client/start.ps1 -RsaModulusFile ./tools/runelite-gateway/.runtime/rsa-modulus.txt
```

Use fresh QA accounts only. Enable `RUNELITE_GATEWAY_ENABLED=1` on the isolated TSPS server. HTTP serves the launcher's pinned `jav_config.lock.ws`, rewrites connection/auth endpoints to loopback and provides RuneLite's world list. Login responses wait for a complete authoritative TSPS snapshot. Cache JS5 data is read from sector files, converted to native512-byte blocks, and served using RSProt's required unreleasable buffers.

## Checks

```powershell
# JAVA_HOME must point to your JDK21 installation
$env:GRADLE_USER_HOME="$PWD/tools/runelite-gateway/.runtime/gradle-home"
./tools/runelite-gateway/gradlew.bat -p tools/runelite-gateway test --console=plain
```

Focused tests exercise real copied cache CRCs, Huffman and config14 varbits, JS5 block continuation, chunk assembly, native action translation and custom UI/stat/inventory translation. Tests read `server/caches/osrs-241_2026-10-20` and never mutate it.

The26 foundation JVM tests passed in earlier focused runs: cache3, snapshots4, translation12, serialized writes2 and public chat5. The final changed queue checks covered burst matching and removal/index reuse. Use `-TraceInput` for opt-in packet/chat-text diagnostics; these logs are disabled by default.

## Current boundaries

One native connection is supported at a time. This keeps observer-specific snapshot visibility isolated while establishing the gateway. Players/NPCs are allocated by authoritative index; omissions remove them. Standard appearance, movement, animation, graphics, hits, healthbars and forced speech map through RSProt. Snapshot packets replace TSPS's custom PLAYER_SYNC/NPC_INFO rather than forwarding incompatible binary blocks.

The successful TSPS handshake also initializes native display-name varbit8119; authoritative skill updates initialize native combat display. Public chat uses RSProt's native player-info chat block for overhead and one chatbox line, suppressing the matching custom forced-speech duplicate. The client's selected chat pane remains a user preference; public messages appear under All/Public.

Native input currently covers walk/minimap, NPC/location options, interface buttons, dialogue replies, public chat, filters and logout. Common UI/subinterface/scripts/varps/varbits, inventory/bank/equipment, stats and game chat map to native packets. Browser-only varp7995–7999 overlay hints are omitted because they exceed the real cache native varp capacity5996 (forwarding them crashed the client). Legacy widget writes are omitted only when their group/component is absent from the real cache (for example317 widget5857). Other unsupported custom packets are omitted; this is not complete parity for shops, trade, custom interfaces, dynamic object/zone changes, ground items, instances or Sailing. Actor forced movement/custom models and full remote chat also need additional mapping. Actual native QA verified walking/minimap input, inventory/equipment, NPC Talk-to and dialogue continuation, normal logout/persisted relog, and real117HD1.6.0 scene rendering on an RTX5090. See [setup and verification](../../docs/runelite-gateway.md) for evidence and limits. These checks do not establish all-content parity.

## Implementation references

RSProt source inspected at commit `37c4eb46e4731ae6764343d136f3076a50567ec1` (MIT). Upstream source archive used for development is ignored under `vendor/`; the application uses published Maven artifacts rather than a modified protocol library. The Gradle wrapper bootstrap jar is the standard Gradle wrapper copied from the local reference checkout.

## Optional server branding

Copy `branding.example.json` to ignored `branding.local.json`, or pass `-BrandingFile` to the gateway launcher. Set welcomeText and relative PNG/JPEG paths for welcomeBanner/loginBackground independently. Null fields keep the native screen. Images remain inside the config directory; startup rejects unsupported/corrupt/oversized images and unknown fields. Fixed loopback HTTP routes expose only the configured bytes. Restart gateway and RuneLite to apply edits without rebuilding. See [owner setup and screenshots](../../docs/runelite-gateway.md#server-branding-optional).

Six additional focused BrandingTest cases cover real PNG/JPEG loading, independent settings, invalid text/config/files, dimensions/size/traversal and real loopback HTTP GET/HEAD/404/405 plus the existing native config/world routes.
