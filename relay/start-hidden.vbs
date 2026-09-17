' Starts relay/server.mjs without a console window. Run at logon by the task
' that autostart-windows.ps1 registers. Paths resolve from this file's location.

Option Explicit

Dim fso, shell, relayDir, projectRoot, port, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

relayDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(relayDir)

port = "8788"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)

shell.CurrentDirectory = projectRoot
command = "node """ & relayDir & "\server.mjs"" " & port

' 0 = hidden window, False = do not wait for it to exit
shell.Run command, 0, False
