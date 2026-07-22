; One-time Electron -> Tauri installer bridge.
;
; electron-builder and Tauri use different NSIS identities even though the
; product name is the same. Detect the old electron-builder uninstaller by
; its executable name instead of relying on a single generated registry GUID.

Function CS2_AbortMigrationInstall
  IfSilent cs2_abort_silent cs2_abort_interactive
  cs2_abort_interactive:
    MessageBox MB_ICONSTOP|MB_OK "$R7"
  cs2_abort_silent:
    SetErrorLevel 2
    Abort
FunctionEnd

Function CS2_EnsureElectronStopped
  ; installerHooks are included before Tauri registers its additional plugin
  ; directory, so use the stock NSIS nsExec plugin and Windows tasklist here.
  ; /FO CSV keeps the full image name intact and makes the exact lookup stable.
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq CS2 Insight Agent.exe" /FO CSV /NH'
  Pop $R0
  Pop $R1
  ${StrCase} $R2 $R1 "L"
  ${StrLoc} $R3 $R2 '"cs2 insight agent.exe"' ">"
  ${If} $R3 != ""
    StrCpy $R7 "检测到旧版 CS2 Insight Agent (Electron) 正在运行。$\r$\n$\r$\n为避免配置或数据库损坏，请先正常关闭旧版应用，再重新运行安装程序。"
    Call CS2_AbortMigrationInstall
  ${EndIf}

  ; Check the existing Tauri build before uninstalling Electron. The generated
  ; installer checks it again later, but that would be after this preinstall
  ; hook has already changed the old installation.
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq cs2-insight-agent-desktop.exe" /FO CSV /NH'
  Pop $R0
  Pop $R1
  ${StrCase} $R2 $R1 "L"
  ${StrLoc} $R3 $R2 '"cs2-insight-agent-desktop.exe"' ">"
  ${If} $R3 != ""
    StrCpy $R7 "检测到 CS2 Insight Agent (Tauri) 正在运行。$\r$\n$\r$\n请先正常关闭应用，再重新运行安装程序。旧版 Electron 尚未被卸载。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
FunctionEnd

Function CS2_RunElectronUninstaller
  ; Inputs: $R8 = uninstall command, $R9 = registry key for verification.
  IfSilent cs2_uninstall_no_notice cs2_uninstall_notice
  cs2_uninstall_notice:
    MessageBox MB_ICONINFORMATION|MB_OK "检测到旧版 Electron 安装。安装程序将先安全卸载旧程序；用户配置、Demo 数据库、日志和备份不会被删除。"
  cs2_uninstall_no_notice:

  ClearErrors
  ExecWait '$R8 /S' $R0
  ${If} ${Errors}
    StrCpy $R7 "无法启动旧版 Electron 卸载程序。安装已中止，旧程序和用户数据均未删除。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
  ${If} $R0 != 0
    StrCpy $R7 "旧版 Electron 卸载没有成功完成（退出码 $R0）。安装已中止，避免留下两套互相冲突的程序。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
FunctionEnd

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

    StrCpy $R9 "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5"
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

    StrCpy $R9 "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R5"
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
    StrCpy $R4 0
    Goto cs2_hklm_loop
  cs2_hklm_done:
FunctionEnd

Function CS2_RemoveLegacyElectron
  Call CS2_EnsureElectronStopped

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
  Call CS2_RemoveLegacyElectron
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Run the same idempotent migration used by the desktop startup before the
  ; finish page can launch Tauri. A failure leaves every legacy source intact.
  ClearErrors
  ExecWait '"$INSTDIR\python\python.exe" -I "$INSTDIR\backend\app\desktop_data_migration.py" --appdata "$APPDATA"' $R0
  ${If} ${Errors}
    StrCpy $R7 "Tauri 已安装，但无法启动用户数据迁移程序。旧数据仍然保留；安装已停止，请查看 %APPDATA%\CS2 Insight Agent\desktop-data-migration-error.log。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
  ${If} $R0 != 0
    StrCpy $R7 "用户数据迁移校验失败（退出码 $R0）。旧数据仍然保留，应用不会以空配置启动。请查看 %APPDATA%\CS2 Insight Agent\desktop-data-migration-error.log。"
    Call CS2_AbortMigrationInstall
  ${EndIf}
!macroend
