!macro customInit
  IfFileExists "$INSTDIR\NewHermes.Studio.exe" 0 hermesStudioStopDone
    DetailPrint "Stopping NewHermes Studio..."
    nsExec::ExecToLog '"$INSTDIR\NewHermes.Studio.exe" --quit'
    Sleep 5000
    nsExec::ExecToLog 'taskkill.exe /IM "NewHermes.Studio.exe" /T /F'
  hermesStudioStopDone:
!macroend
