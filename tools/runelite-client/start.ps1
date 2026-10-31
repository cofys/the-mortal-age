param(
    [Parameter(Mandatory=$true)][string]$RsaModulusFile,
    [int]$GamePort = 43820,
    [int]$HttpPort = 43920,
    [switch]$HD,
    [switch]$DeveloperMode,
    [switch]$Diagnostics,
    [switch]$PrepareOnly,
    [string]$JavaHome = $env:JAVA_HOME
)
$ErrorActionPreference = 'Stop'
if (!$JavaHome -or !(Test-Path -LiteralPath "$JavaHome/bin/java.exe")) { throw 'Set JAVA_HOME to a JDK21 installation or pass -JavaHome' }
if (!(Test-Path -LiteralPath "$JavaHome/release") -or !(Select-String -LiteralPath "$JavaHome/release" -Pattern '^JAVA_VERSION="21(?:[."+])' -Quiet)) { throw 'A JDK21 installation is required' }
$runtime = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
# Hold this handle through patching and the entire client lifetime. A stale file
# is harmless: the operating system releases the exclusive handle on exit.
try {
    $instanceLock = [IO.FileStream]::new("$runtime/client.lock", [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch [IO.IOException] {
    throw 'An isolated client launcher already owns this runtime; no patch or launch performed'
}
$process = $null
$outputFile = $null
$errorFile = $null
$launchReady = $false
try {
# Detect an orphan from an older/interrupted launcher even if its lock is gone.
# Match both the entry point and the exact isolated home; never stop it here.
$homeArgument = "-Duser.home=$runtime/home"
$existing = @(Get-CimInstance Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($homeArgument) -and $_.CommandLine -match '\bStartClient\b'
})
if ($existing.Count) { throw "Existing isolated client PID(s) $($existing.ProcessId -join ', '); no patch or launch performed" }
foreach ($class in @('PatchClient','StartClient','ChatDiagnostics','Branding','Branding$1','BrandingAssets','BrandingAssets$Metadata','BrandingAssets$Loaded','WelcomeBackdrop')) {
    $sourceClass = $class -replace '\$.*$', ''
    if (!(Test-Path "$runtime/classes/$class.class") -or (Get-Item "$PSScriptRoot/$sourceClass.java").LastWriteTimeUtc -gt (Get-Item "$runtime/classes/$class.class").LastWriteTimeUtc) { throw 'Client helper classes are missing or stale; run prepare.ps1' }
}
$launcher = Get-Content -Raw "$PSScriptRoot/launcher.lock.json" | ConvertFrom-Json
foreach ($pair in @(@('bootstrap.lock.json','artifacts'), @('launcher.lock.json','launcher'))) {
    foreach ($artifact in (Get-Content -Raw "$PSScriptRoot/$($pair[0])" | ConvertFrom-Json).artifacts) {
        if ((Get-FileHash -LiteralPath "$runtime/$($pair[1])/$($artifact.name)" -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.hash) { throw "Artifact changed: $($artifact.name); run prepare.ps1" }
    }
}
if ($HD) {
if (!(Test-Path -LiteralPath "$runtime/117hd.jar")) { throw 'Optional117HD is not prepared; run prepare.ps1 -HD first' }
$hdLock = Get-Content -Raw "$PSScriptRoot/117hd.lock.json" | ConvertFrom-Json
if ((Get-FileHash -LiteralPath "$runtime/117hd.jar").Hash.ToLowerInvariant() -ne $hdLock.hash) { throw '117HD jar changed' }
}
$launcherCp = ($launcher.artifacts | ForEach-Object { Join-Path "$runtime/launcher" $_.name }) -join ';'
& "$JavaHome/bin/java.exe" "-Duser.home=$runtime/home" "-Djava.io.tmpdir=$runtime/tmp" -cp "$runtime/classes;$launcherCp" PatchClient $runtime patch $GamePort $HttpPort (Resolve-Path -LiteralPath $RsaModulusFile)
if ($LASTEXITCODE) { throw 'Patching failed; run prepare.ps1 first' }
if ($PrepareOnly) { return }
$bootstrap = Get-Content -Raw "$PSScriptRoot/bootstrap.lock.json" | ConvertFrom-Json
$clientCp = ($bootstrap.artifacts | Where-Object { !$_.name.Contains('natives-') -or $_.name -match 'natives-windows.jar$' } | ForEach-Object {
    if ($_.name -in @('client-1.13.3.jar','injected-client-1.13.3.jar')) { Join-Path "$runtime/patched" $_.name } else { Join-Path "$runtime/artifacts" $_.name }
}) -join ';'
$optionalHdCp = if ($HD) { "$runtime/117hd.jar;" } else { '' }
$arguments = @("-Dtsps.branding.url=http://127.0.0.1:$HttpPort/branding.json", '-ea', "-Duser.home=$runtime/home", "-Djava.io.tmpdir=$runtime/tmp", '-Drunelite.launcher.version=2.7.4', "-Dtsps.hd=$($HD.IsPresent.ToString().ToLowerInvariant())") + @($bootstrap.clientJvm17Arguments) + @('-cp', "$runtime/classes;$optionalHdCp$clientCp", 'StartClient', "--jav_config=http://127.0.0.1:$HttpPort/jav_config.ws", '--disable-telemetry')
if ($Diagnostics) { $arguments = @('-Dtsps.diagnostics=true') + $arguments }
if ($DeveloperMode) { $arguments += '--developer-mode' }
# ProcessStartInfo.ArgumentList preserves Windows paths containing spaces.
$info = [Diagnostics.ProcessStartInfo]::new("$JavaHome/bin/java.exe")
$info.WorkingDirectory = $runtime
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($name in @('USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP')) {
    $directory = if ($name -in @('TEMP','TMP')) { "$runtime/tmp" } else { "$runtime/home/$name" }
    New-Item -ItemType Directory -Force $directory | Out-Null
    $info.Environment[$name] = $directory
}
foreach ($argument in $arguments) { $info.ArgumentList.Add($argument) }
# Opening either log must succeed before a Java process exists.
$outputFile = [IO.FileStream]::new("$runtime/client.stdout.log", [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
$errorFile = [IO.FileStream]::new("$runtime/client.stderr.log", [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
$process = [Diagnostics.Process]::Start($info)
$output = $process.StandardOutput.BaseStream.CopyToAsync($outputFile)
$errors = $process.StandardError.BaseStream.CopyToAsync($errorFile)
@{ pid=$process.Id; executable=$info.FileName; arguments=$arguments; home="$runtime/home"; started=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Depth 4 | Set-Content "$runtime/process.json"
Write-Output "RuneLite PID $($process.Id); identity $runtime/process.json"
$launchReady = $true
$process.WaitForExit()
$output.GetAwaiter().GetResult()
$errors.GetAwaiter().GetResult()
exit $process.ExitCode
} catch {
    if ($null -ne $process -and !$launchReady -and !$process.HasExited) {
        # This Process object was returned by this invocation's Start above.
        # Never use a PID read from disk or kill an existing/unknown process.
        $process.Kill()
        $process.WaitForExit()
    }
    throw
} finally {
    if ($null -ne $outputFile) { $outputFile.Dispose() }
    if ($null -ne $errorFile) { $errorFile.Dispose() }
    if ($null -ne $process) { $process.Dispose() }
    $instanceLock.Dispose()
}
