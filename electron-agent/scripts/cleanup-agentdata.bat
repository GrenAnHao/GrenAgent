@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  AgentData cleanup after the product retirement.
REM
REM  Default: delete only data left by retired capabilities
REM  (tasks, audit, material wiki, legacy kernel tables).
REM  Keeps threads / turns / items / permission_rules / tool_audit /
REM  plugin_state / service_tasks, which are still in use.
REM
REM  Usage:
REM    cleanup-agentdata.bat            interactive, default cleanup
REM    cleanup-agentdata.bat /dryrun    print the plan, change nothing
REM    cleanup-agentdata.bat /full      also delete agent-data.db (dangerous)
REM    cleanup-agentdata.bat /yes       skip the /full confirmation
REM
REM  Irreversible: deleted task and audit history cannot be recovered.
REM ============================================================

set "APP_DIR=%APPDATA%\electron-agent"
set "DB=%APP_DIR%\agent-data.db"
set "DRYRUN=0"
set "FULL=0"
set "ASSUME_YES=0"

for %%A in (%*) do (
  if /I "%%~A"=="/dryrun" set "DRYRUN=1"
  if /I "%%~A"=="/full"   set "FULL=1"
  if /I "%%~A"=="/yes"    set "ASSUME_YES=1"
)

echo.
echo === AgentData cleanup ===
echo Data dir: %APP_DIR%
if "%DRYRUN%"=="1" echo Mode: dry run, nothing will be modified
if "%FULL%"=="1"   echo Mode: full delete, including agent-data.db
echo.

if not exist "%APP_DIR%" (
  echo [skip] data dir not found, the app may never have started
  goto :end
)

REM ---------- 1. the app must be closed ----------
tasklist /FI "IMAGENAME eq electron.exe" 2>nul | findstr /I /C:"electron.exe" >nul
if not errorlevel 1 (
  echo [abort] electron.exe is still running.
  echo         The database is locked by it; deleting now would fail or corrupt data.
  echo         Quit GrenAgent completely ^(including the tray icon^) and retry.
  goto :fail
)

REM ---------- 2. backup ----------
set "STAMP=%DATE:~0,4%%DATE:~5,2%%DATE:~8,2%-%TIME:~0,2%%TIME:~3,2%%TIME:~6,2%"
set "STAMP=%STAMP: =0%"
set "BACKUP=%APPDATA%\grenagent-backup-%STAMP%"

if "%DRYRUN%"=="1" (
  echo [dry] would back up agent-data.db to %BACKUP%
) else (
  echo [1/4] backing up agent-data.db ...
  if exist "%DB%" (
    if not exist "%BACKUP%" mkdir "%BACKUP%" >nul 2>&1
    copy /Y "%DB%" "%BACKUP%\agent-data.db" >nul
    if errorlevel 1 (
      echo [abort] backup failed, nothing was deleted.
      goto :fail
    )
    echo        saved to %BACKUP%\agent-data.db
  ) else (
    echo        no agent-data.db, backup skipped
  )
)

REM ---------- 3. drop retired tables ----------
REM  Belongs to retired capabilities only. Deliberately excludes the tables
REM  still used by threads, permissions, tool audit, plugins and service tasks.
set "DROP_TABLES=agent_jobs agent_audit wiki_assets wiki_documents wiki_pages wiki_sources wiki_libraries wiki_fts wiki_ingest_runs wiki_page_state wiki_source_revisions native_wiki_projection native_wiki_events knowledge_build_items knowledge_source_snapshots knowledge_execution_requests wiki_task_targets"

if "%DRYRUN%"=="1" (
  echo [dry] would drop these tables from agent-data.db:
  for %%T in (%DROP_TABLES%) do echo           %%T
) else (
  echo [2/4] dropping retired tables ...
  if exist "%DB%" (
    node "%~dp0drop-retired-tables.mjs" "%DB%" %DROP_TABLES%
    if errorlevel 1 (
      echo [warn] dropping tables failed; the database may be partially cleaned.
      echo        Backup is still at %BACKUP%
    )
  ) else (
    echo        no agent-data.db, skipped
  )
)

REM ---------- 4. material wiki directory ----------
if "%DRYRUN%"=="1" (
  echo [dry] would delete directory: %APP_DIR%\wiki
) else (
  echo [3/4] removing material wiki directory ...
  if exist "%APP_DIR%\wiki" (
    rmdir /S /Q "%APP_DIR%\wiki"
    if errorlevel 1 (echo        failed, directory may be in use) else (echo        removed)
  ) else (
    echo        not present, skipped
  )
)

REM ---------- 5. optional: delete the database itself ----------
if "%FULL%"=="1" (
  if "%DRYRUN%"=="1" (
    echo [dry] would delete agent-data.db with its -wal and -shm files
  ) else (
    if "%ASSUME_YES%"=="0" (
      echo.
      echo [danger] /full deletes agent-data.db, including session threads,
      echo          tool audit and plugin state.
      set /P "CONFIRM=Type DELETE to continue: "
      if /I not "!CONFIRM!"=="DELETE" (
        echo cancelled, agent-data.db was not deleted
        goto :done
      )
    )
    echo [4/4] deleting agent-data.db ...
    del /F /Q "%DB%" 2>nul
    del /F /Q "%DB%-wal" 2>nul
    del /F /Q "%DB%-shm" 2>nul
    echo        deleted
  )
) else (
  echo [4/4] keeping agent-data.db ^(threads, audit, permissions, plugin state^). Use /full to remove it.
)

:done
echo.
if "%DRYRUN%"=="1" (
  echo Dry run finished, nothing was modified.
) else (
  echo Done. Backup: %BACKUP%
  echo To roll back: quit the app, then copy the backup agent-data.db into %APP_DIR%
)
goto :end

:fail
exit /b 1

:end
endlocal
