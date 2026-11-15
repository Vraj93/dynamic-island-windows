# Renders the Microsoft Store screenshots (1920x1080) from the demo screens: docs/store/screenshots/*.png
#   powershell -ExecutionPolicy Bypass -File scripts\store-screenshots.ps1
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'docs\store\screenshots'
New-Item -ItemType Directory -Force $out | Out-Null
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
$ui = ([Uri](Join-Path $root 'ui\index.html')).AbsoluteUri
$settings = ([Uri](Join-Path $root 'ui\settings.html')).AbsoluteUri
$shots = [ordered]@{
  '1-sheet' = "$ui#demo=sheet"; '2-player' = "$ui#demo=lyrics"; '3-calendar' = "$ui#demo=calendar"; '4-agent' = "$ui#demo=agentlive"
  '5-music-and-agent' = "$ui#demo=sheetagent"; '6-call' = "$ui#demo=callmuted"; '7-convert' = "$ui#demo=convert"; '8-settings' = "$settings#sec=general"
}
$ErrorActionPreference = 'Continue'
foreach ($n in $shots.Keys) {
  $prof = Join-Path $env:TEMP ("store-shot-" + [guid]::NewGuid())
  & $edge --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 '--window-size=1920,1080' "--user-data-dir=$prof" --virtual-time-budget=5000 "--screenshot=$(Join-Path $out "$n.png")" $shots[$n] 2>$null | Out-Null
  Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
  "captured $n"
}
