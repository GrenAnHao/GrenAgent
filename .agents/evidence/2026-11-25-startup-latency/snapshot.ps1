# Snapshot the worktree NOW (uncommitted edits included), and build only inside the supplied temp directory.
param([Parameter(Mandatory)] [string] $Scratch, [Parameter(Mandatory)] [ValidateSet('before','after')] [string] $Tag)
$ErrorActionPreference = 'Stop'
$root=(Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$scratchPath=(Resolve-Path $Scratch).Path
if (!(Split-Path -Leaf $scratchPath).StartsWith('gren-boot-bench-')) {throw 'Expected a dedicated gren-boot-bench-* directory.'}
$repo=Join-Path $scratchPath $Tag
if(Test-Path $repo){throw "Refusing to overwrite an existing snapshot: $repo"}
$app=Join-Path $repo 'electron-agent'
New-Item -ItemType Directory -Path $app -Force | Out-Null
foreach($n in 'electron','src','shared','public','brand'){Copy-Item -Recurse -LiteralPath "$root/electron-agent/$n" -Destination "$app/$n"}
foreach($n in 'tsconfig.json','tsconfig.node.json','electron.vite.config.ts','index.html','package.json'){Copy-Item -LiteralPath "$root/electron-agent/$n" -Destination "$app/$n"}
foreach($n in 'node_modules','vendor','scripts','native','build'){New-Item -ItemType Junction -Path "$app/$n" -Target "$root/electron-agent/$n"|Out-Null}
foreach($n in 'extensions','cli','node_modules'){if(Test-Path "$root/$n"){New-Item -ItemType Junction -Path "$repo/$n" -Target "$root/$n"|Out-Null}}
Push-Location $app
try {
  & "$root/electron-agent/node_modules/.bin/electron-vite.cmd" build --mode localrun *> "$scratchPath/$Tag-build.log"
  if($LASTEXITCODE){Get-Content "$scratchPath/$Tag-build.log" -Tail 30; throw 'Build failed'}
} finally {Pop-Location}
