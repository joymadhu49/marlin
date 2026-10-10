# Detached Windows package replacement. Copy this helper outside both packages.
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [Parameter(Mandatory = $true)][string]$StagedDir,
    [Parameter(Mandatory = $true)][string]$ReadyFile,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Alias('ParentPid')][int]$DaemonPid = 0,
    [int]$BrowserPid = 0,
    [string]$LockPath,
    [string]$ReadyDeadlineUtc,
    [ValidateRange(1, 600)][int]$WaitTimeoutSeconds = 60,
    [ValidateRange(1, 120)][int]$RestartTimeoutSeconds = 45,
    [switch]$NoRestart
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$utf8 = New-Object Text.UTF8Encoding($false)
$logReady = $false
$oldMoved = $false
$newInstalled = $false
$backup = $null
$failed = $false
$lockValidated = $false
$readyWritten = $false
$committed = $false
$restartInFlight = $false
$waiting = $false
$watched = @()

function FullPath([string]$Value) {
    if (!$Value -or ![IO.Path]::IsPathRooted($Value)) { throw "Update paths must be absolute: $Value" }
    $path = [IO.Path]::GetFullPath($Value).TrimEnd('\')
    if ($path -notmatch '^[A-Za-z]:\\' -or $path -match '[%\r\n!]') { throw "Unsupported update path: $Value" }
    return $path
}
function SamePath([string]$A, [string]$B) { return [string]::Equals($A, $B, [StringComparison]::OrdinalIgnoreCase) }
function Within([string]$Path, [string]$Directory) {
    return (SamePath $Path $Directory) -or $Path.StartsWith($Directory + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Log([string]$Message) {
    $line = (Get-Date).ToUniversalTime().ToString('o') + ' ' + $Message
    if ($script:logReady) { [IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine, $utf8) }
    Write-Output $line
}
function Validate-Package([string]$Directory) {
    if (!(Test-Path -LiteralPath $Directory -PathType Container)) { throw "Package directory is missing: $Directory" }
    $item = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Package root must be a real directory: $Directory" }
    foreach ($file in @('package.json', 'marlin.cmd', 'src\cli.js', 'node\node.exe', 'chromium\chrome-win\chrome.exe', 'extension\manifest.json')) {
        $filePath = Join-Path $Directory $file
        if (!(Test-Path -LiteralPath $filePath -PathType Leaf)) { throw "Required package file is missing: $file" }
        $entry = Get-Item -LiteralPath $filePath -Force -ErrorAction Stop
        if ($entry.PSIsContainer -or $entry.Length -eq 0 -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Invalid package file: $file" }
    }
    if (!(Test-Path -LiteralPath (Join-Path $Directory 'node_modules') -PathType Container)) { throw 'Package dependencies are missing.' }
    $package = Get-Content -LiteralPath (Join-Path $Directory 'package.json') -Raw | ConvertFrom-Json
    if ($package.name -ne 'marlin' -or $package.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') { throw 'Not a valid versioned Marlin package.' }
    return $package.version
}
function Package-Processes {
    return @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.ExecutablePath -and (Within ([IO.Path]::GetFullPath($_.ExecutablePath)) $InstallDir)
    })
}
function Watch-Process([int]$ProcessId) {
    if ($ProcessId -le 0) { return }
    try { $process = [Diagnostics.Process]::GetProcessById($ProcessId) }
    catch [ArgumentException] { return } # Already exited before helper startup.
    try {
        # Opening and retaining the handle tracks this process identity even if
        # Windows reuses the PID after it exits. CIM is not the liveness gate.
        $null = $process.Handle
        if ($process.HasExited) { $process.Dispose(); return }
        try { $executable = $process.MainModule.FileName }
        catch {
            if ($process.HasExited) { $process.Dispose(); return }
            throw "Cannot inspect initiating process $ProcessId safely. $($_.Exception.Message)"
        }
        if (!$executable -or !(Within ([IO.Path]::GetFullPath($executable)) $InstallDir)) {
            throw "Refusing to wait for unrelated process $ProcessId; its executable is outside this installation."
        }
        $script:watched += $process
    } catch { $process.Dispose(); throw }
}
function Write-Result([string]$Event, [string]$Message) {
    if (!$script:logReady) { return }
    $result = Join-Path $dataHome 'update-result.json'
    $temporary = $result + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, (@{ event = $Event; message = $Message } | ConvertTo-Json -Compress), $utf8)
    try {
        # Windows PowerShell coerces ordinary $null into an empty string for
        # this .NET string parameter. NullString supplies a real null backup.
        if (Test-Path -LiteralPath $result) { [IO.File]::Replace($temporary, $result, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $result) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) }
    }
}
# These roots are generated/owned by this helper, never supplied cleanup paths.
# Do not follow a package junction into user data while deleting old files.
function Remove-OwnedTree([string]$Directory) {
    foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
        if ($entry.PSIsContainer) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($entry.FullName) }
            else { Remove-OwnedTree $entry.FullName }
        } else { [IO.File]::Delete($entry.FullName) }
    }
    [IO.Directory]::Delete($Directory)
}
function Start-Package {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = Join-Path $InstallDir 'node\node.exe'
    $start.Arguments = '"' + (Join-Path $InstallDir 'src\cli.js') + '" open'
    $start.WorkingDirectory = $InstallDir
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $process = [Diagnostics.Process]::Start($start)
    $script:restartInFlight = $true
    try {
        if (!$process.WaitForExit($RestartTimeoutSeconds * 1000)) { throw 'Restart did not finish in time. Inspect the update log and close Marlin before retrying.' }
        $script:restartInFlight = $false
        if ($process.ExitCode -ne 0) { throw "Updated launcher failed with exit code $($process.ExitCode)." }
    } finally { $process.Dispose() }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This update helper requires Windows.' }
    $InstallDir = FullPath $InstallDir
    $StagedDir = FullPath $StagedDir
    $ReadyFile = FullPath $ReadyFile
    $LogPath = FullPath $LogPath
    $helper = FullPath $PSCommandPath
    $dataHome = if ($env:MARLIN_HOME) { FullPath $env:MARLIN_HOME } else { FullPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Marlin') }
    $parent = [IO.Path]::GetDirectoryName($InstallDir)
    if (!$parent -or (SamePath $InstallDir ([IO.Path]::GetPathRoot($InstallDir).TrimEnd('\')))) { throw 'The installation cannot be a drive root.' }
    if (!(SamePath $parent ([IO.Path]::GetDirectoryName($StagedDir))) -or (SamePath $InstallDir $StagedDir) -or [IO.Path]::GetFileName($StagedDir) -notlike '.marlin-stage-*') {
        throw 'The staged package must be a separate .marlin-stage-* sibling of the installation.'
    }
    foreach ($path in @($helper, $ReadyFile, $LogPath, $dataHome)) {
        if ((Within $path $InstallDir) -or (Within $path $StagedDir)) { throw "Helper, readiness, logs, and profile must remain outside replaced packages: $path" }
    }
    $workspace = [IO.Path]::GetDirectoryName($helper)
    if (!(SamePath ([IO.Path]::GetDirectoryName($workspace)) $parent) -or [IO.Path]::GetFileName($workspace) -notlike '.marlin-update-*') { throw 'Detached helper must be inside a .marlin-update-* sibling workspace.' }
    if ((Get-Item -LiteralPath $workspace -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Detached helper workspace must not be a junction or symbolic link.' }
    if (!(SamePath ([IO.Path]::GetDirectoryName($ReadyFile)) $workspace)) { throw 'ReadyFile must be next to the detached helper.' }
    if (!(SamePath ([IO.Path]::GetDirectoryName($LogPath)) $dataHome)) { throw 'LogPath must be inside the external Marlin data directory.' }
    if ($LockPath) {
        $LockPath = FullPath $LockPath
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $installHash = ([BitConverter]::ToString($hasher.ComputeHash($utf8.GetBytes($InstallDir.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant().Substring(0, 16) }
        finally { $hasher.Dispose() }
        $expectedLock = Join-Path $parent ('.marlin-update-' + $installHash + '.lock')
        if (!(SamePath $LockPath $expectedLock)) { throw 'LockPath must be the installation-scoped sibling update lock.' }
        $lockValidated = $true
    }
    if (!(Test-Path -LiteralPath $dataHome -PathType Container)) { throw 'The external Marlin data directory does not exist.' }
    $logReady = $true
    Log 'Validating detached update.'
    $oldVersion = Validate-Package $InstallDir
    $newVersion = Validate-Package $StagedDir
    if ($DaemonPid -eq $PID -or $BrowserPid -eq $PID) { throw 'The helper cannot wait for itself.' }
    Watch-Process $DaemonPid
    Watch-Process $BrowserPid
    if (Test-Path -LiteralPath $ReadyFile) { throw 'Readiness file already exists.' }
    if ($ReadyDeadlineUtc -and [DateTime]::UtcNow -ge [DateTime]::Parse($ReadyDeadlineUtc).ToUniversalTime()) { throw 'Updater readiness deadline expired; no installation files were changed.' }
    if ($LockPath) {
        # The supported Start-Process bootstrap returns our PID to JavaScript,
        # which then transfers the lock. Wait briefly for that handoff.
        $handoffDeadline = [DateTime]::UtcNow.AddSeconds(5)
        if ($ReadyDeadlineUtc) { $handoffDeadline = [DateTime]::Parse($ReadyDeadlineUtc).ToUniversalTime() }
        while ($true) {
            if (!(Test-Path -LiteralPath $LockPath -PathType Leaf)) { throw 'Updater lock disappeared before readiness.' }
            $owned = $false
            try { $owner = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json; $owned = $owner.pid -eq $PID } catch {}
            if ($owned) { break }
            if ([DateTime]::UtcNow -ge $handoffDeadline) { throw 'Updater lock ownership was not transferred before the readiness deadline.' }
            Start-Sleep -Milliseconds 50
        }
    }
    $readyTemp = $ReadyFile + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($readyTemp, (@{ ready = $true; pid = $PID; version = $newVersion } | ConvertTo-Json -Compress), $utf8)
    [IO.File]::Move($readyTemp, $ReadyFile)
    $readyWritten = $true
    Log "Ready to update $oldVersion to $newVersion; waiting for installation processes."
    $waiting = $true
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitTimeoutSeconds)
    while ($true) {
        $activeWatched = @($watched | Where-Object { !$_.HasExited })
        $busy = @(Package-Processes)
        if ($activeWatched.Count -eq 0 -and $busy.Count -eq 0) { break }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw ('Timed out waiting for Marlin processes: ' + ((@($busy | ForEach-Object { $_.ProcessId }) + @($activeWatched | ForEach-Object { $_.Id }) | Select-Object -Unique) -join ', ') + '. Close Marlin and MCP clients, then retry. No processes were killed.')
        }
        Start-Sleep -Milliseconds 250
    }
    if ($LockPath) {
        $owner = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
        if ($owner.pid -ne $PID) { throw 'Updater lock ownership was lost; installation was not changed.' }
    }
    $waiting = $false
    $backup = Join-Path $parent ('.marlin-backup-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($InstallDir, $backup)
    $oldMoved = $true
    [IO.Directory]::Move($StagedDir, $InstallDir)
    $newInstalled = $true
    Write-Result 'none' "Updated to $newVersion."
    if (!$NoRestart) { Start-Package }
    $committed = $true
    # Cleanup cannot trigger rollback after the new app is running.
    try { Remove-OwnedTree $backup; $oldMoved = $false }
    catch { Log "Update succeeded; old package cleanup needs attention at $backup. $($_.Exception.Message)" }
    Log "Updated to $newVersion. External profile preserved at $dataHome."
    try { Remove-OwnedTree $workspace; $readyWritten = $false }
    catch { Log "Update succeeded; helper workspace cleanup needs attention at $workspace. $($_.Exception.Message)" }
} catch {
    $failed = $true
    $reason = $_.Exception.Message
    try { Write-Result 'error' $reason } catch { Write-Warning ('Could not save update result: ' + $_.Exception.Message) }
    try { Log "Update failed: $reason" } catch { Write-Warning $reason }
    if ($oldMoved -and !$committed) {
        try {
            if ($newInstalled -and ($restartInFlight -or @(Package-Processes).Count -gt 0)) {
                throw 'The updated application may still be running. It was left untouched; close it before manually restoring the backup.'
            }
            if ($newInstalled) { [IO.Directory]::Move($InstallDir, $StagedDir) }
            [IO.Directory]::Move($backup, $InstallDir)
            $oldMoved = $false
            Log 'Previous package restored. The rejected staged package was retained for diagnosis.'
            if (!$NoRestart) {
                try { Start-Package; Log 'Previous package restarted.' } catch { Log ('Previous package restart failed: ' + $_.Exception.Message) }
            }
        } catch {
            try { Log "Automatic rollback failed. Previous package remains at $backup. Close Marlin and MCP clients before restoring it. $($_.Exception.Message)" } catch {}
        }
    }
    if ($waiting -and !$NoRestart) {
        try { Start-Package; Log 'Previous package opened after the update wait timed out.' }
        catch { Log ('Could not reopen the previous package: ' + $_.Exception.Message) }
    }
    Write-Error -Message $reason -ErrorAction Continue
} finally {
    foreach ($process in $watched) { $process.Dispose() }
    # Only remove the lock handed to this helper, never another updater's lock.
    if ($failed -and $readyWritten) {
        try { Remove-Item -LiteralPath $ReadyFile -Force } catch {}
    }
    if ($lockValidated -and (Test-Path -LiteralPath $LockPath -PathType Leaf)) {
        try {
            $owner = Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json
            if ($owner.pid -eq $PID) { Remove-Item -LiteralPath $LockPath -Force }
        } catch {}
    }
}
if ($failed) { exit 1 }
