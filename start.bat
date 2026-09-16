@echo off
REM ============================================================
REM  PFXT - Anonymous Judge Scoring System
REM  NOTE: this file must keep CRLF line endings.
REM        All text here is ASCII on purpose - the Chinese output
REM        comes from Node, which handles UTF-8 correctly once
REM        the console codepage is set to 65001 below.
REM ============================================================
chcp 65001 >nul
title PFXT - Judge Scoring System
cd /d "%~dp0"

echo.
echo  ============================================
echo    PFXT  -  Anonymous Judge Scoring System
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist "node_modules" goto install_deps
goto run

:install_deps
echo  First run detected: installing dependencies, please wait...
echo.
call npm install
if errorlevel 1 goto install_failed
echo.

:run
echo  Starting server...
echo.
node src/server.js
echo.
echo  Server stopped.
pause
exit /b 0

:no_node
echo  [ERROR] Node.js was not found on PATH.
echo          Please install Node.js 20 or newer: https://nodejs.org/
echo.
pause
exit /b 1

:install_failed
echo.
echo  [ERROR] Dependency installation failed.
echo          If the better-sqlite3 install script was blocked by npm, run:
echo              npm approve-scripts --allow-scripts-pending
echo          then start this file again.
echo.
pause
exit /b 1
