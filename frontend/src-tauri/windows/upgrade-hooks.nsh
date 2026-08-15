; Electron -> Tauri installer bridge + self-upgrade hardening.
;
; Design goals (every path must also work fully silent, e.g. when the Tauri
; updater or electron-updater runs this installer with /S):
;   * User data under %APPDATA% is never touched by anything in this file.
;   * A legacy Electron install in a DIFFERENT directory is only uninstalled
;     after the new files and the user-data migration are verified
;     (postinstall), keeping a runnable fallback until that point.
;   * A legacy Electron install in the SAME directory must be uninstalled
;     BEFORE files are copied: electron-builder's uninstaller deletes the
;     whole install directory and would otherwise wipe the freshly installed
;     Tauri files.
;   * A still-running Tauri shell is usually just finishing its graceful
;     backend shutdown; wait for it instead of aborting, and only force-kill
;     (including the Python backend child tree) as a last resort.

; tauri-build copies the GNU WebView2 loader beside the release executable,
; but tauri-bundler 2.6 does not add that sibling DLL to NSIS automatically.
; Capture this directory while the hook is included so macro expansion later
; does not change __FILEDIR__ to the generated NSIS directory.
!define CS2_TAURI_RELEASE_DIR "${__FILEDIR__}\..\target\release"

Var CS2ElectronScope     ; "samedir" (preinstall) or "all" (postinstall)
Var CS2ElectronDir       ; lowercased install dir of the legacy entry, no trailing backslash
Var CS2ElectronUninsExe  ; parsed legacy uninstaller executable path
Var CS2ElectronMode      ; "/currentuser" for HKCU or "/allusers" for HKLM

Function CS2_AbortMigrationInstall
  IfSilent cs2_abort_silent cs2_abort_interactive
  cs2_abort_interactive:
    MessageBox MB_ICONSTOP|MB_OK "$R7"
  cs2_abort_silent:
    SetErrorLevel 2
    Abort
FunctionEnd

; In: $R9 = image name. Out: $R0 = 1 running / 0 not running.
; installerHooks are included before Tauri registers its additional plugin
; directory, so use the stock NSIS nsExec plugin and Windows tasklist here.
; /FO CSV keeps the full image name intact and makes the exact lookup stable.
Function CS2_IsProcessRunning
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq $R9" /FO CSV /NH'
  Pop $R0
  Pop $R1
  ${StrCase} $R2 $R1 "L"
  ${StrCase} $R3 $R9 "L"
  ${StrLoc} $R4 $R2 '"$R3"' ">"
  ${If} $R4 != ""
    StrCpy $R0 1
  ${Else}
    StrCpy $R0 0
  ${EndIf}
FunctionEnd

; In: $R9 = image name, $R8 = max iterations (500ms each).
; Out: $R0 = 1 still running / 0 gone.
Function CS2_WaitProcessGone
  StrCpy $R5 0
  cs2_wait_proc_loop:
    Call CS2_IsProcessRunning
    ${If} $R0 = 0
      Return
    ${EndIf}
    IntOp $R5 $R5 + 1
    ${If} $R5 >= $R8
      Return
    ${EndIf}
    Sleep 500
    Goto cs2_wait_proc_loop
FunctionEnd

