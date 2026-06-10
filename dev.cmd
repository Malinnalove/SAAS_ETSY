@echo off
set "PATH=D:\AAA\node;%PATH%"
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"
set "NO_PROXY=localhost,127.0.0.1"
set "NODE_OPTIONS=--use-env-proxy"
cd /d D:\AAA\SaaS
D:\AAA\node\npm.cmd run dev
