# Windows helper for Dynamic Isle: now playing, full-screen detection, volume, brightness, Caps Lock.
# Reads what Windows says is playing (the same info as the volume flyout / lock screen media controls)
# and prints one JSON object per line on stdout whenever something changes.
# Reads commands from stdin, one per line:  toggle | next | prev | seek <seconds> | select <sourceAppId>
# Runs in Windows PowerShell 5.1, which can call these Windows APIs without anything compiled locally.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait(3000)) { throw 'timeout' }
    $task.Result
}

function Out-Json($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

# Full-screen check: is the window in front covering the whole main screen (video, game, slideshow)?
# A normal maximised window doesn't count, because it leaves the taskbar visible.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IslandFg {
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    public static bool FullscreenOnPrimary() {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero || h == GetShellWindow() || h == GetDesktopWindow()) return false;
        var sb = new StringBuilder(64); GetClassName(h, sb, 64);
        string c = sb.ToString();
        if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Windows.UI.Core.CoreWindow") return false;
        // A maximised window can also cover the screen (e.g. with an auto-hiding taskbar); that's not full screen.
        if (IsZoomed(h)) return false;
        RECT r; if (!GetWindowRect(h, out r)) return false;
        var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) return false;
        if ((mi.dwFlags & 1) == 0) return false; // only the main screen, where the island lives
        return r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
    }
}
"@
$lastFullscreen = $null

# System state for the pop-ups: speaker volume / mute (Windows Core Audio) and Caps Lock.
Add-Type -TypeDefinition @"
using System;
using System.Threading;
using System.Runtime.InteropServices;
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p);
    int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float l, ref Guid g); int SetMasterVolumeLevelScalar(float l, ref Guid g);
    int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);
    int SetChannelVolumeLevel(uint n, float l, ref Guid g); int SetChannelVolumeLevelScalar(uint n, float l, ref Guid g);
    int GetChannelVolumeLevel(uint n, out float l); int GetChannelVolumeLevelScalar(uint n, out float l);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid g); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int s, out IntPtr d); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
