param(
 [string]$JavaHome=$env:JAVA_HOME,
 [int]$Port=43820,
 [int]$HttpPort=43920,
 [string]$Upstream='ws://127.0.0.1:43720',
 [string]$Cache='../../server/caches/osrs-241_2026-10-20',
 [string]$BrandingFile,
 [switch]$Build,
 [switch]$TraceInput,
 [switch]$PrepareOnly
)
$ErrorActionPreference='Stop'
if (!$JavaHome -or !(Test-Path -LiteralPath "$JavaHome/bin/java.exe")) { throw 'Set JAVA_HOME to a JDK21 installation or pass -JavaHome' }
if (!(Test-Path -LiteralPath "$JavaHome/release") -or !(Select-String -LiteralPath "$JavaHome/release" -Pattern '^JAVA_VERSION="21(?:[."+])' -Quiet)) { throw 'A JDK21 installation is required' }
$priorJavaHome=$env:JAVA_HOME
$priorGradleHome=$env:GRADLE_USER_HOME
if ($BrandingFile) { $BrandingFile=(Resolve-Path -LiteralPath $BrandingFile).Path }
Push-Location $PSScriptRoot
try {
 $brandingArguments=@()
 if ($BrandingFile) { $brandingArguments=@('--branding',(Resolve-Path -LiteralPath $BrandingFile).Path) }
 elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'branding.local.json')) { $brandingArguments=@('--branding',(Join-Path $PSScriptRoot 'branding.local.json')) }
 $env:JAVA_HOME=$JavaHome
 $env:GRADLE_USER_HOME=Join-Path $PSScriptRoot '.runtime/gradle-home'
 $entry=Join-Path $PSScriptRoot 'build/install/tsps-runelite-gateway/lib/tsps-runelite-gateway.jar'
 if($Build -or !(Test-Path $entry)) {
  & ./gradlew.bat installDist --console=plain
  if($LASTEXITCODE){throw 'Gateway build failed'}
 }
 if($PrepareOnly){return}
 # Wildcard classpath avoids Windows cmd.exe's8191-character command limit.
 $traceFlag=if($TraceInput){'true'}else{'false'}
 & "$JavaHome/bin/java.exe" -cp 'build/install/tsps-runelite-gateway/lib/*' gateway.MainKt --port $Port --http-port $HttpPort --upstream $Upstream --cache $Cache --trace-input $traceFlag @brandingArguments
 if($LASTEXITCODE){throw "Gateway exited withcode $LASTEXITCODE"}
} finally {$env:JAVA_HOME=$priorJavaHome;$env:GRADLE_USER_HOME=$priorGradleHome;Pop-Location}
