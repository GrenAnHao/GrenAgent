# Grant without /T on a fresh tree: does a deep file pick up the inherited ACE, and does a protected subdirectory stay out?
$icacls = Join-Path ([Environment]::GetFolderPath('System')) 'icacls.exe'
$root = Join-Path $env:TEMP ('grant-inherit-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$deep = Join-Path $root 'a\b\c'
$prot = Join-Path $root '.pi'
New-Item -ItemType Directory -Force $deep, $prot | Out-Null
Set-Content (Join-Path $deep 'f.txt') 'x'
Set-Content (Join-Path $prot 'cfg.json') '{}'
& $icacls $prot /inheritance:d /C /Q | Out-Null
& $icacls $root /grant:r 'PiSandbox:(OI)(CI)M' /C /Q | Out-Null
"deep file:      " + ((& $icacls (Join-Path $deep 'f.txt')) -match 'PiSandbox' -join ' | ')
"protected file: " + ((& $icacls (Join-Path $prot 'cfg.json')) -match 'PiSandbox' -join ' | ')
Remove-Item -Recurse -Force $root
