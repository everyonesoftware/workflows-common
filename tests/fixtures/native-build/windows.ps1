$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if ((git rev-parse HEAD) -cne $env:GITHUB_SHA -or (git rev-parse --is-shallow-repository) -cne 'false') {
    throw 'Expected the full caller checkout at GITHUB_SHA.'
}
if (-not ((dotnet --list-sdks) -match '^10\.0\.')) {
    throw 'Expected .NET SDK 10.'
}
$null = New-Item -ItemType Directory -Path $env:RELEASE_ARTIFACT_DIR -Force
Set-Content -LiteralPath (Join-Path $env:RELEASE_ARTIFACT_DIR 'build.txt') -NoNewline -Value "windows $env:RELEASE_VERSION $env:GITHUB_SHA`n"
