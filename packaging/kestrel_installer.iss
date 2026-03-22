; LingjianLite Installer - Inno Setup Script
; Packages Lingjian Analyzer and Visualizer

#define MyAppName "翎鉴 Lite"
#define MyAppPublisher "翎鉴 / Lingjian"
#define MyAppURL "https://github.com/wlfcss/ProjectKestrel-zh"
; #define TutorialURL ""

#ifndef AppVersion
  #define AppVersion "alpha-YYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseName
  #define ReleaseName "LingjianLite aYYYY.MM.DD.HH.MM"
#endif

#ifndef ReleaseDir
  #define ReleaseDir "..\\release"
#endif

; WebView2 runtime installation removed to reduce installer failures

[Setup]
AppId=org.lingjian-lite
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
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon_lingjian"; Description: "创建桌面快捷方式"; GroupDescription: "桌面快捷方式:"; Flags: checkedonce

[Files]
; LingjianLite bundle (one-dir from PyInstaller)
Source: "..\analyzer\dist\LingjianLite\*"; DestDir: "{app}\LingjianLite"; Flags: recursesubdirs createallsubdirs ignoreversion

; Documentation
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Start Menu icon (single unified app)
Name: "{group}\翎鉴 Lite"; Filename: "{app}\LingjianLite\LingjianLite.exe"; WorkingDir: "{app}\LingjianLite"; IconFilename: "{app}\LingjianLite\_internal\\logo.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"

; Desktop icon
Name: "{autodesktop}\翎鉴 Lite"; Filename: "{app}\LingjianLite\LingjianLite.exe"; WorkingDir: "{app}\LingjianLite"; Tasks: desktopicon_lingjian; IconFilename: "{app}\LingjianLite\_internal\\logo.ico"

[Run]
; Option to launch after install
Filename: "{app}\LingjianLite\LingjianLite.exe"; Description: "启动翎鉴 Lite"; Flags: nowait postinstall skipifsilent unchecked

[Code]
// WebView2 installer integration removed to avoid forcing downloads during setup.
// No-op InitializeWizard kept for compatibility.
procedure InitializeWizard;
begin
  // Intentionally empty — installer will not download WebView2.
end;
