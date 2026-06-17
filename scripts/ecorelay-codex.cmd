@echo off
REM EcoRelay Codex launcher — starts app-server hidden, launches codex --remote.
REM Usage: ecorelay-codex.cmd [codex args...]

setlocal

set "BUN=%USERPROFILE%\.bun\bin\bun.exe"
set "LAUNCHER=%~dp0ecorelay-codex-launch.ts"

if not exist "%BUN%" (
    echo ERROR: Bun not found at %BUN%
    echo Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"
    exit /b 1
)

if not exist "%LAUNCHER%" (
    echo ERROR: Launcher script not found at %LAUNCHER%
    exit /b 1
)

"%BUN%" run "%LAUNCHER%" %*
