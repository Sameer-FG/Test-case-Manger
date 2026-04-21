@echo off
:: ─── Change to the folder where this .bat lives ───────────────────────────
cd /d "%~dp0"
title Test Case Manager Server

:: ─── Self-elevate to Administrator ────────────────────────────────────────
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting Administrator privileges...
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

color 0A
cls
echo.
echo  ==========================================
echo    Test Case Manager — Team Server
echo  ==========================================
echo.

:: ─── Check Node.js ────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    color 0C
    echo  ERROR: Node.js is not installed!
    echo.
    echo  Please install it from: https://nodejs.org
    echo  (Download the LTS version, then run this file again)
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo  Node.js %NODE_VER% found.

:: ─── Install dependencies if missing ──────────────────────────────────────
if not exist "node_modules" (
    echo.
    echo  Installing dependencies (one-time setup)...
    call npm install
    if errorlevel 1 (
        echo.
        echo  ERROR: npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
)

:: ─── Open firewall port 3000 (silently — needs admin rights) ──────────────
netsh advfirewall firewall show rule name="TCM Port 3000" >nul 2>&1
if errorlevel 1 (
    echo.
    echo  Opening Windows Firewall for port 3000...
    netsh advfirewall firewall add rule ^
        name="TCM Port 3000" ^
        protocol=TCP ^
        dir=in ^
        localport=3000 ^
        action=allow ^
        enable=yes >nul 2>&1
    if errorlevel 1 (
        echo  WARNING: Could not add firewall rule automatically.
        echo  Team members may not be able to connect.
        echo  Manually allow port 3000 in Windows Defender Firewall.
    ) else (
        echo  Firewall rule added successfully — port 3000 is open.
    )
) else (
    echo  Firewall rule already exists for port 3000.
)

:: ─── Get local IP ──────────────────────────────────────────────────────────
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "169.254"') do (
    set RAW=%%a
    goto :gotip
)
:gotip
:: Strip leading space
set IP=%RAW: =%

echo.
echo  ==========================================
echo   LOCAL:   http://localhost:3000
echo   NETWORK: http://%IP%:3000
echo  ==========================================
echo.
echo  Share the NETWORK link with your team!
echo  (They must be on the same Wi-Fi / network)
echo.
echo  Press Ctrl+C to stop the server.
echo.

:: ─── Start server ─────────────────────────────────────────────────────────
node server.js

pause
