param([string]$JavaHome = $env:JAVA_HOME, [switch]$HD)
$ErrorActionPreference = 'Stop'
if (!$JavaHome -or !(Test-Path -LiteralPath "$JavaHome/bin/java.exe")) { throw 'Set JAVA_HOME to a JDK21 installation or pass -JavaHome' }
if (!(Test-Path -LiteralPath "$JavaHome/release") -or !(Select-String -LiteralPath "$JavaHome/release" -Pattern '^JAVA_VERSION="21(?:[."+])' -Quiet)) { throw 'A JDK21 installation is required' }
$runtime = Join-Path $PSScriptRoot '.runtime'
New-Item -ItemType Directory -Force $runtime, "$runtime/artifacts", "$runtime/launcher", "$runtime/classes", "$runtime/home/.rsprox/signkey", "$runtime/home/.rsprox/runelite", "$runtime/tmp" | Out-Null
function Get-VerifiedFile($Url, $Destination, $Hash, $Size) {
    if (!(Test-Path -LiteralPath $Destination)) { Invoke-WebRequest -Uri $Url -OutFile $Destination }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw "SHA256 mismatch: $Destination" }
    if ($Size -and (Get-Item -LiteralPath $Destination).Length -ne $Size) { throw "Size mismatch: $Destination" }
}
foreach ($pair in @(@('bootstrap.lock.json','artifacts'), @('launcher.lock.json','launcher'))) {
    $manifest = Get-Content -Raw (Join-Path $PSScriptRoot $pair[0]) | ConvertFrom-Json
    foreach ($artifact in $manifest.artifacts) { Get-VerifiedFile $artifact.path (Join-Path "$runtime/$($pair[1])" $artifact.name) $artifact.hash $artifact.size }
}
if ($HD) {
$hd = Get-Content -Raw "$PSScriptRoot/117hd.lock.json" | ConvertFrom-Json
Get-VerifiedFile $hd.path "$runtime/117hd.jar" $hd.hash $hd.size
Get-VerifiedFile 'https://repo.runelite.net/plugins/manifest/1.13.3_full.js' "$runtime/plugin-manifest.js" $hd.manifestHash 0
}
Get-VerifiedFile 'https://api.github.com/repos/blurite/rsprox-runelite-launcher/zipball/22da30645f6b8b0627ad582351d567f6b84d68c7' "$runtime/patch-source.zip" 'f6579b79eca49d6c0f7010000556491ce7fde7e61223de96107ee0bf3abcc8a2' 0
$launcherCp = ((Get-Content -Raw "$PSScriptRoot/launcher.lock.json" | ConvertFrom-Json).artifacts | ForEach-Object { Join-Path "$runtime/launcher" $_.name }) -join ';'
& "$JavaHome/bin/javac.exe" -proc:none -cp $launcherCp -d "$runtime/classes" "$PSScriptRoot/PatchClient.java"
if ($LASTEXITCODE) { throw 'Patcher compilation failed' }
$clientCp = ((Get-Content -Raw "$PSScriptRoot/bootstrap.lock.json" | ConvertFrom-Json).artifacts | ForEach-Object { Join-Path "$runtime/artifacts" $_.name }) -join ';'
& "$JavaHome/bin/javac.exe" -proc:none -cp $clientCp -d "$runtime/classes" "$PSScriptRoot/BrandingAssets.java" "$PSScriptRoot/Branding.java" "$PSScriptRoot/WelcomeBackdrop.java" "$PSScriptRoot/ChatDiagnostics.java" "$PSScriptRoot/StartClient.java"
if ($LASTEXITCODE) { throw 'Client entry point compilation failed' }
$verification = @($runtime, 'verify')
if ($HD) { $verification += 'hd' }
& "$JavaHome/bin/java.exe" "-Duser.home=$runtime/home" -cp "$runtime/classes;$launcherCp" PatchClient @verification
if ($LASTEXITCODE) { throw 'Revision or manifest verification failed' }
$keyStore = "$runtime/home/.rsprox/signkey/fake-cert.jks"
if (!(Test-Path -LiteralPath $keyStore)) {
    & "$JavaHome/bin/keytool.exe" -genkeypair -alias test -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=TSPS isolated client' -storepass 123456 -keypass 123456 -keystore $keyStore
    if ($LASTEXITCODE) { throw 'Local signing certificate generation failed' }
}
Write-Output "Prepared pinned RuneLite1.13.3 / native241 in $runtime (optional117HD: $($HD.IsPresent))"
