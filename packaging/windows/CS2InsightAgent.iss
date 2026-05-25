#define MyAppName "CS2 Insight Agent"
#define MyAppPublisher "CS2 Insight Agent"
#define MyAppURL "https://github.com/DrEAmSs59/CS2-insight-agent"
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

[Setup]
AppId={{A8C9E0F1-2B3D-4E5F-6A7B-8C9D0E1F2A3B}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={localappdata}\CS2InsightAgent
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=CS2InsightAgent-{#MyAppVersion}-Setup
SetupIconFile=app-icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
OutputDir=..\..\dist
SourceDir=..\..\dist\staging

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "downloadffmpeg"; Description: "Download FFmpeg 8.1.1 (essentials, GPL) after install"; Flags: unchecked

[Dirs]
Name: "{app}\data"; Flags: uninsneveruninstall

[Files]
Source: "*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; WorkingDir must be install root: some shells resolve -File relative to Start-in; script lives in {app}, not {app}\backend.
Name: "{autoprograms}\{#MyAppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Normal -ExecutionPolicy Bypass -File ""{app}\Launch-CS2Insight.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\app-icon.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Normal -ExecutionPolicy Bypass -File ""{app}\Launch-CS2Insight.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\app-icon.ico"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Normal -ExecutionPolicy Bypass -File ""{app}\scripts\install-optional-ffmpeg.ps1"" -AppRoot ""{app}"""; StatusMsg: "Installing FFmpeg..."; Tasks: downloadffmpeg; Flags: runasoriginaluser waituntilterminated

[Code]
function IsDirWritable(Dir: String): Boolean;
var
  TempFile: String;
begin
  { WizardDirValue may not exist yet on first install; SaveStringToFile needs the path. }
  Result := False;
  if Dir = '' then Exit;
  if not DirExists(Dir) then
    if not ForceDirectories(Dir) then Exit;
  TempFile := AddBackslash(Dir) + '.__cs2insight_write_test.tmp';
  Result := SaveStringToFile(TempFile, 'ok', False);
  if Result then
    DeleteFile(TempFile);
end;

function IsBadProgramFiles(Dir: String): Boolean;
begin
  Result := (Pos(LowerCase(ExpandConstant('{pf}')), LowerCase(Dir)) = 1) or
            (Pos(LowerCase(ExpandConstant('{pf32}')), LowerCase(Dir)) = 1);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    if IsBadProgramFiles(WizardDirValue) then
    begin
      MsgBox('Installing under Program Files is not supported (folder is not writable for config and database).' + #13#10 +
             'Please choose a folder under your user profile, e.g. %LocalAppData%\CS2InsightAgent.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if not IsDirWritable(WizardDirValue) then
    begin
      MsgBox('This folder does not appear writable. Pick another install location.' + #13#10 + #13#10 +
             'Tips: use a folder under your user profile (e.g. %LocalAppData%\CS2InsightAgent); avoid Program Files; if the path is correct, check antivirus or Windows Controlled Folder Access.',
             mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  Res: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    DataDir := ExpandConstant('{app}\data');
    if DirExists(DataDir) then
    begin
      Res := MsgBox('Also delete local data under data\ (config + SQLite demo library)?' + #13#10 +
                    'Choose No to keep your database and settings.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
      if Res = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
