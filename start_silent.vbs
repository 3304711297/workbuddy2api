Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\<username>\AppData\Local\hermes\codebuddy2openai"
WshShell.Run "cmd /c """"C:\Users\<username>\.workbuddy\binaries\python\envs\default\Scripts\python.exe"" converter.py --port 8787 --desensitize >> proxy_stdout.log 2>&1""", 0, False
