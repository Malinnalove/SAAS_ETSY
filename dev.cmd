@echo off
set "PATH=D:\AAA\node;%PATH%"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "NO_PROXY="
set "NODE_OPTIONS="
cd /d D:\AAA\SaaS
D:\AAA\node\npm.cmd run dev