Function CS2_PrepareRunningApps
  ; The Tauri shell closes its window instantly but the process can keep
  ; running for several seconds while the Python backend shuts down. Wait for
  ; that instead of aborting; force-kill the whole child tree only if it never
  ; exits (e.g. a hung backend).
  StrCpy $R9 "cs2-insight-agent-desktop.exe"
  Call CS2_IsProcessRunning
  ${If} $R0 = 1
    DetailPrint "等待正在退出的 CS2 Insight Agent 进程结束…"
    StrCpy $R8 50
    Call CS2_WaitProcessGone
    ${If} $R0 = 1
      DetailPrint "强制结束仍在运行的 CS2 Insight Agent…"
      nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /IM "cs2-insight-agent-desktop.exe" /F /T'
      Pop $R0
      Pop $R1
      Sleep 1500
      StrCpy $R9 "cs2-insight-agent-desktop.exe"
      Call CS2_IsProcessRunning
      ${If} $R0 = 1
        StrCpy $R7 "无法结束仍在运行的 CS2 Insight Agent。$\r$\n$\r$\n请手动关闭应用（必要时在任务管理器结束进程），再重新运行安装程序。"
        Call CS2_AbortMigrationInstall
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; A backend orphaned by an earlier force-kill keeps port 19871 busy and
  ; would make the freshly installed app fail its startup identity check.
  ; Only python.exe listeners on that port are terminated.
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 19871 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $$proc = Get-Process -Id $$_.OwningProcess -ErrorAction SilentlyContinue; if ($$proc -and $$proc.ProcessName -eq 'python') { Stop-Process -Id $$proc.Id -Force } }"`
  Pop $R0
  Pop $R1

  ; Legacy Electron build: give it time to finish exiting (electron-updater
  ; launches this installer right after quitting the app), but never
  ; force-kill it — it may still be flushing config or the SQLite database.
  StrCpy $R9 "CS2 Insight Agent.exe"
  Call CS2_IsProcessRunning
  ${If} $R0 = 1
    DetailPrint "等待旧版 CS2 Insight Agent (Electron) 退出…"
    StrCpy $R8 40
    Call CS2_WaitProcessGone
    ${If} $R0 = 1
      StrCpy $R7 "检测到旧版 CS2 Insight Agent (Electron) 正在运行。$\r$\n$\r$\n为避免配置或数据库损坏，请先正常关闭旧版应用，再重新运行安装程序。"
      Call CS2_AbortMigrationInstall
    ${EndIf}
  ${EndIf}
FunctionEnd

; Tauri's in-place installer overwrites files but does not remove package
; directories that disappeared from a newer bundled Python runtime. Remove
; the parser package and every historical dist-info directory before file
; copy so importlib.metadata can never resolve a stale local version.
Function CS2_RemoveBundledDemoparser
  Push $0
  Push $1

  RMDir /r "$INSTDIR\python\Lib\site-packages\demoparser2"
  FindFirst $0 $1 "$INSTDIR\python\Lib\site-packages\demoparser2-*.dist-info"
  cs2_remove_demoparser_metadata_loop:
    StrCmp $1 "" cs2_remove_demoparser_metadata_done
    RMDir /r "$INSTDIR\python\Lib\site-packages\$1"
    ClearErrors
    FindNext $0 $1
    IfErrors cs2_remove_demoparser_metadata_done
    Goto cs2_remove_demoparser_metadata_loop
  cs2_remove_demoparser_metadata_done:
    FindClose $0

  Pop $1
  Pop $0
FunctionEnd

; Older desktop runtimes bundled httptools, while the current lean runtime
; uses h11. Tauri's in-place installer does not remove packages that disappear
; from a newer bundle, so an incomplete stale httptools directory can make
; Uvicorn auto-select a parser whose native extension no longer exists.
Function CS2_RemoveStaleHttpTools
  Push $0
  Push $1

  RMDir /r "$INSTDIR\python\Lib\site-packages\httptools"
  FindFirst $0 $1 "$INSTDIR\python\Lib\site-packages\httptools-*.dist-info"
  cs2_remove_httptools_metadata_loop:
    StrCmp $1 "" cs2_remove_httptools_metadata_done
    RMDir /r "$INSTDIR\python\Lib\site-packages\$1"
    ClearErrors
    FindNext $0 $1
    IfErrors cs2_remove_httptools_metadata_done
    Goto cs2_remove_httptools_metadata_loop
  cs2_remove_httptools_metadata_done:
    FindClose $0

  Pop $1
  Pop $0
FunctionEnd

; In: $R0 = raw InstallLocation, $R8 = raw UninstallString.
; Out: $CS2ElectronDir, $CS2ElectronUninsExe.
Function CS2_ResolveElectronDir
  Push $0
  Push $1

  ; Parsed uninstaller path: strip surrounding quotes and trailing arguments.
  StrCpy $0 $R8
  StrCpy $1 $0 1
  ${If} $1 == '"'
    StrCpy $0 $0 "" 1
    ${StrLoc} $1 $0 '"' ">"
    ${If} $1 != ""
      StrCpy $0 $0 $1
    ${EndIf}
  ${EndIf}
  StrCpy $CS2ElectronUninsExe $0

  ; Prefer the registered InstallLocation, else the uninstaller's directory.
  StrCpy $1 $R0
  StrCpy $0 $1 1
  ${If} $0 == '"'
    StrCpy $1 $1 "" 1
  ${EndIf}
  StrCpy $0 $1 1 -1
  ${If} $0 == '"'
    StrCpy $1 $1 -1
  ${EndIf}
  ${If} $1 == ""
    ${GetParent} $CS2ElectronUninsExe $1
  ${EndIf}
  StrCpy $0 $1 1 -1
  ${If} $0 == "\"
    StrCpy $1 $1 -1
  ${EndIf}
  ${StrCase} $CS2ElectronDir $1 "L"

  Pop $1
  Pop $0
