param(
    [string[]]$InstallationPath
)

$ErrorActionPreference = 'Stop'
# Use this PowerShell installation's module when launched from PowerShell 7/Node.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
if (-not $InstallationPath) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw 'Visual Studio C++ Build Tools and its redistributable files are required to package the compiler.'
    }
    $InstallationPath = @(& $vswhere -all -version '[17.0,19.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    if ($LASTEXITCODE -ne 0 -or -not $InstallationPath) { throw 'Visual Studio 2022/2026 C++ Build Tools was not found.' }
}
# Support numeric version directories and v143/v145 aliases, without searching
# debug_nonredist, onecore or other architectures. Both toolsets use vcruntime140.
$candidates = foreach ($installation in $InstallationPath) {
    $redist = Join-Path $installation 'VC/Redist/MSVC'
    if (-not (Test-Path -LiteralPath $redist -PathType Container)) { continue }
    foreach ($version in Get-ChildItem -LiteralPath $redist -Directory) {
        if ($version.Name -notmatch '^(?:14\.\d+\.\d+(?:\.\d+)?|v14\d)$') { continue }
        $x86 = Join-Path $version.FullName 'x86'
        if (-not (Test-Path -LiteralPath $x86 -PathType Container)) { continue }
        $folders = Get-ChildItem -LiteralPath $x86 -Directory |
            Where-Object { $_.Name -match '^Microsoft\.VC14\d\.CRT$' }
        foreach ($folder in $folders) {
            $file = Join-Path $folder.FullName 'vcruntime140.dll'
            if (Test-Path -LiteralPath $file -PathType Leaf) { Get-Item -LiteralPath $file }
        }
    }
}
$runtime = $candidates | Sort-Object {
    [version]::new(
        $_.VersionInfo.FileMajorPart, $_.VersionInfo.FileMinorPart,
        $_.VersionInfo.FileBuildPart, $_.VersionInfo.FilePrivatePart
    )
} -Descending | Select-Object -First 1
if (-not $runtime) { throw 'The x86 Visual C++ v14 redistributable runtime was not found.' }
$signature = Get-AuthenticodeSignature -LiteralPath $runtime.FullName
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
    throw 'The compiler runtime must have a valid Microsoft signature.'
}
@{
    path = $runtime.FullName
    version = $runtime.VersionInfo.FileVersion
    signer = $signature.SignerCertificate.Subject
} | ConvertTo-Json -Compress
