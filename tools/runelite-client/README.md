# Isolated native RuneLite241 demo client

Use the [setup and demo walkthrough](../../docs/runelite-gateway.md) to start the isolated TSPS world and gateway first. This is a single-client local demonstration, with standard RuneLite as the default and 117 HD optional. It is not a packaged player launcher.

PowerShell7 and JDK21 are required. Set `JAVA_HOME` to your JDK21 directory, or pass `-JavaHome` to each script. Standard preparation and launch do not download, verify or load117HD. Run from the repository root:

```powershell
pwsh -File tools/runelite-client/prepare.ps1
pwsh -File tools/runelite-client/start.ps1 -RsaModulusFile tools/runelite-gateway/.runtime/rsa-modulus.txt -GamePort 43820 -HttpPort 43920
# Optional: prepare and register117HD (not required for RuneLite):
pwsh -File tools/runelite-client/prepare.ps1 -HD
pwsh -File tools/runelite-client/start.ps1 -RsaModulusFile tools/runelite-gateway/.runtime/rsa-modulus.txt -GamePort 43820 -HttpPort 43920 -HD
```

Use the gateway's actual generated public modulus file, in hexadecimal (128–256 characters). `-PrepareOnly` applies and checks patches without opening RuneLite. The start script waits for the client to close. A background helper should be launched hidden; the RuneLite GUI itself remains visible. `-JavaHome` overrides `JAVA_HOME`.

Developer tools are disabled by default. Optional `-DeveloperMode` requests them, but the runtime API jar omits full developer gameval classes (including `VarbitID`), so native QA observed DevTools startup failure with that option. It is not required for gameplay. The isolated patched `runelite.properties` disables Discord RPC (`runelite.discord.enable=false`). Neither setting changes any global profile.

`prepare.ps1 -HD` downloads and verifies the pinned renderer; `start.ps1 -HD` makes it available; it respects RuneLite's renderer conflict handling and saved profile settings. If core GPU remains active, open the RuneLite configuration sidebar, search `117`, and enable **117 HD** (accept disabling conflicting GPU). Native QA observed the builtin plugin activate through this UI and log `Starting 117 HD...`, `Renderer: ZoneRenderer`, and the RTX5090/OpenGL4.6 device information. These startup logs establish activation; the parent workflow records scene rendering/playability separately.

Optional `-Diagnostics` registers the read-only **TSPS Chat Diagnostics** builtin plugin (`-Dtsps.diagnostics=true`). It logs `TSPS_CHAT` entries to the isolated RuneLite log on public/mod/game chat events, local overhead changes, and the following client tick; a periodic state snapshot runs about every10 seconds. Snapshots include game state/tick/cycle, local player name/hidden/overhead/cycle, public mode/message filter, varcs199/383/41/1112/65, chat buffer counts and the latest three message IDs/types/native cycles per channel. Only public/mod/game buffer text is logged (bounded256 characters); private messages contribute types/counts only. `TSPS_CHAT_WIDGET` additionally records chatbox scrollarea162:59 and its first16 dynamic child visibility/text/size fields; opt in only with disposable QA chat because visible widget text can include any displayed channel. Four exact pinned241 fields are read through whitelisted reflection: publicmode`client.ko`, messagefilter`client.kl`, hidden`bd.ah`, messagecycle`by.az`; all other reads use public API. No password, OTP, account-token or login-username API is accessed. Normal launches do not register this plugin or log its plaintext chat diagnostics.

The launcher holds an exclusive runtime lock before patching through client exit. It also rejects a matching running isolated Java client if an earlier launcher left an orphan. It never stops an existing process. Output logs are opened with read sharing before Java starts; a later setup failure stops only the process created by that invocation. A leftover `client.lock` file does not need deletion: only an active operating-system lock blocks launch.

Every download, patched jar, helper class, certificate, temporary file, configuration, plugin cache, and client cache resides under this tool's ignored `.runtime/`. The process has an isolated `user.home`, `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, and `TMP`. It never uses the installed RuneLite launcher. Profile configuration is in `.runtime/home/.rlcustom/`; native QA logs are in `.runtime/home/.runelite/logs/`; process PID and exact argv are `.runtime/process.json`; live stdout/stderr are `.runtime/client.stdout.log` and `client.stderr.log`. Stop only the PID whose command line and isolated home match that identity file. Native QA belongs to the parent gateway workflow; preparation starts no server or game connection.

