; Kestrel Project Installer - Inno Setup Script
; Packages Kestrel Analyzer and Visualizer with ImageMagick dependency

#define MyAppName "Project Kestrel"
#define MyAppPublisher "Project Kestrel"
#define MyAppURL "https://github.com/sirspongelord/ProjectKestrel"

#ifndef AppVersion
  #define AppVersion "alpha-YYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseName
  #define ReleaseName "Project Kestrel aYYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseDir
  #define ReleaseDir "..\\release"
#endif

; ImageMagick download URL (Windows x64 Q8 dynamic release)
#define ImageMagickURL "https://imagemagick.org/archive/binaries/ImageMagick-7.1.2-13-Q16-x64-dll.exe"
#define ImageMagickInstaller "ImageMagick-Setup.exe"

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
Name: "desktopicon_analyzer"; Description: "Create desktop shortcut for Kestrel Analyzer"; GroupDescription: "Desktop shortcuts:"; Flags: checkedonce
Name: "desktopicon_visualizer"; Description: "Create desktop shortcut for Kestrel Visualizer"; GroupDescription: "Desktop shortcuts:"; Flags: checkedonce
Name: "installimagemagick"; Description: "Install ImageMagick (required for RAW image support)"; GroupDescription: "Dependencies:"; Flags: checkedonce

[Files]
; Kestrel Analyzer files
Source: "{#ReleaseDir}\kestrel_analyzer.exe"; DestDir: "{app}\Analyzer"; Flags: ignoreversion

; Kestrel Visualizer files  
Source: "{#ReleaseDir}\visualizer.exe"; DestDir: "{app}\Visualizer"; Flags: ignoreversion

; Documentation
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu icons
Name: "{group}\Kestrel Analyzer"; Filename: "{app}\Analyzer\kestrel_analyzer.exe"; WorkingDir: "{app}\Analyzer"
Name: "{group}\Kestrel Visualizer"; Filename: "{app}\Visualizer\visualizer.exe"; WorkingDir: "{app}\Visualizer"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Desktop icons
Name: "{autodesktop}\Kestrel Analyzer"; Filename: "{app}\Analyzer\kestrel_analyzer.exe"; WorkingDir: "{app}\Analyzer"; Tasks: desktopicon_analyzer
Name: "{autodesktop}\Kestrel Visualizer"; Filename: "{app}\Visualizer\visualizer.exe"; WorkingDir: "{app}\Visualizer"; Tasks: desktopicon_visualizer

[Run]
; Run ImageMagick installer if task selected and installer was downloaded
Filename: "{tmp}\{#ImageMagickInstaller}"; Parameters: "/SILENT /NORESTART"; StatusMsg: "Installing ImageMagick..."; Flags: waituntilterminated; Tasks: installimagemagick; Check: ImageMagickInstallerExists

; Option to launch after install
Filename: "{app}\Analyzer\kestrel_analyzer.exe"; Description: "Launch Kestrel Analyzer"; Flags: nowait postinstall skipifsilent unchecked
Filename: "{app}\Visualizer\visualizer.exe"; Description: "Launch Kestrel Visualizer"; Flags: nowait postinstall skipifsilent unchecked

[Code]
var
  DownloadPage: TDownloadWizardPage;
  ImageMagickNeeded: Boolean;

// Check if ImageMagick is already installed
function IsImageMagickInstalled: Boolean;
var
  MagickPath: String;