public static class IslandSys {
    static IAudioEndpointVolume vol; static DateTime volAt;
    [DllImport("user32.dll")] static extern short GetKeyState(int key);
    public static bool Caps() { return (GetKeyState(0x14) & 1) != 0; }
    // Returns volume 0-100, or -1 if there's no speaker; negative-100.. means muted (we report mute separately).
    public static int Volume(out bool muted) {
        muted = false;
        try {
            // Re-fetch the default speaker every few seconds in case you switch to headphones.
            if (vol == null || (DateTime.UtcNow - volAt).TotalSeconds > 3) {
                var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
                IMMDevice d; if (e.GetDefaultAudioEndpoint(0, 1, out d) != 0 || d == null) { vol = null; return -1; }
                Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
                d.Activate(ref iid, 23, IntPtr.Zero, out o);
                vol = (IAudioEndpointVolume)o; volAt = DateTime.UtcNow;
            }
            float l; vol.GetMasterVolumeLevelScalar(out l);
            bool m; vol.GetMute(out m); muted = m;
            return (int)Math.Round(l * 100);
        } catch { vol = null; return -1; }
    }
    // Microphone mute, in Windows itself, so it applies to every app: the default mic for calls and for everything else.
    static IAudioEndpointVolume Mic(int role) {
        var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        IMMDevice d; if (e.GetDefaultAudioEndpoint(1 /* capture */, role, out d) != 0 || d == null) return null;
        Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
        d.Activate(ref iid, 23, IntPtr.Zero, out o);
        return (IAudioEndpointVolume)o;
    }
    // 1 = muted, 0 = live, -1 = no microphone
    public static int MicMuted() {
        try { var v = Mic(2) ?? Mic(0); if (v == null) return -1; bool m; v.GetMute(out m); return m ? 1 : 0; } catch { return -1; }
    }
    // Clipboard privacy: password managers (and apps copying secrets) add one of these formats to say
    // "don't record this". Electron can't see custom formats, so the helper checks them for the island.
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint fmt);
    static uint[] privFormats;
    public static uint ClipSeq() { return GetClipboardSequenceNumber(); }
    public static bool ClipPrivate() {
        if (privFormats == null) privFormats = new[] { RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"),
            RegisterClipboardFormat("Clipboard Viewer Ignore"), RegisterClipboardFormat("CanIncludeInClipboardHistory") };
        foreach (var f in privFormats) if (f != 0 && IsClipboardFormatAvailable(f)) return true;
        return false;
    }
    // Who is using a capability (microphone, webcam, screen capture) right now, from Windows' privacy records:
    // an app is using it while LastUsedTimeStart is set and LastUsedTimeStop is 0. Every key is closed again
    // (the PowerShell version left ~40 registry handles open each second, which slowly ate memory).
    public static string[] UsersOf(string cap) {
        var list = new System.Collections.Generic.List<string>();
        string root = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\" + cap;
        foreach (var path in new[] { root, root + @"\NonPackaged" }) {
            using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(path)) {
                if (k == null) continue;
                foreach (var name in k.GetSubKeyNames()) {
                    if (name == "NonPackaged") continue;
                    using (var s = k.OpenSubKey(name)) {
                        if (s == null) continue;
                        object start = s.GetValue("LastUsedTimeStart"), stop = s.GetValue("LastUsedTimeStop");
                        if (start == null || stop == null || Convert.ToInt64(stop) != 0 || Convert.ToInt64(start) == 0) continue;
                        string app = name.Contains("#") ? System.IO.Path.GetFileNameWithoutExtension(name.Substring(name.LastIndexOf('#') + 1))
                            : name.Split('_')[0].Substring(name.Split('_')[0].LastIndexOf('.') + 1);
                        if (app == "Dynamic Isle" || app == "Dynamic Island" || app == "electron") continue; // the island itself (sound bars)
                        long ms = (long)(DateTime.FromFileTimeUtc(Convert.ToInt64(start)) - new DateTime(1970, 1, 1)).TotalMilliseconds;
                        list.Add(app + "|" + ms);
                    }
                }
            }
        }
        return list.ToArray();
    }
    public static int SetMic(int mode) { // mode: 1 mute, 0 unmute, 2 toggle
        try {
            int cur = MicMuted(); if (cur < 0) return -1;
            bool want = mode == 2 ? cur == 0 : mode == 1;
            Guid ctx = Guid.Empty;
            foreach (var role in new[] { 0, 2 }) { var v = Mic(role); if (v != null) v.SetMute(want, ref ctx); }
            return want ? 1 : 0;
        } catch { return -1; }
    }
}

// Volume keys: on Windows 11 the only dependable way to stop Windows' own volume pop-up from
// showing next to ours is to handle the volume keys ourselves. A low-level keyboard hook catches
// Volume Up / Down / Mute, sets the volume through Core Audio, and swallows the key so Windows never
// shows its pop-up. If setting the volume fails for any reason, the key is passed on to Windows as normal.
// Every other key is passed straight through untouched.
public static class IslandKeys {
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr hMod, uint threadId);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    const int VK_MUTE = 0xAD, VK_DOWN = 0xAE, VK_UP = 0xAF;
    static HookProc proc;      // kept in a field so it isn't garbage-collected
    static IntPtr hook;
    static IAudioEndpointVolume vol;
    static DateTime volAt;
    public static volatile bool Enabled = true;

    public static void Start() {
        var t = new Thread(() => {
            proc = Hook;
            hook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, proc, GetModuleHandle(null), 0);
            MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
    }

    static IntPtr Hook(int code, IntPtr w, IntPtr l) {
        if (code >= 0 && Enabled) {
            int vk = Marshal.ReadInt32(l);
            if (vk == VK_UP || vk == VK_DOWN || vk == VK_MUTE) {
                int msg = (int)w;
                bool down = msg == 0x100 || msg == 0x104;
                if (!down || Apply(vk)) return (IntPtr)1; // handled: Windows doesn't see it
            }
        }
        return CallNextHookEx(hook, code, w, l);
    }

    static bool Apply(int vk) {
        try {
            if (vol == null || (DateTime.UtcNow - volAt).TotalSeconds > 3) {
                var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
                IMMDevice d; if (e.GetDefaultAudioEndpoint(0, 1, out d) != 0 || d == null) return false;
                Guid iid = typeof(IAudioEndpointVolume).GUID; object o;
                d.Activate(ref iid, 23, IntPtr.Zero, out o);
                vol = (IAudioEndpointVolume)o; volAt = DateTime.UtcNow;
            }
            Guid ctx = Guid.Empty;
            bool muted; vol.GetMute(out muted);
            if (vk == VK_MUTE) { vol.SetMute(!muted, ref ctx); return true; }
            float l; vol.GetMasterVolumeLevelScalar(out l);
            // Same 2% steps as Windows; changing the volume also unmutes, like Windows does.
            int step = (int)Math.Round(l * 50) + (vk == VK_UP ? 1 : -1);
            step = Math.Max(0, Math.Min(50, step));
            vol.SetMasterVolumeLevelScalar(step / 50f, ref ctx);
            if (muted) vol.SetMute(false, ref ctx);
            return true;
        } catch { vol = null; return false; }
    }
}
"@
[IslandKeys]::Start()
$sysLast = ''
$brightness = -1
$brightnessAt = [DateTime]::MinValue
$brightnessWorks = $true

