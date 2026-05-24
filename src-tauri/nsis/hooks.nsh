; GIRTool NSIS installer hooks
; Runs BEFORE the main files are extracted so prerequisites are ready first.
;
; Checks for Microsoft ODBC Driver 17 for SQL Server.
; If missing, downloads it from Microsoft and installs it silently.

!macro NSIS_HOOK_PREINSTALL

  ; ── Check registry for ODBC Driver 17 ──────────────────────────────────────
  DetailPrint "Checking for Microsoft ODBC Driver 17 for SQL Server..."
  ReadRegStr $0 HKLM "SOFTWARE\ODBC\ODBCINST.INI\ODBC Driver 17 for SQL Server" "Driver"

  ${If} $0 != ""
    DetailPrint "ODBC Driver 17 already installed — skipping."
  ${Else}

    ; ── Download from Microsoft ───────────────────────────────────────────────
    DetailPrint "ODBC Driver 17 not found. Downloading from Microsoft..."
    SetDetailsPrint both

    nsExec::ExecToLog \
      'powershell.exe -NonInteractive -WindowStyle Hidden -Command \
        "try { \
          Invoke-WebRequest \
            -Uri \"https://go.microsoft.com/fwlink/?linkid=2187214\" \
            -OutFile \"$TEMP\msodbcsql17.msi\" \
            -UseBasicParsing; \
          exit 0 \
        } catch { exit 1 }"'
    Pop $1   ; exit code

    ${If} $1 != 0
      ; Download failed — warn the user but do not abort the install
      MessageBox MB_ICONEXCLAMATION|MB_OK \
        "Could not download the Microsoft ODBC Driver 17 for SQL Server.$\n$\n\
         GIRTool is installed but will not be able to connect to the database$\n\
         until the driver is installed manually.$\n$\n\
         Download it from:$\n\
         https://aka.ms/downloadmsodbcsql"
    ${Else}

      ; ── Install silently ────────────────────────────────────────────────────
      DetailPrint "Installing ODBC Driver 17 (this may take a moment)..."
      ExecWait \
        '"$SYSDIR\msiexec.exe" /i "$TEMP\msodbcsql17.msi" \
         /quiet /qn IACCEPTMSODBCSQLLICENSETERMS=YES' \
        $2   ; capture exit code

      Delete "$TEMP\msodbcsql17.msi"

      ${If} $2 = 0
        DetailPrint "ODBC Driver 17 installed successfully."
      ${Else}
        MessageBox MB_ICONEXCLAMATION|MB_OK \
          "The ODBC Driver 17 installer finished with code $2.$\n\
           If GIRTool cannot connect to the database, please install$\n\
           the driver manually from:$\n\
           https://aka.ms/downloadmsodbcsql"
      ${EndIf}

    ${EndIf}

  ${EndIf}

!macroend


; POSTINSTALL hook — add Windows Defender exclusion so Excel operations
; are not slowed down by real-time AV scanning (same as Inno Setup version).
!macro NSIS_HOOK_POSTINSTALL

  DetailPrint "Configuring Windows Defender exclusion..."
  nsExec::ExecToLog \
    'powershell.exe -NonInteractive -WindowStyle Hidden \
      -Command "Add-MpPreference -ExclusionPath \"$INSTDIR\""'

!macroend


; UNINSTALL hook — remove the Defender exclusion when the app is removed.
!macro NSIS_HOOK_UNINSTALL

  nsExec::ExecToLog \
    'powershell.exe -NonInteractive -WindowStyle Hidden \
      -Command "Remove-MpPreference -ExclusionPath \"$INSTDIR\""'

!macroend