FunctionEnd

; Out: $R0 = 1 when the legacy entry lives in the directory being installed to.
Function CS2_ElectronDirMatchesInstDir
  Push $0
  Push $1
  StrCpy $1 $INSTDIR
  StrCpy $0 $1 1 -1
  ${If} $0 == "\"
    StrCpy $1 $1 -1
  ${EndIf}
  ${StrCase} $1 $1 "L"
  StrCpy $R0 0
  ${If} $CS2ElectronDir != ""
  ${AndIf} $CS2ElectronDir == $1
    StrCpy $R0 1
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function CS2_RunElectronUninstaller
  ; Inputs: $CS2ElectronUninsExe, $CS2ElectronDir, $CS2ElectronMode.
  ;
  ; Use the same execution strategy as electron-builder's own
  ; uninstallOldVersion helper. A plain ExecWait on the registered
  ; UninstallString only waits for the NSIS launcher; the launcher can copy
  ; itself to %TEMP% and return while the real uninstall is still deleting the
  ; large bundled runtime. Copying it out first and passing _?= makes this
  ; process perform the real uninstall, so ExecWait covers registry and
  ; directory cleanup too. _?= must be the final argument and must not quote
  ; the directory, even when it contains spaces.
  ;
  ; --updated and /KEEP_APP_DATA preserve the Electron profile for migration,
  ; including builds configured to delete app data on a normal uninstall.
  DetailPrint "正在静默卸载旧版 CS2 Insight Agent (Electron)…"
  Delete "$PLUGINSDIR\cs2-electron-uninstaller.exe"
  ClearErrors
  CopyFiles /SILENT "$CS2ElectronUninsExe" "$PLUGINSDIR\cs2-electron-uninstaller.exe"
  ${If} ${Errors}
    StrCpy $R7 "无法准备旧版 Electron 卸载程序。安装已中止，旧程序和用户数据均未删除。"
    Call CS2_AbortMigrationInstall
  ${EndIf}

  ClearErrors
  ExecWait '"$PLUGINSDIR\cs2-electron-uninstaller.exe" /S /KEEP_APP_DATA $CS2ElectronMode --updated _?=$CS2ElectronDir' $R0
  ${If} ${Errors}
    ; Match electron-builder's group-policy fallback: if Windows blocks an
    ; executable copied to the temp directory, run the original in place.
    ClearErrors
    ExecWait '"$CS2ElectronUninsExe" /S /KEEP_APP_DATA $CS2ElectronMode --updated _?=$CS2ElectronDir' $R0
  ${EndIf}
  ${If} ${Errors}
    StrCpy $R7 "无法启动旧版 Electron 卸载程序。安装已中止，旧程序和用户数据均未删除。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
  ${If} $R0 != 0
    StrCpy $R7 "旧版 Electron 卸载没有成功完成（退出码 $R0）。安装已中止，避免留下两套互相冲突的程序。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
FunctionEnd

; The silent NSIS uninstaller copies itself to %TEMP% and returns before the
; real work finishes. After the registry entry disappears, also wait for the
; uninstaller executable (and with it the directory deletion) to settle so a
; same-directory install cannot race the file copy.
Function CS2_WaitElectronUninsGone
  Push $0
  StrCpy $0 0
  cs2_unins_gone_loop:
    IfFileExists "$CS2ElectronUninsExe" 0 cs2_unins_gone_done
    IntOp $0 $0 + 1
    ${If} $0 < 30
      Sleep 500
      Goto cs2_unins_gone_loop
    ${EndIf}
  cs2_unins_gone_done:
    Sleep 500
    Pop $0
FunctionEnd

