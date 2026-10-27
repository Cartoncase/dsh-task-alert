# Install dsh-task-alert into the DSH desktop profile.
#   1) copy the package files into ~/.dsh/profiles/desktop/node_modules/dsh-task-alert
#   2) register it in profile/package.json under dsh.profile.bundles (backed up first)
# Idempotent. A DSH restart is required afterwards (HMR usually picks it up sooner).
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pkgJsonPath = Join-Path $profile 'package.json'
$dest = Join-Path $profile 'node_modules\dsh-task-alert'
$files = @('package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE')

function W($m) { Write-Output $m }

if (-not (Test-Path (Join-Path $repo 'package.json'))) { throw "package.json not found in repo root: $repo" }
if (-not (Test-Path $pkgJsonPath)) { throw "profile manifest not found: $pkgJsonPath" }

# ---------- 1) copy package files ----------
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($name in $files) {
  $from = Join-Path $repo $name
  if (-not (Test-Path $from)) { throw "missing package file: $from" }
  Copy-Item -LiteralPath $from -Destination (Join-Path $dest $name) -Force
}
W "== copied to $dest =="
Get-ChildItem $dest | ForEach-Object { W ("  " + $_.Name) }

# ---------- 2) register bundle ----------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$pkgJsonPath.bak-task-alert-$stamp"
Copy-Item $pkgJsonPath $backup
W ""
W "== profile/package.json backup: $backup =="

$raw = [System.IO.File]::ReadAllText($pkgJsonPath)
if ($raw -match '"dsh-task-alert"') {
  W 'bundle already registered, skipped'
} else {
  $lines = @($raw -split "`r?`n")
  $lastQuoted = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*"[^"]+"\s*,?\s*$') { $lastQuoted = $i }
  }
  if ($lastQuoted -lt 0) { throw 'could not find a bundles entry in profile/package.json' }
  $out = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($i -eq $lastQuoted) {
      $line = $lines[$i].TrimEnd()
      if ($line.EndsWith(',')) { $out.Add($line) } else { $out.Add($line + ',') }
      $out.Add('        "dsh-task-alert"')
    } else {
      $out.Add($lines[$i])
    }
  }
  [System.IO.File]::WriteAllText($pkgJsonPath, ($out -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
  W 'registered dsh-task-alert in dsh.profile.bundles'
}

# ---------- 3) verify the manifest is still valid JSON ----------
$check = [System.IO.File]::ReadAllText($pkgJsonPath) | ConvertFrom-Json
$bundles = @($check.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-task-alert') { throw 'registration failed: dsh-task-alert missing from bundles' }
W ""
W ("bundles = " + ($bundles -join ', '))
W 'DONE - restart DeepSeek Harness to load the plugin (health: /task-alert/health)'
