param([string]$JavaHome = $env:JAVA_HOME, [switch]$WelcomeBackdropOnly)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot '.runtime'
$cp = ((Get-Content -Raw "$PSScriptRoot/bootstrap.lock.json" | ConvertFrom-Json).artifacts | ForEach-Object { Join-Path "$runtime/artifacts" $_.name }) -join ';'
New-Item -ItemType Directory -Force "$runtime/test-classes" | Out-Null
& "$JavaHome/bin/javac.exe" -proc:none -cp $cp -d "$runtime/test-classes" "$PSScriptRoot/WelcomeBackdrop.java" "$PSScriptRoot/WelcomeBackdropTest.java"
if ($LASTEXITCODE) { throw 'Welcome backdrop test compilation failed' }
& "$JavaHome/bin/java.exe" '-Djava.awt.headless=true' -cp "$runtime/test-classes;$cp" WelcomeBackdropTest
if ($LASTEXITCODE) { throw 'Welcome backdrop tests failed' }
if ($WelcomeBackdropOnly) { return }
& "$JavaHome/bin/javac.exe" -proc:none -cp $cp -d "$runtime/test-classes" "$PSScriptRoot/BrandingAssets.java" "$PSScriptRoot/Branding.java" "$PSScriptRoot/BrandingTest.java" "$PSScriptRoot/BrandingLifecycleTest.java"
if ($LASTEXITCODE) { throw 'Branding test compilation failed' }
& "$JavaHome/bin/java.exe" '-Djava.awt.headless=true' -cp "$runtime/test-classes;$cp" BrandingTest
if ($LASTEXITCODE) { throw 'Branding tests failed' }

& "$JavaHome/bin/java.exe" '-Djava.awt.headless=true' -cp "$runtime/test-classes;$cp" BrandingLifecycleTest
if ($LASTEXITCODE) { throw 'Branding lifecycle tests failed' }
