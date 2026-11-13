param([string]$Action, [string]$Target)
$ErrorActionPreference = 'Stop'
switch ($Action) {
  'claim' {
    try { New-Item -ItemType Directory -Path $Target -ErrorAction Stop | Out-Null; Write-Output 'created' }
    catch { if (Test-Path -LiteralPath $Target -PathType Container) { Write-Output 'exists' } else { exit 1 } }
  }
  'release' { [System.IO.Directory]::Delete($Target) }
  'upload' {
    $igImage = [System.IO.Path]::GetTempFileName()
    try {
      [System.IO.File]::WriteAllBytes($igImage, [Convert]::FromBase64String([Console]::In.ReadToEnd()))
      & creght upload --site_id=$Target --file=$igImage --name=instagram.jpg --mimetype=image/jpeg --json
      if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally { Remove-Item -LiteralPath $igImage -Force -ErrorAction SilentlyContinue }
  }
  default { exit 2 }
}
