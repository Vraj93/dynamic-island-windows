# Makes the app's icons from the two source pictures in build/source:
#   app-icon.png  the app icon (a rounded tile on black)  -> build/icon.png (installer, exe) and assets/app-icon.png (windows)
#   tray.png      the tray icon (on transparent)          -> assets/tray.ico (every size Windows uses) and assets/tray.png
#   powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'build\source'

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); $p
}
# A superellipse |x|^n + |y|^n = 1: the smooth 'continuous' corner app icons use.
function Squircle([float]$s, [float]$n) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath; $h = $s / 2; $pts = @()
  for ($i = 0; $i -lt 360; $i++) { $a = $i * [Math]::PI / 180; $c = [Math]::Cos($a); $si = [Math]::Sin($a)
    $pts += New-Object System.Drawing.PointF ($h + $h * [Math]::Sign($c) * [Math]::Pow([Math]::Abs($c), 2 / $n)), ($h + $h * [Math]::Sign($si) * [Math]::Pow([Math]::Abs($si), 2 / $n)) }
  $p.AddPolygon($pts); $p
}
function Hq($g) { $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality' }
function Resize($img, [int]$w, [int]$h) {
  $b = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($b); Hq $g; $g.Clear([System.Drawing.Color]::Transparent)
  $ia = New-Object System.Drawing.Imaging.ImageAttributes; $ia.SetWrapMode('TileFlipXY')
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), 0, 0, $img.Width, $img.Height, 'Pixel', $ia)
  $g.Dispose(); $b
}
function SavePng($bmp, $rel) { $bmp.Save((Join-Path $root $rel), [System.Drawing.Imaging.ImageFormat]::Png) }

# ---------- app icon: find the tile on the black background, cut it out with transparent rounded corners ----------
$a = [System.Drawing.Bitmap]::FromFile((Join-Path $src 'app-icon.png'))
$lit = { param($c) ($c.R + $c.G + $c.B) -gt 24 }
$my = [int]($a.Height / 2); $mx = [int]($a.Width / 2)
$l = 0; while ($l -lt $mx -and -not (& $lit $a.GetPixel($l, $my))) { $l++ }
$r = $a.Width - 1; while ($r -gt $mx -and -not (& $lit $a.GetPixel($r, $my))) { $r-- }
$t = 0; while ($t -lt $my -and -not (& $lit $a.GetPixel($mx, $t))) { $t++ }
$bt = $a.Height - 1; while ($bt -gt $my -and -not (& $lit $a.GetPixel($mx, $bt))) { $bt-- }
$l += 6; $t += 6; $r -= 6; $bt -= 6  # trim the soft edge of the tile
$tileImg = $a.Clone((New-Object System.Drawing.Rectangle $l, $t, ($r - $l + 1), ($bt - $t + 1)), $a.PixelFormat)
$a.Dispose()
$S = 1024
$icon = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($icon); Hq $g; $g.Clear([System.Drawing.Color]::Transparent)
$scaled = Resize $tileImg $S $S
$brush = New-Object System.Drawing.TextureBrush $scaled
$g.FillPath($brush, (Squircle $S 4))
$g.Dispose(); $scaled.Dispose(); $tileImg.Dispose()
SavePng $icon 'build\icon.png'
$small = Resize $icon 256 256; SavePng $small 'assets\app-icon.png'; $small.Dispose(); $icon.Dispose()
"app icon: tile found at $l,$t size $($r - $l + 1)x$($bt - $t + 1)"

# ---------- tray icon: crop to the drawing, centre it in a square, one picture per size ----------
$tr = [System.Drawing.Bitmap]::FromFile((Join-Path $src 'tray.png'))
$x0 = $tr.Width; $y0 = $tr.Height; $x1 = 0; $y1 = 0
for ($y = 0; $y -lt $tr.Height; $y += 2) { for ($x = 0; $x -lt $tr.Width; $x += 2) {
  if ($tr.GetPixel($x, $y).A -gt 40) { if ($x -lt $x0) { $x0 = $x }; if ($x -gt $x1) { $x1 = $x }; if ($y -lt $y0) { $y0 = $y }; if ($y -gt $y1) { $y1 = $y } } } }
$cw = $x1 - $x0 + 1; $ch = $y1 - $y0 + 1
$crop = $tr.Clone((New-Object System.Drawing.Rectangle $x0, $y0, $cw, $ch), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb); $tr.Dispose()
function TrayAt([int]$s) {
  # The pill fills the full width; small sizes lose 1px of margin so it stays as large as possible.
  $w = $s; $h = [Math]::Max(1, [int][Math]::Round($s * $ch / $cw))
  $part = Resize $crop $w $h
  $b = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($b); $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImageUnscaled($part, 0, [int](($s - $h) / 2)); $g.Dispose(); $part.Dispose(); $b
}
$sizes = 16, 20, 24, 32, 40, 48, 64, 256
$pngs = foreach ($s in $sizes) { $b = TrayAt $s; $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); , $ms.ToArray() }
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $pngs[$i].Length
  $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $w.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($p in $pngs) { $w.Write($p) }
[System.IO.File]::WriteAllBytes((Join-Path $root 'assets\tray.ico'), $out.ToArray())
$t64 = TrayAt 64; SavePng $t64 'assets\tray.png'; $t64.Dispose()

# A large preview of the small sizes on a dark and a light taskbar, for checking by eye.
$prev = New-Object System.Drawing.Bitmap 420, 160
$g = [System.Drawing.Graphics]::FromImage($prev); $g.InterpolationMode = 'NearestNeighbor'
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 32, 32, 32))), 0, 0, 420, 80)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 238, 238, 238))), 0, 80, 420, 80)
foreach ($row in 0, 80) { $x = 10; foreach ($s in 16, 20, 24, 32) { $b = TrayAt $s; $g.DrawImage($b, $x, $row + 8, $s * 2, $s * 2); $x += $s * 2 + 20; $b.Dispose() } }
$g.Dispose(); $prev.Save((Join-Path $env:TEMP 'tray-preview.png')); $prev.Dispose(); $crop.Dispose()
"tray: drawing ${cw}x$ch; wrote assets\tray.ico ($((Get-Item (Join-Path $root 'assets\tray.ico')).Length) bytes)"
