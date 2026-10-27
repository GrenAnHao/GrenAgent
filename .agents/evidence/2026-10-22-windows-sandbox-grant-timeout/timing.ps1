# Re-applies the same grant (idempotent) with and without /T and times each.
param([string]$Workspace)
$icacls = Join-Path ([Environment]::GetFolderPath('System')) 'icacls.exe'
$a = Measure-Command { & $icacls $Workspace /grant:r 'PiSandbox:(OI)(CI)M' /C /Q | Out-Null }
"no /T:   {0:N1}s" -f $a.TotalSeconds
$b = Measure-Command { & $icacls $Workspace /grant:r 'PiSandbox:(OI)(CI)M' /C /T /Q | Out-Null }
"with /T: {0:N1}s" -f $b.TotalSeconds
