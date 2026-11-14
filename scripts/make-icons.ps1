# Draws the tray icon (assets/tray.ico) at every size Windows uses, so it's crisp at 100%-200% scaling:
# a blue-to-violet rounded tile with a black island and a green "live" dot, matching build/icon.png.
#   powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent

function RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [Math]::Min($r * 2, [Math]::Min($w, $h))
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); $p
}

function Draw([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $pad = [Math]::Max(0.5, $s * 0.03)
  $tile = RoundRect $pad $pad ($s - 2 * $pad) ($s - 2 * $pad) ($s * 0.24)
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF $s, $s),
    [System.Drawing.Color]::FromArgb(255, 64, 132, 255), [System.Drawing.Color]::FromArgb(255, 104, 52, 210))
  $g.FillPath($grad, $tile)
  # The island: a wide black pill across the middle, slightly above centre.
  $pw = $s * 0.72; $ph = [Math]::Max(4, $s * 0.26)
  $px = ($s - $pw) / 2; $py = $s * 0.40 - $ph / 2
  $g.FillPath([System.Drawing.Brushes]::Black, (RoundRect $px $py $pw $ph ($ph / 2)))
  # Green "live" dot on the right end of the island (skipped at the tiniest size, where it would blur).
  if ($s -ge 20) {
    $dot = $ph * 0.46
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 52, 214, 96))), ($px + $pw - $ph / 2 - $dot / 2), ($py + ($ph - $dot) / 2), $dot, $dot)
  }
  $g.Dispose(); $bmp
}

# .ico with one PNG image per size
$sizes = 16, 20, 24, 32, 40, 48, 64, 256
$pngs = foreach ($s in $sizes) { $b = Draw $s; $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); , $ms.ToArray() }
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

# A large preview of the small sizes, for checking by eye.
$prev = New-Object System.Drawing.Bitmap 400, 80
$g = [System.Drawing.Graphics]::FromImage($prev); $g.Clear([System.Drawing.Color]::FromArgb(255, 32, 32, 32)); $g.InterpolationMode = 'NearestNeighbor'
$x = 10; foreach ($s in 16, 20, 24, 32) { $b = Draw $s; $g.DrawImage($b, $x, 10, $s * 2, $s * 2); $x += $s * 2 + 20; $b.Dispose() }
$g.Dispose(); $prev.Save((Join-Path $env:TEMP 'tray-preview.png')); $prev.Dispose()
"wrote assets\tray.ico ($((Get-Item (Join-Path $root 'assets\tray.ico')).Length) bytes)"
