# Build on Windows x64. Requires Node 22+, pnpm 10 and a downloaded Chromium snapshot.
param([string]$NodeVersion = '22.22.3')
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build this package on Windows x64.' }
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'The Windows package currently supports x64 only.' }
if ($NodeVersion -notmatch '^22\.\d+\.\d+$') { throw 'NodeVersion must be a Node 22 version number.' }
foreach ($tool in @('node', 'pnpm', 'tar.exe')) {
    if (!(Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing build tool: $tool" }
}
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid package version.' }
$chromium = Join-Path $root 'chromium\chrome-win'
if (!(Test-Path (Join-Path $chromium 'chrome.exe'))) { throw 'Run node src/cli.js fetch-chromium on Windows first.' }
$dist = Join-Path $root 'dist'
$output = Join-Path $dist 'Marlin-win32-x64'
$temp = Join-Path $dist ('windows-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    $nodeArchive = "node-v$NodeVersion-win-x64.zip"
    $nodeBase = "https://nodejs.org/dist/v$NodeVersion"
    Invoke-WebRequest "$nodeBase/$nodeArchive" -OutFile (Join-Path $temp $nodeArchive) -UseBasicParsing
    $checksums = (Invoke-WebRequest "$nodeBase/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = (($checksums -split "`n" | Where-Object { $_ -match ('  ' + [regex]::Escape($nodeArchive) + '\s*$') }) -split '\s+')[0]
    $actual = (Get-FileHash (Join-Path $temp $nodeArchive) -Algorithm SHA256).Hash
    if (!$expected -or $actual -ne $expected) { throw 'Node runtime checksum mismatch.' }
    & (Join-Path $PSScriptRoot 'extract-zip.ps1') -Archive (Join-Path $temp $nodeArchive) -Destination (Join-Path $temp 'runtime')
    if (Test-Path $output) { Remove-Item -LiteralPath $output -Recurse -Force }
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    foreach ($entry in @('src', 'extension', 'skills', 'scripts', 'package.json', 'pnpm-lock.yaml', 'README.md', 'LICENSE', 'marlin.cmd', 'install.ps1')) {
        Copy-Item -LiteralPath (Join-Path $root $entry) -Destination $output -Recurse -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $output 'node') -Force | Out-Null
    Copy-Item (Join-Path $temp "runtime\node-v$NodeVersion-win-x64\node.exe") (Join-Path $output 'node\node.exe')
    Copy-Item (Join-Path $temp "runtime\node-v$NodeVersion-win-x64\LICENSE") (Join-Path $output 'node\LICENSE')
    New-Item -ItemType Directory -Path (Join-Path $output 'chromium') -Force | Out-Null
    Copy-Item -LiteralPath $chromium -Destination (Join-Path $output 'chromium') -Recurse
    Copy-Item (Join-Path $root 'chromium\REVISION') (Join-Path $output 'chromium\REVISION')
    Push-Location $output
    try {
        & pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
    } finally { Pop-Location }
    $archive = Join-Path $dist "Marlin-$version-windows-x64.zip"
    if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
    & tar.exe -a -c -f $archive -C $dist 'Marlin-win32-x64'
    if ($LASTEXITCODE -ne 0) { throw 'ZIP packaging failed.' }
    $hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($archive))" | Set-Content -Encoding ascii "$archive.sha256"
    Write-Host "Built $archive"
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
