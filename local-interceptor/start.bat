@echo off
chcp 65001 >nul
title MT 本地攔截器

echo.
echo ====================================
echo   MT 本地攔截器 - 啟動中
echo ====================================
echo.

:: 確認 .env 存在
if not exist ".env" (
  echo [警告] 找不到 .env 檔案！
  echo 請先複製 .env.example 為 .env 並填入設定
  echo.
  copy .env.example .env
  echo 已自動建立 .env，請先編輯填入正確設定後再執行
  pause
  start notepad .env
  exit /b 1
)

:: 確認 node_modules 存在
if not exist "node_modules" (
  echo [安裝] 第一次執行，安裝相依套件...
  npm install
  if errorlevel 1 (
    echo [錯誤] npm install 失敗，請確認已安裝 Node.js
    pause
    exit /b 1
  )
)

echo [啟動] 開啟 MT 平台並開始攔截資料...
echo.
node index.js

echo.
echo 攔截器已停止。按任意鍵關閉...
pause >nul
