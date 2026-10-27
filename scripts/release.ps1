# Release a new version of dsh-task-alert in one command.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release.ps1
#   ... -Bump minor        # 0.2.5 -> 0.3.0
#   ... -DryRun            # bump + tests only, then restore package.json
#
# Requirements: clean git tree (commit your changes first), npm logged in, DSH profile present.
# Note: ASCII-only file. Windows PowerShell 5.1 reads .ps1 as ANSI, so a Chinese literal
# would be mangled. Paths come from $PSScriptRoot at runtime instead.
param(
  [ValidateSet('patch', 'minor', 'major')][string]$Bump = 'patch',
  [switch]$DryRun
)

# PS 5.1 turns native stderr (git warnings, npm notices) into ErrorRecords; with 'Stop'
# that aborts the script mid-way. So we keep 'Continue' and check $LASTEXITCODE ourselves.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logFile = Join-Path $env:TEMP ('dsh-release-' + [guid]::NewGuid().ToString('N') + '.log')
function Say($m) { Write-Output $m }
function Step($m) { Write-Output ''; Write-Output "== $m ==" }

function ReadVersion {
  # -Encoding UTF8 is required: package.json has Chinese text and no BOM.
  return (Get-Content (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

# Run a native command, capturing both streams to the log; returns its exit code.
function Invoke-Logged {
  param([string]$Exe, [string[]]$ArgList)
  & $Exe @ArgList 2>&1 | Out-File -FilePath $logFile -Append -Encoding UTF8
  return $LASTEXITCODE
}

function Fail($m) {
  Write-Output ''
  Write-Output "FAILED: $m"
  if (Test-Path $logFile) {
    Write-Output '--- last output ---'
    Get-Content $logFile -Tail 25 -Encoding UTF8 | ForEach-Object { Write-Output $_ }
  }
  exit 1
}

# ---------- 0) preflight ----------
Step 'preflight'
$statusArgs = @('status', '--porcelain')
$dirty = (& git status --porcelain) 2>$null
if ($LASTEXITCODE -ne 0) { Fail 'not a git repository' }
if ($dirty) {
  Say 'working tree is not clean - commit or stash these first:'
  & git status --short
  Fail 'aborted'
}
$current = ReadVersion
Say "current version: $current"

# ---------- 1) bump ----------
Step "bump ($Bump)"
$code = Invoke-Logged 'npm' @('version', $Bump, '--no-git-tag-version', '--silent')
if ($code -ne 0) { Fail 'npm version failed' }
$version = ReadVersion
Say "new version: $version (tag v$version)"

# ---------- 2) tests ----------
Step 'tests'
& npm test --silent
if ($LASTEXITCODE -ne 0) { Fail 'npm test failed - nothing was committed or published' }

if ($DryRun) {
  & git checkout -- package.json
  Write-Output ''
  Say "DryRun: bump + tests passed ($current -> $version); package.json restored."
  Say 'nothing was committed, tagged or published.'
  exit 0
}

# ---------- 3) pack + smoke test the exact tarball ----------
Step 'pack smoke'
$tmp = Join-Path $env:TEMP ('dsh-pack-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$code = Invoke-Logged 'npm' @('pack', '--pack-destination', $tmp)
if ($code -ne 0) { Fail 'npm pack failed' }
$tgz = Get-ChildItem $tmp -Filter *.tgz | Select-Object -First 1
if ($null -eq $tgz) { Fail 'npm pack produced no tarball' }
$code = Invoke-Logged 'tar' @('-xzf', $tgz.FullName, '-C', $tmp)
if ($code -ne 0) { Fail 'tar failed' }
& node (Join-Path $repo 'test\pack-smoke.mjs') (Join-Path $tmp 'package')
if ($LASTEXITCODE -ne 0) { Fail 'pack smoke failed - nothing was committed or published' }
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

# ---------- 4) commit + tag + push ----------
Step 'git'
if ((Invoke-Logged 'git' @('add', '-A')) -ne 0) { Fail 'git add failed' }
if ((Invoke-Logged 'git' @('commit', '-q', '-m', "chore(release): v$version")) -ne 0) { Fail 'git commit failed' }
if ((Invoke-Logged 'git' @('tag', "v$version")) -ne 0) { Fail "git tag v$version failed (already exists?)" }
if ((Invoke-Logged 'git' @('push', '-q', 'origin', 'main')) -ne 0) { Fail 'git push main failed' }
if ((Invoke-Logged 'git' @('push', '-q', 'origin', "v$version")) -ne 0) { Fail 'git push tag failed' }
Say "pushed main + v$version"

# ---------- 5) publish ----------
Step 'npm publish'
if ((Invoke-Logged 'npm' @('publish', '--access', 'public')) -ne 0) { Fail 'npm publish failed (2FA / token / network)' }
Say "published dsh-task-alert@$version"

# ---------- 6) sync the local DSH profile ----------
Step 'sync local profile'
$dest = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-task-alert'
if (Test-Path $dest) {
  foreach ($name in @('index.js', 'client.js', 'package.json', 'README.md', 'LICENSE', 'icon.svg', 'cordis.patch.yml')) {
    $from = Join-Path $repo $name
    if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $dest $name) -Force }
  }
  Say "synced to $dest"
} else {
  Say "profile dir not found, skipped: $dest"
}

Step 'done'
Say "released v$version"
Say 'restart DeepSeek Harness to load the new host half, then check:'
Say '  curl http://127.0.0.1:<port>/task-alert/health'
exit 0
