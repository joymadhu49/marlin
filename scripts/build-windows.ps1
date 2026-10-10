# Build with matching Node and Chromium architectures on Windows.
param(
    [string]$NodeVersion = '22.22.3',
    [ValidateSet('x64', 'arm64', 'x86')][string]$Architecture = 'x64',
    [string]$Version = $env:MARLIN_WINDOWS_VERSION
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build this package on Windows.' }
if ($NodeVersion -notmatch '^22\.\d+\.\d+$') { throw 'NodeVersion must be a Node 22 version number.' }
foreach ($tool in @('node', 'pnpm', 'tar.exe')) {
    if (!(Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing build tool: $tool" }
}
$root = Split-Path $PSScriptRoot -Parent
$package = Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json
$sourceVersion = $package.version
if (!$Version) { $Version = $sourceVersion }
if ($Version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-windows\.(0|[1-9]\d*)$') { throw 'Version must use the Windows update channel: X.Y.Z-windows.N.' }
if (($Version -replace '-windows\.\d+$', '') -ne ($sourceVersion -replace '-windows\.\d+$', '')) { throw 'Windows version must match the source base version.' }
$nodeArch = (& node -p 'process.arch').Trim()
$expectedNodeArch = if ($Architecture -eq 'x86') { 'ia32' } else { $Architecture }
if ($LASTEXITCODE -ne 0 -or $nodeArch -ne $expectedNodeArch) { throw "Build Node architecture must be $expectedNodeArch (received $nodeArch)." }
function Assert-PeArchitecture([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Invalid Windows executable: $Path" }
        $stream.Position = 0x3C
        $offset = $reader.ReadUInt32()
        if ($offset -gt ($stream.Length - 6)) { throw "Invalid PE header: $Path" }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "Invalid PE signature: $Path" }
        $machine = $reader.ReadUInt16()
        $expected = @{ x64 = 0x8664; arm64 = 0xAA64; x86 = 0x014C }[$Architecture]
        if ($machine -ne $expected) { throw "Executable architecture does not match $Architecture : $Path" }
    } finally { $reader.Dispose(); $stream.Dispose() }
}
$chromium = Join-Path $root 'chromium\chrome-win'
if (!(Test-Path (Join-Path $chromium 'chrome.exe'))) { throw 'Run node src/cli.js fetch-chromium on Windows first.' }
Assert-PeArchitecture (Join-Path $chromium 'chrome.exe')
$dist = Join-Path $root 'dist'
$output = Join-Path $dist "Marlin-win32-$Architecture"
$temp = Join-Path $dist ('windows-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    $nodeArchive = "node-v$NodeVersion-win-$Architecture.zip"
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
    $package.version = $Version
    $package | Add-Member -NotePropertyName marlinWindowsArch -NotePropertyValue $Architecture -Force
    [IO.File]::WriteAllText((Join-Path $output 'package.json'), ($package | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    New-Item -ItemType Directory -Path (Join-Path $output 'node') -Force | Out-Null
    Copy-Item (Join-Path $temp "runtime\node-v$NodeVersion-win-$Architecture\node.exe") (Join-Path $output 'node\node.exe')
    Copy-Item (Join-Path $temp "runtime\node-v$NodeVersion-win-$Architecture\LICENSE") (Join-Path $output 'node\LICENSE')
    Assert-PeArchitecture (Join-Path $output 'node\node.exe')
    New-Item -ItemType Directory -Path (Join-Path $output 'chromium') -Force | Out-Null
    Copy-Item -LiteralPath $chromium -Destination (Join-Path $output 'chromium') -Recurse
    Copy-Item (Join-Path $root 'chromium\REVISION') (Join-Path $output 'chromium\REVISION')
    Push-Location $output
    try {
        & pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
    } finally { Pop-Location }
    $archive = Join-Path $dist "Marlin-$Version-windows-$Architecture.zip"
    if (Test-Path $archive) { Remove-Item -LiteralPath $archive -Force }
    & tar.exe -a -c -f $archive -C $dist "Marlin-win32-$Architecture"
    if ($LASTEXITCODE -ne 0) { throw 'ZIP packaging failed.' }
    $hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($archive))" | Set-Content -Encoding ascii "$archive.sha256"
    Write-Host "Built $archive"
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
