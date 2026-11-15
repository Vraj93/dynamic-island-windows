# Makes the Microsoft Store tile images (build/appx/*.png) from the app icon (build/icon.png).
#   powershell -ExecutionPolicy Bypass -File scripts\make-store-tiles.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$icon = [System.Drawing.Image]::FromFile((Join-Path $root 'build\icon.png'))
$out = Join-Path $root 'build\appx'
New-Item -ItemType Directory -Force $out | Out-Null
# name = width x height; the icon fills `fill` of the shorter side, centred on a transparent background.
$tiles = @(
  @('StoreLogo', 50, 50, 1.0), @('Square44x44Logo', 44, 44, 1.0), @('SmallTile', 71, 71, 0.8),
  @('Square150x150Logo', 150, 150, 0.7), @('LargeTile', 310, 310, 0.6), @('Wide310x150Logo', 310, 150, 0.7)
)
foreach ($t in $tiles) {
  $name, $w, $h, $fill = $t
  $b = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = [int]([Math]::Min($w, $h) * $fill)
  $g.DrawImage($icon, [int](($w - $s) / 2), [int](($h - $s) / 2), $s, $s)
  $g.Dispose(); $b.Save((Join-Path $out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
  "wrote $name.png ($w x $h)"
}
$icon.Dispose()
