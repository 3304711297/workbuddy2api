@echo off
title WorkBuddy to OpenAI Converter
cd /d "C:\Users\<username>\AppData\Local\hermes\codebuddy2openai"
"C:\Users\<username>\.workbuddy\binaries\python\envs\default\Scripts\python.exe" converter.py --port 8787 --desensitize
pause
