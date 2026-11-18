# Installs and exercises the Windows installers on a real Windows machine.
# Run by .github/workflows/windows-installer-test.yml; it can also be run by
# hand on a disposable Windows test machine (never on a machine that holds a
# real workspace: it deletes the app data folder).
#
#   pwsh scripts/windows-install-test.ps1 -Nsis <setup.exe> -Msi <app.msi> -OldDatabase <older workspace.sqlite3>
param(
  [Parameter(Mandatory)][string]$Nsis,
  [Parameter(Mandatory)][string]$Msi,
  [Parameter(Mandatory)][string]$OldDatabase
)
$ErrorActionPreference = 'Stop'
$script:results = @()
$data = Join-Path $env:APPDATA 'dev.arlecchino.unhollowed2'
$db = Join-Path $data 'workspace.sqlite3'

function Check([string]$Name, [scriptblock]$Body) {
  try {
    $detail = & $Body
    $script:results += [pscustomobject]@{ Check = $Name; Result = 'PASS'; Detail = "$detail" }
  } catch {
    $script:results += [pscustomobject]@{ Check = $Name; Result = 'FAIL'; Detail = $_.Exception.Message }
  }
}

function Sql([string]$Query) {
  python -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(sys.argv[2]).fetchone()[0])" $db $Query
}

function Reset-Data { if (Test-Path $data) { Remove-Item $data -Recurse -Force } }

# Starts the app, waits for a window, and stops it.
function Run-App([string]$Exe, [int]$Settle = 8) {
  $started = Get-Date
  $p = Start-Process $Exe -PassThru
  $window = $false
  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    $p.Refresh()
    if ($p.HasExited) { throw "The app exited with code $($p.ExitCode) before showing a window." }
    if ($p.MainWindowHandle -ne 0) { $window = $true; break }
  }
  if (-not $window) { Stop-Process $p -Force; throw 'No main window within 40 seconds.' }
  $ms = [int]((Get-Date) - $started).TotalMilliseconds
  Start-Sleep -Seconds $Settle
  $webview = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count
  $alive = -not $p.HasExited
  Stop-Process $p -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if (-not $alive) { throw 'The app exited during the first seconds.' }
  if ($webview -lt 1) { throw 'No WebView2 process was started.' }
  "window after $ms ms, $webview WebView2 processes"
}

function Find-Exe([string[]]$Roots) {
  foreach ($root in ($Roots | Where-Object { $_ })) {
    if (Test-Path $root) {
      $found = Get-ChildItem $root -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(unhollowed-2|unhollowed 2)\.exe$' } | Select-Object -First 1
      if ($found) { return $found.FullName }
    }
  }
  $seen = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ } | ForEach-Object {
    Get-ChildItem $_ -Directory -Filter '*nhollowed*' -ErrorAction SilentlyContinue | ForEach-Object FullName }
  throw "The app executable was not found after the install. Folders named like the app: $($seen -join '; ')"
}

# 1. Prerequisite: the WebView2 runtime.
Check 'WebView2 runtime is installed' {
  $key = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  "version $((Get-ItemProperty $key).pv)"
}

# 2. Signature state of the installers. Unsigned test builds are expected.
foreach ($file in @($Nsis, $Msi)) {
  Check "Authenticode: $(Split-Path $file -Leaf)" { "$((Get-AuthenticodeSignature $file).Status)" }
}

# 3. NSIS: clean install, start, persistence, upgrade, uninstall.
Reset-Data
$script:nsisExe = $null
Check 'NSIS: silent install' {
  Start-Process $Nsis -ArgumentList '/S' -Wait
  $script:nsisExe = Find-Exe @("$env:LOCALAPPDATA\Unhollowed 2", "$env:LOCALAPPDATA\Programs", $env:ProgramFiles)
  $script:nsisExe
}
Check 'NSIS: first start shows a window and creates the workspace' {
  $r = Run-App $script:nsisExe
  "$r; migrations $(Sql 'select max(version) from _sqlx_migrations')"
}
Check 'NSIS: relaunch keeps the workspace' {
  $before = Sql 'select count(*) from _sqlx_migrations'
  Run-App $script:nsisExe | Out-Null
  $after = Sql 'select count(*) from _sqlx_migrations'
  if ($before -ne $after) { throw "migration count changed $before to $after" }
  "migrations $after"
}
Check 'NSIS: upgrades an older workspace (migration 5) without losing records' {
  Reset-Data
  New-Item $data -ItemType Directory -Force | Out-Null
  Copy-Item $OldDatabase $db
  $before = Sql 'select max(version) from _sqlx_migrations'
  Run-App $script:nsisExe | Out-Null
  $after = Sql 'select max(version) from _sqlx_migrations'
  $project = Sql "select name from projects where name = 'Kept across upgrade'"
  $integrity = Sql 'pragma integrity_check'
  if ($project -ne 'Kept across upgrade' -or $integrity -ne 'ok') { throw "project '$project', integrity '$integrity'" }
  "migrations $before to $after, project kept, integrity $integrity"
}
Check 'NSIS: uninstall removes the app and keeps the data' {
  $dir = Split-Path $script:nsisExe
  $uninstaller = Join-Path $dir 'uninstall.exe'
  Start-Process $uninstaller -ArgumentList '/S' -Wait
  for ($i = 0; $i -lt 60 -and (Test-Path $script:nsisExe); $i++) { Start-Sleep -Seconds 1 }
  if (Test-Path $script:nsisExe) { throw 'The app executable is still present after uninstall.' }
  if (-not (Test-Path $db)) { throw 'The workspace database was removed by the uninstall.' }
  'app removed, workspace.sqlite3 kept'
}

# 4. MSI: install, product version, start, uninstall.
Reset-Data
$script:msiExe = $null
$script:productCode = $null
Check 'MSI: silent install and registered version' {
  Start-Process msiexec -ArgumentList @('/i', "`"$Msi`"", '/qn', '/norestart', '/l*v', "`"$env:RUNNER_TEMP\msi-install.log`"") -Wait
  $entry = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'Unhollowed 2*' } | Select-Object -First 1
  if (-not $entry) { throw 'No uninstall entry for the MSI.' }
  $script:productCode = Split-Path $entry.PSPath -Leaf
  $script:msiExe = Find-Exe @($entry.InstallLocation, "$env:ProgramFiles\Unhollowed 2", "$env:LOCALAPPDATA\Unhollowed 2", $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
  "ProductVersion $($entry.DisplayVersion), $script:msiExe"
}
Check 'MSI: first start shows a window and creates the workspace' {
  $r = Run-App $script:msiExe
  "$r; migrations $(Sql 'select max(version) from _sqlx_migrations')"
}
Check 'MSI: uninstall removes the app and keeps the data' {
  Start-Process msiexec -ArgumentList @('/x', $script:productCode, '/qn', '/norestart') -Wait
  if (Test-Path $script:msiExe) { throw 'The app executable is still present after uninstall.' }
  if (-not (Test-Path $db)) { throw 'The workspace database was removed by the uninstall.' }
  'app removed, workspace.sqlite3 kept'
}

$lines = @('| Check | Result | Detail |', '| --- | --- | --- |') +
  ($script:results | ForEach-Object { "| $($_.Check) | $($_.Result) | $($_.Detail -replace '\|','/' -replace '\r?\n',' ') |" })
$lines | Write-Output
if ($env:GITHUB_STEP_SUMMARY) { $lines | Add-Content $env:GITHUB_STEP_SUMMARY }
if ($script:results | Where-Object Result -eq 'FAIL') { exit 1 }
