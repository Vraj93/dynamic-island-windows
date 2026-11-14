# File converter for Dynamic Island. Uses only what ships with Windows:
#   images: Windows Imaging (WIC) through WPF  -> jpg, png, bmp, tiff, gif   (reads heic if the HEIF extension is installed)
#   audio / video: Windows Media Foundation transcoder -> mp3, m4a, wav, mp4
# Prints one JSON line at the end: {"ok":true,"out":...} or {"ok":false,"error":...}
param(
    [Parameter(Mandatory)] [ValidateSet('image', 'media')] [string]$Mode,
    [Parameter(Mandatory)] [string]$In,
    [Parameter(Mandatory)] [string]$Out,
    [Parameter(Mandatory)] [string]$Format,
    [int]$Quality = 90
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