function Publish-System {
    # Brightness only exists for a laptop's own screen; skip it quietly elsewhere.
    if ($script:brightnessWorks -and ([DateTime]::UtcNow - $script:brightnessAt).TotalMilliseconds -gt 700) {
        $script:brightnessAt = [DateTime]::UtcNow
        try {
            $b = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
            $script:brightness = if ($b) { [int]$b.CurrentBrightness } else { -1 }
            if (-not $b) { $script:brightnessWorks = $false }
        } catch { $script:brightnessWorks = $false; $script:brightness = -1 }
    }
    $muted = $false
    $v = [IslandSys]::Volume([ref]$muted)
    $caps = [IslandSys]::Caps()
    $key = "$v|$muted|$($script:brightness)|$caps"
    if ($key -eq $script:sysLast) { return }
    $script:sysLast = $key
    Out-Json @{ type = 'sys'; volume = $v; muted = $muted; brightness = $script:brightness; caps = $caps }
}

$T = @{
    Manager = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
    Props   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
    Stream  = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
}

$manager = Await ($T.Manager::RequestAsync()) $T.Manager
$preferred = $null        # source the user picked, if any
$lastKey = ''
$lastPos = 0.0
$lastSentAt = 0
$lastStatus = ''
$lastArtKey = ''
$art = $null

function Get-Session {
    $sessions = @($manager.GetSessions())
    if ($preferred) {
        $p = $sessions | Where-Object { $_.SourceAppUserModelId -eq $preferred } | Select-Object -First 1
        if ($p) { return $p }
    }
    $cur = $manager.GetCurrentSession()
    if ($cur) { return $cur }
    # Prefer anything that is actually playing.
    $playing = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
    if ($playing) { return $playing }
    return $sessions | Select-Object -First 1
}

function Read-Art($props) {
    if (-not $props.Thumbnail) { return $null }
    $stream = Await ($props.Thumbnail.OpenReadAsync()) $T.Stream
    try {
        # The stream's size isn't visible from PowerShell, so read it in chunks until it runs out.
        # PowerShell can't convert the stream itself; .NET reflection can (it asks the COM object for the interface).
        $ctor = [Windows.Storage.Streams.DataReader].GetConstructor([Type[]]@([Windows.Storage.Streams.IInputStream]))
        $reader = $ctor.Invoke(@($stream))
        $reader.InputStreamOptions = [Windows.Storage.Streams.InputStreamOptions]::Partial
        $ms = New-Object System.IO.MemoryStream
        while ($ms.Length -lt 3MB) {
            $n = Await ($reader.LoadAsync(65536)) ([uint32])
            if ($n -eq 0) { break }
            $chunk = New-Object byte[] $n
            $reader.ReadBytes($chunk)
            $ms.Write($chunk, 0, $n)
        }
        if ($ms.Length -eq 0 -or $ms.Length -ge 3MB) { return $null }
        $bytes = $ms.ToArray()
        # Work out the image type from its first bytes (the content type isn't readable either).
        $mime = if ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { 'image/jpeg' } elseif ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { 'image/png' } elseif ($bytes[0] -eq 0x52 -and $bytes[8] -eq 0x57) { 'image/webp' } else { 'image/png' }
        return "data:$mime;base64," + [Convert]::ToBase64String($bytes)
    } finally {
        # Some apps hand over a plain COM stream with no Dispose; release it either way.
        try { if ($stream -is [System.IDisposable]) { $stream.Dispose() } else { $null = [System.Runtime.InteropServices.Marshal]::ReleaseComObject($stream) } } catch { }
    }
}

