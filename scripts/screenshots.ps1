# Captures the README screenshots: every island screen (ui/demo.js scenes) and the Settings window,
# rendered by Microsoft Edge in headless mode at 2x for sharp images. Output: docs/images/*.png
#   powershell -ExecutionPolicy Bypass -File scripts\screenshots.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'docs\images'
New-Item -ItemType Directory -Force $out | Out-Null
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found.' }
$ui = ([Uri](Join-Path $root 'ui\index.html')).AbsoluteUri
$settings = ([Uri](Join-Path $root 'ui\settings.html')).AbsoluteUri

# scene = window height (CSS px) that fits the island plus some wallpaper below it
$scenes = [ordered]@{
  sheet = 500; player = 330; compact = 110; agent = 110; approval = 330; finished = 400; timer = 280; timesup = 120;
  volume = 110; focus = 330; reminders = 430; alarm = 400; drop = 290; shelf = 320; convert = 380; clipboard = 330
}
function Shot($url, $file, $w, $h) {
  $profile = Join-Path $env:TEMP "island-shots-$([guid]::NewGuid())"
  # Edge prints harmless warnings on stderr; don't let them stop the script.
  $ErrorActionPreference = 'Continue'
  & $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=$w,$h `
    "--user-data-dir=$profile" --virtual-time-budget=3000 "--screenshot=$file" $url 2>$null | Out-Null
  $ErrorActionPreference = 'Stop'
  Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($s in $scenes.Keys) {
  Shot "$ui#demo=$s" (Join-Path $out "$s.png") 860 $scenes[$s]
  Write-Host "captured $s"
}
foreach ($sec in 'general', 'agents') {
  Shot "$settings#sec=$sec" (Join-Path $out "settings-$sec.png") 980 620
  Write-Host "captured settings-$sec"
}
