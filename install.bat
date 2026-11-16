@echo off
setlocal

set "EXT_DIR=%~dp0"
set "EXT_DIR=%EXT_DIR:~0,-1%"
set "LINK=%USERPROFILE%\.vscode\extensions\kanban-vsc"

echo.
echo ===================================================
echo  kanban-vsc installer
echo  Source: %EXT_DIR%
echo  Target: %LINK%
echo ===================================================
echo.

:: Dependencies
cd /d "%EXT_DIR%"
if not exist "node_modules\typescript\bin\tsc" (
    echo [0/3] Installing npm dependencies...
    call npm install
    if errorlevel 1 (
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)

:: Build
echo [1/3] Building TypeScript...
call npm run compile
if errorlevel 1 (
    echo ERROR: Build failed.
    pause
    exit /b 1
)
echo OK

:: Remove old link / folder if exists
echo [2/3] Removing old installation...
if exist "%LINK%" (
    rmdir "%LINK%" 2>nul
    if exist "%LINK%" (
        rmdir /s /q "%LINK%" 2>nul
    )
)
echo OK

:: Create junction
echo [3/3] Creating junction...
mklink /J "%LINK%" "%EXT_DIR%"
if errorlevel 1 (
    echo ERROR: Could not create junction.
    pause
    exit /b 1
)

echo.
echo ===================================================
echo  Done. Restart VS Code to activate the extension.
echo ===================================================
echo.
pause
