# Publish dsh-task-alert: fill manifest links, commit, wire the remote, and show the last two steps.
#
# Why a script: the two steps a human must own are the ones that need YOUR credentials
# (pushing to GitHub, publishing to npm). Everything else is mechanical and easy to get wrong.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publish.ps1 -Owner your-github-name
#   ... -Push        also runs: git push -u origin main
#   ... -Publish     also runs: npm publish --access public   (requires npm login)
#   ... -Repo name   override the repository name (default: dsh-task-alert)
param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [string]$Repo = 'dsh-task-alert',
  [switch]$Push,
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
Push-Location $repoDir
try {
  function W($m) { Write-Output $m }
  function Step($m) { Write-Output ""; Write-Output "== $m ==" }

  $url = "https://github.com/$Owner/$Repo"

  # ---------- 1) fill repository/homepage/bugs (node edits JSON so UTF-8 text survives) ----------
  Step 'manifest links'
  $nodeScript = @'
const fs = require("fs");
const path = process.argv[2];
const url = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.repository = { type: "git", url: "git+" + url + ".git" };
pkg.homepage = url + "#readme";
pkg.bugs = { url: url + "/issues" };
fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("repository -> " + pkg.repository.url);
'@
  $tmp = Join-Path $env:TEMP 'dsh-task-alert-set-repo.cjs'
  [System.IO.File]::WriteAllText($tmp, $nodeScript, (New-Object System.Text.UTF8Encoding($false)))
  & node $tmp (Join-Path $repoDir 'package.json') $url
  if ($LASTEXITCODE -ne 0) { throw 'failed to update package.json' }

  # ---------- 2) commit ----------
  Step 'commit'
  & git add -A
  & git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    W 'nothing to commit'
  } else {
    & git commit -q -m "chore: point the package at $url"
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
    W 'committed'
  }

  # ---------- 3) remote ----------
  Step 'remote'
  $existing = (& git remote) 2>$null
  if ($existing -contains 'origin') {
    & git remote set-url origin "$url.git"
    W "origin -> $url.git"
  } else {
    & git remote add origin "$url.git"
    W "origin -> $url.git"
  }

  # ---------- 4) the two steps that need your credentials ----------
  Step 'next: push to GitHub'
  if ($Push) {
    & git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw 'git push failed (check that the empty repo exists and you are signed in)' }
    & git push origin v0.2.0
    W 'pushed'
  } else {
    W "  git push -u origin main"
    W "  git push origin v0.2.0"
  }

  Step 'next: publish to npm (needed for the in-app plugin center)'
  $who = (& npm whoami) 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($who)) {
    W '  npm login        # not signed in yet'
    W '  npm publish --access public'
  } elseif ($Publish) {
    & npm publish --access public
    if ($LASTEXITCODE -ne 0) { throw 'npm publish failed' }
  } else {
    W "  signed in as $who; run: npm publish --access public"
  }

  Step 'then: ask the marketplaces to list it'
  W "  repo topics: add 'dsh-plugin' on $url/settings"
  W '  dsh-plugin.org submission issue:'
  W '  https://github.com/dshplugin/dsh-plugin-hub/issues/new'
} finally {
  Pop-Location
}
