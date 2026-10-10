# Run from an extracted Windows portable package. No administrator rights required.
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Marlin'),
    [switch]$NoPath,
    [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$destination = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if (!(Test-Path -LiteralPath (Join-Path $source 'node\node.exe'))) { throw 'Run install.ps1 from the extracted Marlin Windows package.' }
if ($destination.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase) -or $source.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Source and installation directories must not contain one another.'
}
if ($source -ne $destination) {
    if (Test-Path -LiteralPath $destination) { throw "Destination already exists: $destination. Stop Marlin and choose a new directory or move the old installation first. Your browser data is stored separately in LocalAppData\Marlin." }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    try { Get-ChildItem -LiteralPath $source -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force } }
    catch { Remove-Item -LiteralPath $destination -Recurse -Force; throw }
}
if (!$NoPath) {
    $current = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    if (($current -split ';') -notcontains $destination) {
        [Environment]::SetEnvironmentVariable('Path', (($current.TrimEnd(';') + ';' + $destination).TrimStart(';')), 'User')
    }
}
if (!$NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Marlin.lnk'))
    $shortcut.TargetPath = Join-Path $destination 'marlin.cmd'
    $shortcut.WorkingDirectory = $destination
    $shortcut.WindowStyle = 7
    $shortcut.Save()
}
Write-Host "Installed Marlin to $destination. Open a new terminal to use marlin, or double-click marlin.cmd."
Write-Host 'Run marlin setup to generate MCP client configuration.'
