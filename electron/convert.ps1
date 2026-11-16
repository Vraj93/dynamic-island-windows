# File converter for Dynamic Isle. Uses only what ships with Windows:
#   images: Windows Imaging (WIC) through WPF  -> jpg, png, bmp, tiff, gif   (reads heic if the HEIF extension is installed)
#   audio / video: Windows Media Foundation transcoder -> mp3, m4a, wav, mp4
# Prints one JSON line at the end: {"ok":true,"out":...} or {"ok":false,"error":...}
param(
    [Parameter(Mandatory)] [ValidateSet('image', 'media')] [string]$Mode,
    [Parameter(Mandatory)] [string]$In,
    [Parameter(Mandatory)] [string]$Out,
    [Parameter(Mandatory)] [string]$Format,
    [int]$Quality = 90,
    [int]$MaxSide = 0,      # shrink so the longer side is at most this many pixels (0 = keep the size)
    [int]$Bitrate = 0       # video: target bits per second (0 = the profile's own); used by Compress
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Done($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); exit 0 }

try {
    if ($Mode -eq 'image') {
        Add-Type -AssemblyName PresentationCore, WindowsBase
        $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create([Uri]$In,
            [System.Windows.Media.Imaging.BitmapCreateOptions]::None, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
        $frame = $decoder.Frames[0]
        $long = [Math]::Max($frame.PixelWidth, $frame.PixelHeight)
        if ($MaxSide -gt 0 -and $long -gt $MaxSide) {
            $k = $MaxSide / $long
            $frame = New-Object System.Windows.Media.Imaging.TransformedBitmap $frame, (New-Object System.Windows.Media.ScaleTransform $k, $k)
        }
        switch ($Format) {
            'jpg' {
                $enc = New-Object System.Windows.Media.Imaging.JpegBitmapEncoder
                $enc.QualityLevel = [Math]::Max(10, [Math]::Min(100, $Quality))
                # JPEG has no transparency: flatten onto white so transparent areas don't turn black.
                if ($frame.Format.BitsPerPixel -eq 32 -or $frame.Format.ToString() -match 'A') {
                    $visual = New-Object System.Windows.Media.DrawingVisual
                    $dc = $visual.RenderOpen()
                    $rect = New-Object System.Windows.Rect 0, 0, $frame.PixelWidth, $frame.PixelHeight
                    $dc.DrawRectangle([System.Windows.Media.Brushes]::White, $null, $rect)
                    $dc.DrawImage($frame, $rect); $dc.Close()
                    $rtb = New-Object System.Windows.Media.Imaging.RenderTargetBitmap $frame.PixelWidth, $frame.PixelHeight, 96, 96, ([System.Windows.Media.PixelFormats]::Pbgra32)
                    $rtb.Render($visual)
                    $frame = $rtb
                }
            }
            'png' { $enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder }
            'bmp' { $enc = New-Object System.Windows.Media.Imaging.BmpBitmapEncoder }
            'tiff' { $enc = New-Object System.Windows.Media.Imaging.TiffBitmapEncoder }
            'gif' { $enc = New-Object System.Windows.Media.Imaging.GifBitmapEncoder }
            default { throw "Can't make $Format images." }
        }
        $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($frame))
        $fs = [System.IO.File]::Create($Out)
        try { $enc.Save($fs) } finally { $fs.Close() }
        Done @{ ok = $true; out = $Out }
    }

    # ---- audio / video through Media Foundation ----
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Media.Transcoding.MediaTranscoder, Windows.Media.Transcoding, ContentType = WindowsRuntime]
    $null = [Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]
    $ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $asTaskOp = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
    $asTaskProg = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1' } | Select-Object -First 1
    function Await($op, [Type]$t) { $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }

    $src = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($In)) ([Windows.Storage.StorageFile])
    $folder = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([System.IO.Path]::GetDirectoryName($Out))) ([Windows.Storage.StorageFolder])
    $dst = Await ($folder.CreateFileAsync([System.IO.Path]::GetFileName($Out), [Windows.Storage.CreationCollisionOption]::GenerateUniqueName)) ([Windows.Storage.StorageFile])

    $P = [Windows.Media.MediaProperties.MediaEncodingProfile]
    $profile = switch ($Format) {
        'mp3' { $P::CreateMp3([Windows.Media.MediaProperties.AudioEncodingQuality]::High) }
        'm4a' { $P::CreateM4a([Windows.Media.MediaProperties.AudioEncodingQuality]::High) }
        'wav' { $P::CreateWav([Windows.Media.MediaProperties.AudioEncodingQuality]::High) }
        'mp4' { $P::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD1080p) }
        default { throw "Can't make $Format files." }
    }
    if ($Bitrate -gt 0 -and $profile.Video) {
        # Compress: keep the shape of the original, cap its size, lower the bitrate.
        $srcProf = Await ([Windows.Media.MediaProperties.MediaEncodingProfile]::CreateFromFileAsync($src)) ([Windows.Media.MediaProperties.MediaEncodingProfile])
        $w = [int]$srcProf.Video.Width; $h = [int]$srcProf.Video.Height
        if ($w -gt 0 -and $h -gt 0) {
            $long = [Math]::Max($w, $h)
            if ($MaxSide -gt 0 -and $long -gt $MaxSide) { $k = $MaxSide / $long; $w = [int]($w * $k); $h = [int]($h * $k) }
            $profile.Video.Width = [uint32]($w - $w % 2); $profile.Video.Height = [uint32]($h - $h % 2)
            if ($srcProf.Video.FrameRate.Numerator -gt 0) { $profile.Video.FrameRate.Numerator = $srcProf.Video.FrameRate.Numerator; $profile.Video.FrameRate.Denominator = $srcProf.Video.FrameRate.Denominator }
        }
        # never aim above two-thirds of what the original already uses, or a small video would not shrink
        if ($srcProf.Video.Bitrate -gt 0) { $Bitrate = [Math]::Min($Bitrate, [int]($srcProf.Video.Bitrate * 0.65)) }
        $profile.Video.Bitrate = [uint32]$Bitrate
        if ($profile.Audio) { $profile.Audio.Bitrate = [uint32]128000 }
    }
    $tc = New-Object Windows.Media.Transcoding.MediaTranscoder
    $prep = Await ($tc.PrepareFileTranscodeAsync($src, $dst, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
    if (-not $prep.CanTranscode) {
        try { $null = $dst.DeleteAsync() } catch { }
        throw "Windows can't convert this file ($($prep.FailureReason))."
    }
    $task = $asTaskProg.MakeGenericMethod([double]).Invoke($null, @($prep.TranscodeAsync()))
    while (-not $task.Wait(1000)) { [Console]::Out.WriteLine('{"working":true}') }
    if ($task.IsFaulted) { throw $task.Exception.InnerException.Message }
    Done @{ ok = $true; out = $dst.Path }
} catch {
    $msg = $_.Exception.Message
    if ($In -match '\.(heic|heif)$' -and $Mode -eq 'image') { $msg = 'HEIC needs the free "HEIF Image Extensions" from the Microsoft Store.' }
    Done @{ ok = $false; error = $msg }
}