The gateway must serve `/jav_config.ws` and `/worlds.js` at its loopback HTTP port. `jav_config.lock.ws` preserves the historical official config from the same pinned bootstrap commit; the gateway must rewrite codebase/auth/world-list URLs to loopback, param12 to its numeric world ID, and param25 to241. Keep param15=0: the real client uses it to select the fixed patched game port rather than world+40000. The injected client obtains the game host from codebase, so use `http://127.0.0.1:<HTTP port>/`. `/worlds.js` returns a normal RuneLite `WorldResult`, for example:

```json
{"worlds":[{"id":301,"types":["MEMBERS"],"address":"127.0.0.1","activity":"TSPS","location":0,"players":1}]}
```

Sources and pins:

- Official RuneLite1.13.3 bootstrap: `runelite/static.runelite.net` commit `ab0283a1eda30d6d94b62f0216f0c66d5d827358`, preserved verbatim in `bootstrap.lock.json`. Every artifact uses its published SHA256 and byte size. Download-only archives include all platform variants; launch includes only Windows64 natives.
- Public RSProx launcher source: `blurite/rsprox-runelite-launcher` commit `22da30645f6b8b0627ad582351d567f6b84d68c7`; its source zip SHA256 is pinned by `prepare.ps1`. Published launcher2.7.4-SNAPSHOT and runtime dependencies are independently pinned in `launcher.lock.json`; launcher jar SHA256 `82496a66a797be5a3cc594bee08250d3a040f48a7b6ca361a24d2540e2ddaed7`. The public patcher API matches the referenced source. This is a published binary plus source reference, not a claimed reproducible source rebuild.
- `PatchClient` calls the public patcher directly to avoid the launcher's RSProx-only Unix-socket modulus handshake. It applies RSA, game port, host validation, RuneLite title/profile-directory, config-loader and world-list patches; normalizes127.1.45.2 to127.0.0.1; replaces official config fallbacks. It validates the patched modulus, private game port and world-list constants before launch. API developer resource replacement is unnecessary for this client startup and is not used.
- Native revision is established by bytecode tracing: `client.init` passes241 as argument3 of `to.ma`; that method stores argument3 multiplied by1492153493 to`xd.aq`; `client.getRevision` multiplies it by−1757890883, the inverse modulo2^32. Preparation checks all three links.
-117HD1.6.0 comes from the RuneLite1.13.3 signed Plugin Hub manifest. `117hd.lock.json` pins the signed manifest and jar. Preparation verifies the manifest signature using the certificate inside the verified RuneLite client, then checks the jar SHA256 against the signed manifest entry. `StartClient` registers that jar with RuneLite's supported builtin external-plugin entry point; assertions are enabled as required by that API. No mutable Plugin Hub install is needed. Registration/availability is separate from actual rendering verification.

Focused checks performed: all locked artifact sizes/hashes; bytecode revision241; manifest signature and signed117HD jar hash; actual public patcher execution on the exact client; post-patch RSA/private-port/loopback assertions; HD registration followed by real RuneLite `--help` (no GUI/network), confirming isolated session path and local config default. The gateway's interactive QA subsequently verified real native login, scene loading, movement, equipment, NPC dialogue and117HD GPU rendering; see [setup and verification](../../docs/runelite-gateway.md).

## Server-owner branding

The built-in TSPS Branding plugin reads the gateway's optional `/branding.json` on the configured HTTP port. The launcher supplies this endpoint automatically. Configure welcome banner, bottom parchment text and pre-login background independently in the gateway; see [the gateway guide](../../docs/runelite-gateway.md). Missing or invalid individual assets preserve stock presentation. Branding does not require117HD. Restart gateway and client after changing branding files.

The client accepts only the fixed loopback metadata and asset routes, caps downloads and validates PNG/JPEG dimensions before decoding. Native welcome text escapes markup; banner artwork fits inside the existing border and keeps the native Play control. Disable TSPS Branding in RuneLite to restore the current native footer/widgets and stock login background.

Focused helper checks (real temporary loopback HTTP server and encoded images; plugin widget lifecycle uses pinned API adapters):

```powershell
./tools/runelite-client/test.ps1 -JavaHome $env:JAVA_HOME
```

The hidden TSPS Welcome Backdrop helper clears the retained game frame before the native welcome controls draw. It runs independently of branding and only when entering welcome root378, replacing the image or resizing the canvas, so cached controls survive steady frames. Play and pre-login artwork remain visible in their own states.

To run only the eight retained-raster regressions, add `-WelcomeBackdropOnly`. These checks do not replace native rendering/login/logout verification.
