$ErrorActionPreference = 'Stop'
# Use this PowerShell installation's module when launched from PowerShell 7/Node.
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'Visual Studio C++ Build Tools and its redistributable files are required to package the compiler.'
}
$installation = & $vswhere -latest -version '[17.0,18.0)' -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { throw 'Visual Studio C++ Build Tools was not found.' }
$redist = Join-Path $installation 'VC/Redist/MSVC'
$versions = Get-ChildItem -LiteralPath $redist -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+' } |
    Sort-Object { [version]$_.Name } -Descending
$runtime = $versions | ForEach-Object {
    Join-Path $_.FullName 'x86/Microsoft.VC143.CRT/vcruntime140.dll'
} | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $runtime) { throw 'The x86 Visual C++ v143 redistributable runtime was not found.' }
$signature = Get-AuthenticodeSignature -LiteralPath $runtime
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation(?:,|$)') {
    throw 'The compiler runtime must have a valid Microsoft signature.'
}
@{
    path = $runtime
    version = (Get-Item -LiteralPath $runtime).VersionInfo.FileVersion
    signer = $signature.SignerCertificate.Subject
} | ConvertTo-Json -Compress
