; Kestrel Project Installer - Inno Setup Script
; Packages Kestrel Analyzer and Visualizer

#define MyAppName "Project Kestrel"
#define MyAppPublisher "Project Kestrel"
#define MyAppURL "https://github.com/sirspongelord/ProjectKestrel"
#define TutorialURL "https://projectkestrel.org/#tutorial"

#ifndef AppVersion
  #define AppVersion "alpha-YYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseName
  #define ReleaseName "Project Kestrel aYYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseDir
  #define ReleaseDir "..\\release"
#endif

; WebView2 runtime installation removed to reduce installer failures

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

[Files]
; Unified Project Kestrel bundle (one-dir from PyInstaller)
Source: "..\analyzer\dist\ProjectKestrel\*"; DestDir: "{app}\ProjectKestrel"; Flags: recursesubdirs createallsubdirs ignoreversion

; Documentation
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu icon (single unified app)
Name: "{group}\Project Kestrel"; Filename: "{app}\ProjectKestrel\ProjectKestrel.exe"; WorkingDir: "{app}\ProjectKestrel"; IconFilename: "{app}\ProjectKestrel\_internal\\logo.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Desktop icon
Name: "{autodesktop}\Project Kestrel"; Filename: "{app}\ProjectKestrel\ProjectKestrel.exe"; WorkingDir: "{app}\ProjectKestrel"; Tasks: desktopicon_projectkestrel; IconFilename: "{app}\ProjectKestrel\_internal\\logo.ico"

[Run]
; Open tutorial webpage after install
Filename: "{#TutorialURL}"; Description: "View online tutorial"; Flags: shellexec postinstall skipifsilent nowait

; Option to launch after install (unified)
Filename: "{app}\ProjectKestrel\ProjectKestrel.exe"; Description: "Launch Project Kestrel"; Flags: nowait postinstall skipifsilent unchecked

[Code]
// WebView2 installer integration removed to avoid forcing downloads during setup.
// No-op InitializeWizard kept for compatibility.
procedure InitializeWizard;
begin
  // Intentionally empty — installer will not download WebView2.
end;
