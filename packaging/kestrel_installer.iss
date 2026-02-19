; Kestrel Project Installer - Inno Setup Script
; Packages Kestrel Analyzer and Visualizer

#define MyAppName "Project Kestrel"
#define MyAppPublisher "Project Kestrel"
#define MyAppURL "https://github.com/sirspongelord/ProjectKestrel"
#define TutorialURL "https://projectkestrel.org/tutorial"

#ifndef AppVersion
  #define AppVersion "alpha-YYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseName
  #define ReleaseName "Project Kestrel aYYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseDir
  #define ReleaseDir "..\\release"
#endif

; WebView2 runtime (Evergreen bootstrapper)
#define WebView2URL "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
#define WebView2Installer "MicrosoftEdgeWebView2Setup.exe"

[Setup]
AppId=org.ProjectKestrel
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
OutputDir=..\dist\installer
OutputBaseFilename={#ReleaseName}-{#AppVersion}-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
DisableProgramGroupPage=yes
WizardImageFile=..\assets\logo.png
WizardSmallImageFile=..\assets\logo.png

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon_projectkestrel"; Description: "Create desktop shortcut for Project Kestrel"; GroupDescription: "Desktop shortcuts:"; Flags: checkedonce
Name: "installwebview2"; Description: "Install Microsoft Edge WebView2 Runtime (required for Visualizer)"; GroupDescription: "Dependencies:"; Flags: checkedonce

[Files]
; Unified Project Kestrel bundle (one-dir from PyInstaller)
Source: "..\analyzer\dist\ProjectKestrel\*"; DestDir: "{app}\ProjectKestrel"; Flags: recursesubdirs createallsubdirs ignoreversion

; Documentation
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu icon (single unified app)
Name: "{group}\Project Kestrel"; Filename: "{app}\ProjectKestrel\ProjectKestrel.exe"; WorkingDir: "{app}\ProjectKestrel"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Desktop icon
Name: "{autodesktop}\Project Kestrel"; Filename: "{app}\ProjectKestrel\ProjectKestrel.exe"; WorkingDir: "{app}\ProjectKestrel"; Tasks: desktopicon_projectkestrel

[Run]
; Run WebView2 Runtime installer if task selected and installer was downloaded
Filename: "{tmp}\{#WebView2Installer}"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 Runtime..."; Flags: waituntilterminated; Tasks: installwebview2; Check: WebView2InstallerExists

; Open tutorial webpage after install
Filename: "{#TutorialURL}"; Description: "View online tutorial"; Flags: shellexec postinstall skipifsilent nowait

; Option to launch after install (unified)
Filename: "{app}\ProjectKestrel\ProjectKestrel.exe"; Description: "Launch Project Kestrel"; Flags: nowait postinstall skipifsilent unchecked

[Code]
var
  DownloadPage: TDownloadWizardPage;
  WebView2Needed: Boolean;

// Check if WebView2 runtime is already installed
function IsWebView2Installed: Boolean;
var
  BaseDir: String;
  SearchRec: TFindRec;
begin
  Result := False;

  BaseDir := ExpandConstant('{pf86}\Microsoft\EdgeWebView\Application');
  if DirExists(BaseDir) then
  begin
    if FindFirst(BaseDir + '\\*\\msedgewebview2.exe', SearchRec) then
    begin
      Result := True;
      FindClose(SearchRec);
      Log('WebView2 runtime found at: ' + BaseDir);
      Exit;
    end;
  end;

  BaseDir := ExpandConstant('{pf}\Microsoft\EdgeWebView\Application');
  if DirExists(BaseDir) then
  begin
    if FindFirst(BaseDir + '\\*\\msedgewebview2.exe', SearchRec) then
    begin
      Result := True;
      FindClose(SearchRec);
      Log('WebView2 runtime found at: ' + BaseDir);
      Exit;
    end;
  end;

  Log('WebView2 runtime not detected on system');
end;

// Check if the downloaded WebView2 installer exists
function WebView2InstallerExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{tmp}\{#WebView2Installer}'));
  if Result then
    Log('WebView2 installer found at: ' + ExpandConstant('{tmp}\{#WebView2Installer}'))
  else
    Log('WebView2 installer not found');
end;

// Download progress callback
function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  if Progress = ProgressMax then
    Log(Format('Successfully downloaded: %s (%d bytes)', [FileName, ProgressMax]));
  Result := True;
end;

procedure InitializeWizard;
begin
  // Create the download page
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), @OnDownloadProgress);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  
  // Check if we need to download WebView2 after user selects tasks
  if CurPageID = wpSelectTasks then
  begin
    WebView2Needed := WizardIsTaskSelected('installwebview2') and not IsWebView2Installed;

    if WebView2Needed then
      Log('WebView2 runtime will be downloaded and installed')
    else if WizardIsTaskSelected('installwebview2') then
      Log('WebView2 installation selected but already installed, skipping')
    else
      Log('WebView2 installation not selected');
  end;
  
  // Download WebView2 before installation begins
  if CurPageID = wpReady then
  begin
    if WebView2Needed then
    begin
      Log('Starting dependency download...');
      DownloadPage.Clear;
      DownloadPage.Add('{#WebView2URL}', '{#WebView2Installer}', '');
      DownloadPage.Show;
      try
        try
          DownloadPage.Download;
          Result := True;
          Log('Dependency download completed successfully');
        except
          if DownloadPage.AbortedByUser then
          begin
            Log('Dependency download aborted by user');
            Result := False;
          end
          else
          begin
            Log('Dependency download failed');
            // Download failed - ask user what to do
            case SuppressibleMsgBox(
              'Failed to download WebView2 Runtime.' + #13#10 + #13#10 +
              'WebView2 is required for Kestrel Visualizer rendering.' + #13#10 + #13#10 +
              'Click Retry to try downloading again' + #13#10 +
              'Click Ignore to continue without WebView2 (Visualizer will not work)' + #13#10 +
              'Click Abort to cancel installation',
              mbError, MB_ABORTRETRYIGNORE, IDRETRY) of
              IDRETRY: Result := NextButtonClick(CurPageID);  // Retry download
              IDIGNORE: begin
                Result := True;  // Continue without WebView2
                Log('User chose to continue without WebView2');
              end;
              IDABORT: begin
                Result := False;  // Cancel installation
                Log('User cancelled installation due to dependency download failure');
              end;
            end;
          end;
        end;
      finally
        DownloadPage.Hide;
      end;
    end;
  end;
end;

// Show warning if WebView2 is not installed after setup completes
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not IsWebView2Installed and not WebView2InstallerExists then
    begin
      Log('Warning: WebView2 runtime not installed and installer not found');
      MsgBox(
        'Warning: WebView2 Runtime was not installed.' + #13#10 + #13#10 +
        'Kestrel Visualizer requires Microsoft Edge WebView2 Runtime.' + #13#10 + #13#10 +
        'To install manually, download from:' + #13#10 +
        'https://developer.microsoft.com/microsoft-edge/webview2/' + #13#10,
        mbInformation, MB_OK);
    end
    else if IsWebView2Installed or WebView2InstallerExists then
    begin
      Log('WebView2 is installed or will be installed');
    end;
  end;
end;
