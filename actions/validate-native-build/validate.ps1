$ErrorActionPreference = 'Stop'

function Get-WorkspaceItem($RelativePath, $InputName) {
    $componentPattern = '[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_-])?'
    if ($RelativePath -cnotmatch "\A$componentPattern(/$componentPattern)*\z") {
        throw "$InputName must be a literal workspace-relative path (use forward slashes)."
    }
    $path = $env:GITHUB_WORKSPACE
    $item = $null
    foreach ($component in $RelativePath.Split('/')) {
        if ($component -match '\A(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|\z)') {
            throw "$InputName cannot use reserved Windows device names."
        }
        $path = Join-Path $path $component
        $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "$InputName cannot traverse a link or reparse point."
        }
    }
    return $item
}

$stage = Get-WorkspaceItem $env:RELEASE_ARTIFACT_DIR 'artifact-path'
if ($stage -and -not $stage.PSIsContainer) {
    throw 'artifact-path must be a directory.'
}

if ($env:VALIDATION_PHASE -ceq 'inputs') {
    $script = Get-WorkspaceItem $env:BUILD_SCRIPT 'build-script'
    if (-not $script -or $script.PSIsContainer -or $script.Extension -cne $env:SCRIPT_EXTENSION) {
        throw "build-script must be an existing $env:SCRIPT_EXTENSION file."
    }
    if ($env:RELEASE_VERSION -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}\z') {
        throw 'version must be a nonempty version string with no whitespace or path separators.'
    }
    if ($env:ARTIFACT_NAME -cnotmatch '\A[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\z') {
        throw 'artifact-name must use letters, digits, underscores, dots or hyphens, without a leading dot or hyphen.'
    }
} elseif ($env:VALIDATION_PHASE -ceq 'artifact') {
    if (-not $stage) {
        throw 'artifact-path was not created by the build.'
    }
    $link = Get-ChildItem -LiteralPath $stage.FullName -Force -Recurse -Attributes ReparsePoint | Select-Object -First 1
    if ($link) {
        throw 'artifact-path cannot contain links or reparse points.'
    }
} else {
    throw 'Unknown native build validation phase.'
}