# VLC 3 doesn't tell Windows what it's playing, but its window title does ("Movie.mkv - VLC media player").
# We only read the title. Sending VLC media-key messages crashed it in testing, so the island doesn't control it.
$vlcState = @{ title = ''; paused = $false; since = 0 }
function Get-Vlc {
    $p = Get-Process vlc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match '\s-\sVLC media player$' } | Select-Object -First 1
    if (-not $p) { $script:vlcState.title = ''; return $null }
    $t = $p.MainWindowTitle -replace '\s-\sVLC media player$', ''
    if ($t -ne $script:vlcState.title) { $script:vlcState = @{ title = $t; paused = $false; since = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }
    return @{ hwnd = $p.MainWindowHandle; title = $t }
}
$usingVlc = $false

function Publish {
    $s = Get-Session
    $sessions = @($manager.GetSessions() | ForEach-Object {
        @{ id = $_.SourceAppUserModelId; status = "$($_.GetPlaybackInfo().PlaybackStatus)" }
    })
    $vlc = Get-Vlc
    if ($vlc) { $sessions += @{ id = 'VLC'; status = $(if ($vlcState.paused) { 'Paused' } else { 'Playing' }) } }
    # VLC is shown when you picked it, or when nothing else is playing.
    $sPlaying = $s -and "$($s.GetPlaybackInfo().PlaybackStatus)" -eq 'Playing'
    $script:usingVlc = [bool]($vlc -and ($script:preferred -eq 'VLC' -or -not $sPlaying))
    if ($script:usingVlc) {
        $st = if ($vlcState.paused) { 'Paused' } else { 'Playing' }
        $key = "vlc|$($vlc.title)|$st|$($sessions.Count)"
        if ($key -ne $script:lastKey) {
            $script:lastKey = $key
            Out-Json @{ type = 'media'; active = $true; source = 'VLC'; title = $vlc.title; artist = ''; album = ''; status = $st
                canPlayPause = $false; canNext = $false; canPrev = $false; canSeek = $false; readOnly = $true; position = 0; duration = 0; updatedAt = 0; art = $null; sessions = $sessions }
        }
        return
    }
    if (-not $s) {
        if ($script:lastKey -ne 'none') { $script:lastKey = 'none'; Out-Json @{ type = 'media'; active = $false; sessions = $sessions } }
        return
    }
    $props = Await ($s.TryGetMediaPropertiesAsync()) $T.Props
    $info = $s.GetPlaybackInfo()
    $tl = $s.GetTimelineProperties()
    $status = "$($info.PlaybackStatus)"
    $c = $info.Controls

    $artKey = "$($s.SourceAppUserModelId)|$($props.Title)|$($props.Artist)"
    if ($artKey -ne $script:lastArtKey) {
        $script:lastArtKey = $artKey
        try { $script:art = Read-Art $props }
        catch { $script:art = $null; Out-Json @{ type = 'media-error'; message = "cover: $($_.Exception.Message)" } }
        if (-not $props.Thumbnail) { Out-Json @{ type = 'media-error'; message = 'cover: app sent no thumbnail' } }
    }

    $key = "$artKey|$status|$($c.IsNextEnabled)|$($c.IsPreviousEnabled)|$($sessions.Count)|$([bool]$script:art)|$($tl.EndTime.TotalSeconds)"
    # The island works out the moving position itself; only report the timeline when it jumps (seek, new
    # track) or every 5 s to correct drift.
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $pos = $tl.Position.TotalSeconds
    $expected = $script:lastPos
    if ($script:lastStatus -eq 'Playing') { $expected += ($now - $script:lastSentAt) / 1000.0 }
    $jumped = [Math]::Abs($pos - $expected) -gt 2
    if ($key -eq $script:lastKey -and -not $jumped -and ($now - $script:lastSentAt) -lt 5000) { return }
    $script:lastKey = $key
    $script:lastPos = $pos
    $script:lastSentAt = $now
    $script:lastStatus = $status

    Out-Json @{
        type      = 'media'
        active    = $true
        source    = $s.SourceAppUserModelId
        title     = $props.Title
        artist    = $props.Artist
        album     = $props.AlbumTitle
        status    = $status
        canNext   = $c.IsNextEnabled
        canPrev   = $c.IsPreviousEnabled
        canSeek   = $c.IsPlaybackPositionEnabled
        position  = $tl.Position.TotalSeconds
        duration  = $tl.EndTime.TotalSeconds
        updatedAt = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
        art       = $script:art
        sessions  = $sessions
    }
}