; electron-builder and Tauri use different NSIS identities even though the
; product name is the same. Detect the old electron-builder uninstaller by
; its executable name instead of relying on a single generated registry GUID.
Function CS2_RemoveElectronHKCU
  StrCpy $R4 0
  cs2_hkcu_loop:
    EnumRegKey $R5 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R4
    StrCmp $R5 "" cs2_hkcu_done
    IntOp $R4 $R4 + 1

    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "DisplayName"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R2 $R1 "cs2 insight agent" ">"
    StrCmp $R2 0 0 cs2_hkcu_loop

    ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "UninstallString"
    ${StrCase} $R1 $R8 "L"
    ${StrLoc} $R2 $R1 "uninstall cs2 insight agent.exe" ">"
    StrCmp $R2 "" cs2_hkcu_loop

    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "InstallLocation"
    Call CS2_ResolveElectronDir
    ${If} $CS2ElectronScope == "samedir"
      Call CS2_ElectronDirMatchesInstDir
      StrCmp $R0 1 0 cs2_hkcu_loop
    ${EndIf}

    StrCpy $R9 "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5"
    StrCpy $CS2ElectronMode "/currentuser"
    Call CS2_RunElectronUninstaller
    StrCpy $R6 0
    cs2_hkcu_wait_removed:
    ReadRegStr $R3 HKCU "$R9" "UninstallString"
    ${If} $R3 == ""
      Goto cs2_hkcu_removed
    ${EndIf}
    IntOp $R6 $R6 + 1
    ${If} $R6 < 30
      Sleep 500
      Goto cs2_hkcu_wait_removed
    ${EndIf}
    StrCpy $R7 "旧版 Electron 卸载程序返回成功，但等待 15 秒后卸载注册项仍然存在。安装已中止，请勿继续并排安装。"
    Call CS2_AbortMigrationInstall
    cs2_hkcu_removed:
    Call CS2_WaitElectronUninsGone
    StrCpy $R4 0
    Goto cs2_hkcu_loop
  cs2_hkcu_done:
FunctionEnd

Function CS2_RemoveElectronHKLM
  StrCpy $R4 0
  cs2_hklm_loop:
    EnumRegKey $R5 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R4
    StrCmp $R5 "" cs2_hklm_done
    IntOp $R4 $R4 + 1

    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "DisplayName"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R2 $R1 "cs2 insight agent" ">"
    StrCmp $R2 0 0 cs2_hklm_loop

    ReadRegStr $R8 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "UninstallString"
    ${StrCase} $R1 $R8 "L"
    ${StrLoc} $R2 $R1 "uninstall cs2 insight agent.exe" ">"
    StrCmp $R2 "" cs2_hklm_loop

    ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5" "InstallLocation"
    Call CS2_ResolveElectronDir
    ${If} $CS2ElectronScope == "samedir"
      Call CS2_ElectronDirMatchesInstDir
      StrCmp $R0 1 0 cs2_hklm_loop
    ${EndIf}

    StrCpy $R9 "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5"
    StrCpy $CS2ElectronMode "/allusers"
    Call CS2_RunElectronUninstaller
    StrCpy $R6 0
    cs2_hklm_wait_removed:
    ReadRegStr $R3 HKLM "$R9" "UninstallString"
    ${If} $R3 == ""
      Goto cs2_hklm_removed
    ${EndIf}
    IntOp $R6 $R6 + 1
    ${If} $R6 < 30
      Sleep 500
      Goto cs2_hklm_wait_removed
    ${EndIf}
    StrCpy $R7 "旧版 Electron 卸载程序返回成功，但等待 15 秒后系统级卸载注册项仍然存在。安装已中止，请勿继续并排安装。"
    Call CS2_AbortMigrationInstall
    cs2_hklm_removed:
    Call CS2_WaitElectronUninsGone
    StrCpy $R4 0
    Goto cs2_hklm_loop
  cs2_hklm_done:
FunctionEnd

