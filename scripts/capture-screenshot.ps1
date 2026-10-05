# 用无头 Edge 给 DSH Web GUI 截图
# 用法: .\scripts\capture-screenshot.ps1 -Url "http://127.0.0.1:3080" -Out "assets/usage-panel.png"
param(
  [string]$Url = 'http://127.0.0.1:3080',
  [string]$Out = 'assets/usage-panel.png',
  [int]$Width = 1600,
  [int]$Height = 1000
)

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { Write-Error "找不到 Edge: $edge"; exit 1 }

$full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
$dir = [System.IO.Path]::GetDirectoryName($full)
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
if (Test-Path $full) { Remove-Item $full -Force }

# --headless=new + --screenshot 是 Chromium 的内置截图能力，无需 Playwright。
# 用独立 user-data-dir 避免污染用户真实的浏览器配置。
$profileDir = Join-Path $env:TEMP ("dsh-shot-" + [guid]::NewGuid().ToString('N'))
& $edge --headless=new --disable-gpu --hide-scrollbars --no-first-run `
  --user-data-dir="$profileDir" `
  --window-size="$Width,$Height" `
  --screenshot="$full" `
  "$Url" 2>&1 | Out-Null

Start-Sleep -Milliseconds 500
Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path $full) {
  $info = Get-Item $full
  Write-Output "OK: $full ($($info.Length) bytes)"
} else {
  Write-Error "截图失败，未生成文件"
  exit 1
}
