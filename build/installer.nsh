; Extra steps for the Windows installer (electron-builder NSIS).

; Uninstalling: take the island's hooks out of every AI agent's settings (Claude Code, Copilot, Gemini, Cursor,
; Codex), so those agents carry on exactly as before. Skipped when this uninstall is part of an update, because
; the new version keeps using the same hooks.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --disconnect-agents'
    Pop $0
  ${endIf}
!macroend