Function CS2_RemoveLegacyElectron
  ${If} ${RunningX64}
    SetRegView 64
    Call CS2_RemoveElectronHKCU
    Call CS2_RemoveElectronHKLM
    SetRegView 32
    Call CS2_RemoveElectronHKCU
    Call CS2_RemoveElectronHKLM
  ${Else}
    SetRegView 32
    Call CS2_RemoveElectronHKCU
    Call CS2_RemoveElectronHKLM
  ${EndIf}

  ; Restore the registry view selected by the generated Tauri installer.
  !insertmacro SetContext
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call CS2_PrepareRunningApps

  ; Same-directory Electron installs must be retired before any file copy —
  ; their uninstaller would delete $INSTDIR together with the new files.
  ; Different-directory installs stay untouched until NSIS_HOOK_POSTINSTALL.
  ; Do not hold $INSTDIR as the working directory while it may be deleted.
  SetOutPath $PLUGINSDIR
  StrCpy $CS2ElectronScope "samedir"
  Call CS2_RemoveLegacyElectron
  SetOutPath $INSTDIR

  ; Delete every previous patched-parser generation before NSIS copies the
  ; newly staged runtime. This also makes same-version repair installs clean.
  Call CS2_RemoveBundledDemoparser
  Call CS2_RemoveStaleHttpTools

  ; GNU builds import WebView2Loader.dll dynamically. Keep it beside the main
  ; executable so Windows can resolve the dependency before Rust/Tauri starts.
  !if /FileExists "${CS2_TAURI_RELEASE_DIR}\WebView2Loader.dll"
    File /a "/oname=WebView2Loader.dll" "${CS2_TAURI_RELEASE_DIR}\WebView2Loader.dll"
  !endif
!macroend

!macro NSIS_HOOK_POSTINSTALL
  RMDir /r "$INSTDIR\python\Lib\site-packages\pyarrow"
  RMDir /r "$INSTDIR\python\Lib\site-packages\pyarrow.libs"
  RMDir /r "$INSTDIR\python\Lib\site-packages\pyarrow-25.0.0.dist-info"

  ; Validate the exact installed runtime before the finish page can launch
  ; Tauri. This catches stale metadata, a missing extension, or an incomplete
  ; file copy at install time instead of surfacing as a backend startup dialog.
  ; nsExec captures the console process instead of letting Windows create a
  ; terminal window over the installer for this short-lived validation.
  nsExec::ExecToStack '"$INSTDIR\python\python.exe" -I "$INSTDIR\backend\app\demoparser_runtime.py"'
  Pop $R0
  Pop $R1
  ${If} $R0 == "error"
    StrCpy $R7 "Tauri 已安装，但无法执行内置 Rust Demo 解析器校验。安装已停止，请重新运行完整安装包。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
  ${If} $R0 != 0
    StrCpy $R7 "内置 Rust Demo 解析器版本校验失败（退出码 $R0）。安装已停止，请重新下载完整安装包。"
    Call CS2_AbortMigrationInstall
  ${EndIf}

  ; Run the same idempotent migration used by the desktop startup before the
  ; finish page can launch Tauri. A failure leaves every legacy source intact.
  ; Keep the migration synchronous and exit-code checked, but run it behind
  ; nsExec so the bundled console Python never flashes a terminal window.
  nsExec::ExecToStack '"$INSTDIR\python\python.exe" -I "$INSTDIR\backend\app\desktop_data_migration.py" --appdata "$APPDATA" --require-desktop-stopped --require-electron-ui-export'
  Pop $R0
  Pop $R1
  ${If} $R0 == "error"
    StrCpy $R7 "Tauri 已安装，但无法启动用户数据迁移程序。旧数据仍然保留；安装已停止，请查看 %APPDATA%\CS2 Insight Agent\desktop-data-migration-error.log。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
  ${If} $R0 != 0
    StrCpy $R7 "用户数据迁移校验失败（退出码 $R0）。旧数据仍然保留，应用不会以空配置启动。请查看 %APPDATA%\CS2 Insight Agent\desktop-data-migration-error.log。"
    Call CS2_AbortMigrationInstall
  ${EndIf}

  ; Only retire remaining (different-directory) Electron installs after the
  ; new installation and migration are known-good. Any earlier installer
  ; failure therefore leaves a runnable Electron fallback in place.
  StrCpy $CS2ElectronScope "all"
  Call CS2_RemoveLegacyElectron
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\WebView2Loader.dll"
  ; The generated uninstaller tries to remove $INSTDIR before this custom
  ; file is deleted. Retry non-recursively once the loader is gone.
  RmDir "$INSTDIR"
!macroend