begin
  Result := False;
  
  // Check registry for ImageMagick installation (64-bit)
  if RegQueryStringValue(HKLM64, 'SOFTWARE\ImageMagick\Current', 'BinPath', MagickPath) then
  begin
    Result := DirExists(MagickPath);
    if Result then
    begin
      Log('ImageMagick found in registry: ' + MagickPath);
      Exit;
    end;
  end;
  
  // Check 32-bit registry key
  if RegQueryStringValue(HKLM32, 'SOFTWARE\ImageMagick\Current', 'BinPath', MagickPath) then
  begin
    Result := DirExists(MagickPath);
    if Result then
    begin
      Log('ImageMagick found in 32-bit registry: ' + MagickPath);
      Exit;
    end;
  end;
  
  // Check common installation paths
  if DirExists(ExpandConstant('{pf}\ImageMagick-7.1.1-Q8')) then
  begin
    Result := True;
    Log('ImageMagick found at default Q8 path');
    Exit;
  end;
  
  if DirExists(ExpandConstant('{pf}\ImageMagick-7.1.1-Q16-HDRI')) then
  begin
    Result := True;
    Log('ImageMagick found at default Q16 path');
    Exit;
  end;
  
  // Check if magick.exe is in system directory
  if FileExists(ExpandConstant('{sys}\magick.exe')) then
  begin
    Result := True;
    Log('ImageMagick magick.exe found in system directory');
    Exit;
  end;
  
  Log('ImageMagick not detected on system');
end;

// Check if the downloaded installer exists
function ImageMagickInstallerExists: Boolean;
begin
  Result := FileExists(ExpandConstant('{tmp}\{#ImageMagickInstaller}'));
  if Result then
    Log('ImageMagick installer found at: ' + ExpandConstant('{tmp}\{#ImageMagickInstaller}'))
  else
    Log('ImageMagick installer not found');
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
  
  // Check if we need to download ImageMagick after user selects tasks
  if CurPageID = wpSelectTasks then
  begin
    ImageMagickNeeded := WizardIsTaskSelected('installimagemagick') and not IsImageMagickInstalled;
    
    if ImageMagickNeeded then
      Log('ImageMagick will be downloaded and installed')
    else if WizardIsTaskSelected('installimagemagick') then
      Log('ImageMagick installation selected but already installed, skipping')
    else
      Log('ImageMagick installation not selected');
  end;
  
  // Download ImageMagick before installation begins
  if CurPageID = wpReady then
  begin
    if ImageMagickNeeded then
    begin
      Log('Starting ImageMagick download...');
      DownloadPage.Clear;
      DownloadPage.Add('{#ImageMagickURL}', '{#ImageMagickInstaller}', '');
      DownloadPage.Show;
      try
        try
          DownloadPage.Download;
          Result := True;
          Log('ImageMagick download completed successfully');
        except
          if DownloadPage.AbortedByUser then
          begin
            Log('ImageMagick download aborted by user');
            Result := False;
          end
          else
          begin
            Log('ImageMagick download failed');
            // Download failed - ask user what to do
            case SuppressibleMsgBox(
              'Failed to download ImageMagick.' + #13#10 + #13#10 +
              'ImageMagick is required for Kestrel Analyzer to process RAW image files.' + #13#10 + #13#10 +
              'Click Retry to try downloading again' + #13#10 +
              'Click Ignore to continue without ImageMagick (not recommended)' + #13#10 +
              'Click Abort to cancel installation',
              mbError, MB_ABORTRETRYIGNORE, IDRETRY) of
              IDRETRY: Result := NextButtonClick(CurPageID);  // Retry download
              IDIGNORE: begin
                Result := True;  // Continue without ImageMagick
                Log('User chose to continue without ImageMagick');
              end;
              IDABORT: begin
                Result := False;  // Cancel installation
                Log('User cancelled installation due to ImageMagick download failure');
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

// Show warning if ImageMagick is not installed after setup completes
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not IsImageMagickInstalled and not ImageMagickInstallerExists then
    begin
      Log('Warning: ImageMagick not installed and installer not found');
      MsgBox(
        'Warning: ImageMagick was not installed.' + #13#10 + #13#10 +
        'Kestrel Analyzer requires ImageMagick to process RAW image files (CR2, CR3, NEF, ARW, etc.).' + #13#10 + #13#10 +
        'To install ImageMagick manually, download from:' + #13#10 +
        'https://imagemagick.org/script/download.php' + #13#10 + #13#10 +
        'Choose the "Q8" version for best compatibility.',
        mbInformation, MB_OK);
    end
    else if IsImageMagickInstalled or ImageMagickInstallerExists then
    begin
      Log('ImageMagick is installed or will be installed');
    end;
  end;
end;
