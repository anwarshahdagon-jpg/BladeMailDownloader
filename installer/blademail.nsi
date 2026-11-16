; BladeMail Download Manager installer (per-user, no admin rights needed)
; Installing over the old "FluxGet" removes FluxGet's program files, shortcuts and auto-start entry.
; Downloads, the download list, settings and history are kept (the app moves %APPDATA%\FluxGet to %APPDATA%\BladeMail).
Unicode true
SetCompressor /SOLID lzma

!define APPNAME "BladeMail Download Manager"
!define SHORTNAME "BladeMail"
!define EXE "BladeMail.exe"
!ifndef VERSION
  !define VERSION "1.5.0"
!endif
!ifndef SRCDIR
  !define SRCDIR "..\dist\BladeMail-win32-x64"
!endif
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SHORTNAME}"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APPNAME}"
OutFile "..\dist\BladeMail-Download-Manager-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${SHORTNAME}"
InstallDirRegKey HKCU "Software\${SHORTNAME}" "InstallDir"
RequestExecutionLevel user
BrandingText "${APPNAME} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "${APPNAME}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "..\app\assets\icon.ico"
!define MUI_UNICON "..\app\assets\icon.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Install ${APPNAME}"
!define MUI_WELCOMEPAGE_TEXT "${APPNAME} is a fast download manager: it splits each file over many connections, pauses and resumes, and starts with Windows.$\r$\n$\r$\nThis will install it for your user account (no administrator rights needed) and include the browser extension for Chrome, Edge, Brave, Opera, Vivaldi and Firefox.$\r$\n$\r$\nIf FluxGet (the old name) is installed, it is replaced. Your downloads, download list and settings are kept."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "${APPNAME} is installed"
!define MUI_FINISHPAGE_TEXT "${SHORTNAME} will start automatically when you sign in to Windows.$\r$\n$\r$\nLast step: add the ${SHORTNAME} extension to your browsers. Browsers only allow extensions from outside their store to be added by you, so ${SHORTNAME} opens a short guide with one button per browser."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_PARAMETERS "--setup-extensions"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${SHORTNAME} and set up browser extensions"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; close running copies (new and old name) so files can be replaced and the data folder can be moved
  nsExec::Exec 'taskkill /IM ${EXE} /F'
  nsExec::Exec 'taskkill /IM FluxGet.exe /F'
  Sleep 1000
FunctionEnd

Function RemoveOldFluxGet
  ; the app used to be called FluxGet: remove its program files, shortcuts and registry entries
  ReadRegStr $0 HKCU "Software\FluxGet" "InstallDir"
  ${If} $0 == ""
    StrCpy $0 "$LOCALAPPDATA\Programs\FluxGet"
  ${EndIf}
  ${If} ${FileExists} "$0\FluxGet.exe"
    RMDir /r "$0"
  ${EndIf}
  DeleteRegValue HKCU "${RUNKEY}" "FluxGet"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FluxGet"
  DeleteRegKey HKCU "Software\FluxGet"
  Delete "$DESKTOP\FluxGet.lnk"
  RMDir /r "$SMPROGRAMS\FluxGet"
FunctionEnd

Section "${APPNAME}" SecMain
  Call RemoveOldFluxGet
  SetOutPath "$INSTDIR"
  File /r "${SRCDIR}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall ${SHORTNAME}.exe"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Set up browser extensions.lnk" "$INSTDIR\${EXE}" "--setup-extensions"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${SHORTNAME}.lnk" "$INSTDIR\Uninstall ${SHORTNAME}.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}"

  ; start with Windows (the app keeps this up to date from its Settings)
  WriteRegStr HKCU "${RUNKEY}" "${SHORTNAME}" '"$INSTDIR\${EXE}" --hidden'

  WriteRegStr HKCU "Software\${SHORTNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${SHORTNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall ${SHORTNAME}.exe"'
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM ${EXE} /F'
  Sleep 800
  DeleteRegValue HKCU "${RUNKEY}" "${SHORTNAME}"
  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "Software\${SHORTNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"
  ; your downloads and the download list in %APPDATA%\BladeMail are kept
SectionEnd
