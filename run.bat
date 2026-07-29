@echo off
REM Daily headless run wrapper for Windows Task Scheduler.
REM Login must already be saved once via: npm run login
REM Register a daily task (edit the path):
REM   schtasks /Create /TN "gsc-index-bot" /TR "C:\path\to\gsc-index-bot\run.bat" /SC DAILY /ST 09:00
cd /d "%~dp0"
if not exist output mkdir output
node gsc-index-bot.mjs --limit=10 >> output\daily.log 2>&1
