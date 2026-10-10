# Launch the detached helper with the supported Windows Start-Process API.
# RequestFile contains JSON { helper, arguments: string[], workingDirectory }.
param([Parameter(Mandatory = $true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Quote-Argument([string]$Value) {
    if ($Value -match '[\x00\r\n]') { throw 'Invalid control character in helper argument.' }
    # Windows CommandLineToArgvW quoting: escape quotes and trailing backslashes.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'The update bootstrap requires Windows.' }
    if (![IO.Path]::IsPathRooted($RequestFile)) { throw 'RequestFile must be absolute.' }
    $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
    if ($request.helper -isnot [string] -or ![IO.Path]::IsPathRooted($request.helper) -or !(Test-Path -LiteralPath $request.helper -PathType Leaf)) { throw 'A valid absolute helper path is required.' }
    if ($request.workingDirectory -isnot [string] -or ![IO.Path]::IsPathRooted($request.workingDirectory) -or !(Test-Path -LiteralPath $request.workingDirectory -PathType Container)) { throw 'A valid helper working directory is required.' }
    if ($request.arguments -isnot [Array]) { throw 'Helper arguments must be an array of strings.' }
    foreach ($argument in $request.arguments) { if ($argument -isnot [string]) { throw 'Helper arguments must be strings.' } }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $request.helper) + @($request.arguments)
    $commandLine = ($arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    # Start-Process creates an independent Windows process. Do not inherit the
    # bootstrap's redirected streams or use Node's detached PowerShell launch.
    $process = Start-Process -FilePath $powershell -ArgumentList $commandLine -WorkingDirectory $request.workingDirectory -WindowStyle Hidden -PassThru
    [Console]::Out.WriteLine((@{ pid = $process.Id } | ConvertTo-Json -Compress))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
