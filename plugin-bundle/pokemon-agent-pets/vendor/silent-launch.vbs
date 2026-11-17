Option Explicit
On Error Resume Next

' ============================================================================
' Antigravity Pokemon Suite - Zero-Console Silent Process Launcher (v4.1)
' Invoked via: wscript.exe //B //Nologo "<path>\silent-launch.vbs" <target> [args...]
' Uses WScript.Shell.Run(..., 0, False) from GUI-subsystem wscript.exe so
' Windows 10/11 NEVER opens a console window or Windows Terminal tab.
' ============================================================================

If WScript.Arguments.Count = 0 Then
    WScript.Quit 0
End If

Dim fso, sh, scriptDir, suiteRoot
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
suiteRoot = fso.GetParentFolderName(scriptDir)
If fso.FolderExists(suiteRoot) Then
    sh.CurrentDirectory = suiteRoot
End If

Function StripOuterQuotes(ByVal s)
    s = CStr(s)
    If Len(s) >= 2 Then
        If Left(s, 1) = """" And Right(s, 1) = """" Then
            s = Mid(s, 2, Len(s) - 2)
        End If
    End If
    StripOuterQuotes = s
End Function

Function QuoteArg(ByVal rawVal)
    Dim cleanVal
    cleanVal = StripOuterQuotes(rawVal)
    If Len(cleanVal) = 0 Then
        QuoteArg = """"""
    ElseIf InStr(cleanVal, " ") > 0 Or InStr(cleanVal, vbTab) > 0 Or InStr(cleanVal, """") > 0 Then
        QuoteArg = """" & Replace(cleanVal, """", "\""") & """"
    Else
        QuoteArg = cleanVal
    End If
End Function

Function ResolveRealNodeExe()
    Dim userProfile, nvmdDefaultFile, ts, ver, cand, versDir, subFolder, bestVer, bestPath, pfNode
    userProfile = sh.ExpandEnvironmentStrings("%USERPROFILE%")
    nvmdDefaultFile = userProfile & "\.nvmd\default"
    If fso.FileExists(nvmdDefaultFile) Then
        Set ts = fso.OpenTextFile(nvmdDefaultFile, 1, False)
        If Not ts.AtEndOfStream Then
            ver = Trim(Replace(Replace(ts.ReadAll(), vbCr, ""), vbLf, ""))
            ts.Close
            If Len(ver) > 0 Then
                cand = userProfile & "\.nvmd\versions\" & ver & "\node.exe"
                If fso.FileExists(cand) Then
                    ResolveRealNodeExe = cand
                    Exit Function
                End If
            End If
        Else
            ts.Close
        End If
    End If

    versDir = userProfile & "\.nvmd\versions"
    If fso.FolderExists(versDir) Then
        bestVer = ""
        bestPath = ""
        For Each subFolder In fso.GetFolder(versDir).SubFolders
            cand = subFolder.Path & "\node.exe"
            If fso.FileExists(cand) Then
                If StrComp(subFolder.Name, bestVer, 1) > 0 Then
                    bestVer = subFolder.Name
                    bestPath = cand
                End If
            End If
        Next
        If Len(bestPath) > 0 Then
            ResolveRealNodeExe = bestPath
            Exit Function
        End If
    End If

    pfNode = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
    If fso.FileExists(pfNode) Then
        ResolveRealNodeExe = pfNode
        Exit Function
    End If

    ResolveRealNodeExe = "node.exe"
End Function

Dim firstArg, lowerFirst, ext, cmdLine, i
firstArg = StripOuterQuotes(WScript.Arguments(0))
lowerFirst = LCase(firstArg)
ext = LCase(fso.GetExtensionName(firstArg))

If ext = "ps1" Then
    cmdLine = "powershell.exe -STA -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & QuoteArg(firstArg)
ElseIf ext = "mjs" Or ext = "js" Then
    cmdLine = QuoteArg(ResolveRealNodeExe()) & " " & QuoteArg(firstArg)
ElseIf lowerFirst = "node" Or lowerFirst = "node.exe" Or InStr(lowerFirst, "\.nvmd\bin\node") > 0 Then
    cmdLine = QuoteArg(ResolveRealNodeExe())
Else
    cmdLine = QuoteArg(firstArg)
End If

For i = 1 To WScript.Arguments.Count - 1
    cmdLine = cmdLine & " " & QuoteArg(WScript.Arguments(i))
Next

sh.Run cmdLine, 0, False
WScript.Quit 0
