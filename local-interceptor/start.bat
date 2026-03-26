@echo off
title MT Interceptor

if not exist ".env" (
  copy .env.example .env
  echo [!] .env not found - created from .env.example
  echo [!] Please edit .env and fill in your settings, then run again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [*] Installing dependencies...
  npm install
)

echo [*] Starting MT interceptor...
node index.js

pause
