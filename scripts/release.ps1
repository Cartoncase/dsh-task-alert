# Release a new version of dsh-task-alert in one command.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\release.ps1            # patch bump
#   ... -Bump minor                                                                       # minor bump
#   ... -DryRun                                                                           # stop after tests
#
# Steps: clean-tree check -> bump -> npm test -> pack+smoke -> commit -> tag -> push -> npm publish -> sync local profile.
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.
param(
  [ValidateSet('patch', 'minor', 'major')][string]$Bump = 'patch',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function W($m) { Write-Output $m }
function Step($m) { Write-Output ""; Write-Output "== $m ==" }
function ReadVersion {
  # must pass -Encoding UTF8: package.json contains Chinese (description), and PS 5.1
  # otherwise decodes a BOM-less file as ANSI, which breaks ConvertFrom-Json.
  return (Get-Content (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

# ---------- 0) must start from a clean tree ----------
Step 'preflight'
$dirty = (& git status --porcelain) 2>$null
if ($LASTEXITCODE -ne 0) { throw 'not a git repository' }
if ($dirty) {
  W 'working tree is not clean - commit or stash these first:'
  & git status --short
  throw 'aborted'
}
$current = ReadVersion
W "current version: $current"

# ---------- 1) bump ----------
Step "bump ($Bump)"
& npm version $Bump --no-git-tag-version --silent | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'npm version failed' }
$version = ReadVersion
W "new version: $version (tag v$version)"

if ($DryRun) {
  W ''
  W "DryRun: stopped before commit/publish. package.json is now $version (undo with: git checkout -- package.json)"
  return
}

# ---------- 2) tests ----------
Step 'tests'
& npm test --silent
if ($LASTEXITCODE -ne 0) { throw 'npm test failed - nothing was committed or published' }

# ---------- 3) pack + smoke test the exact tarball ----------
Step 'pack smoke'
$tmp = Join-Path $env:TEMP ("dsh-task-alert-release-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  & npm pack --pack-destination $tmp 2>&1 | Out-Null
  $tgz = Get-ChildItem $tmp -Filter *.tgz | Select-Object -First 1
  if ($null -eq $tgz) { throw 'npm pack produced no tarball' }
  & tar -xzf $tgz.FullName -C $tmp
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
  & node (Join-Path $repo 'test\pack-smoke.mjs') (Join-Path $tmp 'package')
  if ($LASTEXITCODE -ne 0) { throw 'pack smoke failed - nothing was committed or published' }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ---------- 4) commit + tag + push ----------
Step 'git'
& git add -A
& git commit -q -m "chore(release): v$version"
if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
& git tag "v$version"
if ($LASTEXITCODE -ne 0) { throw 'git tag failed (already exists?)' }
& git push -q origin main
if ($LASTEXITCODE -ne 0) { throw 'git push failed' }
& git push -q origin "v$version"
if ($LASTEXITCODE -ne 0) { throw 'git push tag failed' }
W "pushed main + v$version"

# ---------- 5) publish ----------
Step 'npm publish'
& npm publish --access public
if ($LASTEXITCODE -ne 0) { throw 'npm publish failed (2FA / token / network)' }

# ---------- 6) sync the local DSH profile so the running app can pick it up after restart ----------
Step 'sync local profile'
$dest = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-task-alert'
if (Test-Path $dest) {
  foreach ($name in @('index.js', 'client.js', 'package.json', 'README.md', 'LICENSE', 'icon.svg', 'cordis.patch.yml')) {
    $from = Join-Path $repo $name
    if (Test-Path $from) { Copy-Item -LiteralPath $from -Destination (Join-Path $dest $name) -Force }
  }
  W "synced to $dest"
} else {
  W "profile dir not found, skipped: $dest"
}

Step 'done'
W "released v$version"
W 'restart DeepSeek Harness to load the new host half, then check:'
W '  curl http://127.0.0.1:<port>/task-alert/health'
