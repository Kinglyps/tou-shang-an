@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo =========================================
echo  投上岸 启动中...
echo  后端面板：http://localhost:5100
echo =========================================
start "" "投上岸.exe"
timeout /t 5 >nul