function Run-Command([string]$line) {
    $parts = $line.Trim() -split '\s+', 2
    if ($parts[0] -eq 'select') { $script:preferred = $parts[1]; $script:lastKey = ''; return }
    if ($parts[0] -eq 'volkeys') { [IslandKeys]::Enabled = ($parts[1] -eq 'on'); return }
    if ($parts[0] -eq 'mic') {
        $mode = switch ($parts[1]) { 'mute' { 1 } 'unmute' { 0 } default { 2 } }
        $r = [IslandSys]::SetMic($mode)
        Out-Json @{ type = 'media-error'; message = "mic $($parts[1]) -> $(switch ($r) { 1 { 'muted' } 0 { 'live' } default { 'no microphone' } })" }
        $script:privLast = ''; Publish-Privacy; return
    }
    if ($script:usingVlc -and $parts[0] -in 'toggle', 'next', 'prev', 'seek') { return } # VLC: shown, not controlled
    $s = Get-Session
    if (-not $s) { return }
    switch ($parts[0]) {
        'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
        'next'   { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
        'seek'   { $ticks = [long]([double]$parts[1] * 10000000); $null = Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool]) }
    }
}

# Who is using the microphone, camera or screen capture right now. Windows records it per app under
# CapabilityAccessManager\ConsentStore: an app is using it while LastUsedTimeStart is set and LastUsedTimeStop is 0.
$privLast = ''
$consent = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore'
function Users-Of([string]$cap) {
    foreach ($u in [IslandSys]::UsersOf($cap)) { $a, $ms = $u -split '\|', 2; @{ app = $a; since = [long]$ms } }
}
function Publish-Privacy {
    $mic = @(Users-Of 'microphone'); $cam = @(Users-Of 'webcam')
    $scr = @(Users-Of 'graphicsCaptureProgrammatic') + @(Users-Of 'graphicsCaptureWithoutBorder')
    $muted = [IslandSys]::MicMuted()
    $key = ((@($mic) + @($cam) + @($scr) | ForEach-Object { "$($_.app)$($_.since)" }) -join ',') + "|$muted"
    if ($key -eq $script:privLast) { return }
    $script:privLast = $key
    Out-Json @{ type = 'privacy'; mic = @($mic); cam = @($cam); screen = @($scr); micMuted = $muted }
}

# [Console]::In.ReadLineAsync() blocks in Windows PowerShell; a StreamReader over the raw stream does not.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
$pending = $stdin.ReadLineAsync()
$tickCount = 0
$clipSeq = [uint32]0
Out-Json @{ type = 'media-ready' }

while ($true) {
    try {
        while ($pending.IsCompleted) {
            $line = $pending.Result
            if ($null -eq $line) { exit 0 }      # app closed our stdin: quit
            if ($line) { Run-Command $line }
            $pending = $stdin.ReadLineAsync()
        }
        # Something new on the clipboard: say whether it's marked private (the island then won't record it).
        $cs = [IslandSys]::ClipSeq()
        if ($cs -ne $clipSeq) { $clipSeq = $cs; Out-Json @{ type = 'clip-private'; seq = [long]$cs; private = [IslandSys]::ClipPrivate() } }
        # Volume and Caps Lock every 120 ms so the pop-up feels instant; media and full screen every ~0.5 s.
        Publish-System
        if (($tickCount++ % 4) -eq 0) {
            $fs = [IslandFg]::FullscreenOnPrimary()
            if ($fs -ne $lastFullscreen) { $lastFullscreen = $fs; Out-Json @{ type = 'fullscreen'; on = $fs } }
            Publish
        }
        if (($tickCount % 16) -eq 1) { Publish-Privacy }   # about every 2 s
        if (($tickCount % 2500) -eq 0) { [GC]::Collect() }   # every ~5 min, return memory PowerShell no longer needs
    } catch {
        Out-Json @{ type = 'media-error'; message = "$($_.Exception.Message)" }
        Start-Sleep -Milliseconds 1500
    }
    Start-Sleep -Milliseconds 120
}
