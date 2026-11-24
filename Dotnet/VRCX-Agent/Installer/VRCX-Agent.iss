; Inno Setup 6 installer script for VRCX.Agent (Windows Companion for VRCX-Worker)
; Built per-user (zero UAC elevation) into %LocalAppData%\Programs\VRCX.Agent
; with default-enabled background auto-start (HKCU Run) and clean upgrade/uninstall.

#ifndef AppVersion
  #define AppVersion "1.10.5"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\..\build\VRCX-Agent"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\..\build\Installer"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "VRCX.Agent-Setup-win-x64"
#endif
#ifndef IconPath
  #define IconPath "..\..\..\images\VRCX.ico"
#endif

[Setup]
AppId={{7F4D9C2E-6A38-4D91-9B14-6E2A11C9D8B0}
AppName=VRCX.Agent
AppVersion={#AppVersion}
AppVerName=VRCX.Agent {#AppVersion}
AppPublisher=nuomew (VRCX-Worker)
AppPublisherURL=https://github.com/nuomew/VRCX-Worker
AppSupportURL=https://github.com/nuomew/VRCX-Worker/issues
AppUpdatesURL=https://github.com/nuomew/VRCX-Worker/releases
DefaultDirName={autopf}\VRCX.Agent
DefaultGroupName=VRCX.Agent
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
SetupIconFile={#IconPath}
UninstallDisplayIcon={app}\VRCX.Agent.exe
UninstallDisplayName=VRCX.Agent
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=auto
CloseApplications=force

[Languages]
#ifdef ChineseIslPath
Name: "chinesesimplified"; MessagesFile: "{#ChineseIslPath}"
#endif
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
#ifdef ChineseIslPath
chinesesimplified.AutoStartTask=开机自动在后台启动 VRCX 云端伴侣（驻留系统托盘，推荐）
chinesesimplified.DesktopIconTask=创建桌面快捷方式
chinesesimplified.AdditionalTasks=附加选项：
chinesesimplified.LaunchAfterInstall=安装完成后立即启动 VRCX 云端伴侣
chinesesimplified.UninstallShortcut=卸载 VRCX 云端伴侣
#endif
english.AutoStartTask=Start VRCX Cloud Agent automatically in background with Windows (Recommended)
english.DesktopIconTask=Create a desktop shortcut
english.AdditionalTasks=Additional options:
english.LaunchAfterInstall=Launch VRCX Cloud Agent now
english.UninstallShortcut=Uninstall VRCX Cloud Agent

[Tasks]
Name: "autostart"; Description: "{cm:AutoStartTask}"; GroupDescription: "{cm:AdditionalTasks}"; Flags: checkedonce
Name: "desktopicon"; Description: "{cm:DesktopIconTask}"; GroupDescription: "{cm:AdditionalTasks}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\VRCX.Agent"; Filename: "{app}\VRCX.Agent.exe"; IconFilename: "{app}\VRCX.ico"
Name: "{group}\{cm:UninstallShortcut}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\VRCX.Agent"; Filename: "{app}\VRCX.Agent.exe"; IconFilename: "{app}\VRCX.ico"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "VRCX.Agent"; ValueData: """{app}\VRCX.Agent.exe"" --autostart"; Tasks: autostart; Flags: uninsdeletevalue

[Run]
Filename: "{app}\VRCX.Agent.exe"; Description: "{cm:LaunchAfterInstall}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\VRCX.Agent.exe"; Parameters: "--autostart"; Flags: nowait skipifnotsilent

[Code]
procedure StopRunningAgent();
var
  ResultCode: Integer;
begin
  { Tray-only WinForms apps have no top-level window for WM_CLOSE; stop cleanly before overwriting or uninstalling. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM VRCX.Agent.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Sleep(400);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningAgent();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningAgent();
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    { Always remove auto-start Run entry even if it was toggled on later from the tray menu. }
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', 'VRCX.Agent');
  end;
end;
