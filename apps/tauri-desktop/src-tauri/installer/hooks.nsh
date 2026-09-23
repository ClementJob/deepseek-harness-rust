; Tauri NSIS installer hooks (tauri.conf.json bundle > windows > nsis > installerHooks).
;
; The retired Electron Desktop installed per-user under
; `%LOCALAPPDATA%\Programs\DeepSeek Harness` (electron-builder convention). Before
; this installer copies its files, PREINSTALL silently runs that installation's own
; Uninstall.exe when it is still present; a failure (for example the old
; application still running) is logged and never blocks the new installation.
; The old uninstaller preserves the Harness home by its own contract.

Var DshMigrationDirectory
Var DshMigrationUninstaller
Var DshMigrationExitCode
Var DshMigrationLogFile

; Append one timestamped line to the persistent migration log under the install dir.
; Call with the message in $R7; preserves every register it uses.
!macro DshMigrationLog Message
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  DetailPrint "${Message}"
  CreateDirectory "$INSTDIR\installer-logs"
  StrCpy $DshMigrationLogFile "$INSTDIR\installer-logs\migrate-electron.log"
  ; GetTime yields zero-padded day, month, year, weekday, hour, minute, second.
  ${GetTime} "" "L" $R0 $R1 $R2 $R3 $R4 $R5 $R6
  ClearErrors
  FileOpen $R7 "$DshMigrationLogFile" a
  ${If} ${Errors}
    SetErrors
  ${Else}
    FileSeek $R7 END
    FileWrite $R7 "$R2-$R1-$R0 $R4:$R5:$R6  ${Message}$\r$\n"
    FileClose $R7
  ${EndIf}
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; Runs before file copy, registry writes, and shortcuts: the old installation's
; own uninstaller removes its files and per-user registry entry synchronously
; (`_?=` keeps ExecWait synchronous), and leftovers are cleared best-effort.
!macro NSIS_HOOK_PREINSTALL
  StrCpy $DshMigrationDirectory "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
  StrCpy $DshMigrationUninstaller "$DshMigrationDirectory\Uninstall.exe"
  ${If} ${FileExists} "$DshMigrationUninstaller"
    Push $R0
    ExecWait '"$DshMigrationUninstaller" /S _?=$DshMigrationDirectory' $R0
    StrCpy $DshMigrationExitCode $R0
    Pop $R0
    ${If} $DshMigrationExitCode == 0
      ; `_?=` leaves the uninstaller executable in place; clear the residue quietly.
      Delete "$DshMigrationUninstaller"
      RMDir "$DshMigrationDirectory"
      !insertmacro DshMigrationLog "migrated from Electron Desktop: uninstall completed (exit 0)"
    ${Else}
      !insertmacro DshMigrationLog "migrated from Electron Desktop: uninstall exited $DshMigrationExitCode; continuing"
    ${EndIf}
  ${EndIf}
!macroend
