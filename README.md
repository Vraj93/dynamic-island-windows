# Dynamic Island for Windows

A free, Mac-style "Dynamic Island" that lives at the top-centre of your screen. Nothing shows while you're idle;
rest the mouse on the top edge for a utility sheet, and the island appears on its own when something happens.

## What it does

- **Utility sheet:** clock, date, battery and nine tools: Timer, Alarm, Stopwatch, Focus (Pomodoro), Reminders, Note,
  Clipboard history, Shelf, File converter. Settings from the gear.
- **Media:** whatever Windows says is playing (Spotify, YouTube in a browser, VLC...). Cover art, sound bars that follow
  the real audio, play/pause/next/previous, seek, switching between apps. Right-click to hide.
- **Claude Code:** live status of each session, Allow / Deny for permission requests right in the island, and a
  "finished" summary.
- **System pop-ups:** volume (replaces the Windows pop-up), brightness, Caps Lock, charger plugged in / unplugged,
  low battery.
- **Stays out of the way:** hides during full-screen video and games (alerts still show), never takes keyboard focus
  except in text boxes, clicks pass through everywhere except the island itself.

## Install

Download `Dynamic-Island-Setup-<version>.exe` from the
[Releases](https://github.com/Vraj93/dynamic-island-windows/releases) page and run it. The setup wizard shows the
license, lets you pick the folder, and adds Start menu and desktop shortcuts. Uninstall from Windows Settings › Apps.

The installer isn't code-signed yet, so:

- **SmartScreen** may say "Windows protected your PC": click **More info** › **Run anyway**.
- **Smart App Control** (if it's on) blocks unsigned apps completely. Use the "run from source" steps below instead,
  or wait for the Microsoft Store version (Store apps are signed by Microsoft, which also removes the warnings).

## Build the installer

GitHub builds it: push a version tag and the [Build installer](.github/workflows/release.yml) workflow creates a
release with the installer attached.

```bash
git tag v0.1.0
git push origin v0.1.0
```

On a PC without Smart App Control you can also build locally with `npm run dist` (output in `dist/`).
For the Microsoft Store, fill in the `appx` identity in `package.json` from Partner Center and run `npm run dist:store`.

## Run from source

Needs Windows 10/11 and Node.js. Works with Smart App Control on.

```bash
npm install
npm start
```

Quit from the tray icon (near the clock) or Settings › Quit island. "Start with Windows" is in Settings.

### Connect Claude Code (optional)

```bash
npm run connect-claude
```

Adds hooks to `~/.claude/settings.json` (a backup is made first). Undo with `npm run disconnect-claude`.
If the island isn't running, or you don't answer within 55 seconds, Claude Code shows its normal prompt.

## How it's built

- `electron/main.js`: the see-through, always-on-top window, top-edge trigger, click-through, tray, clipboard,
  shelf drag-out, the local server that Claude Code hooks talk to, and the converter.
- `electron/media.ps1`: a Windows PowerShell helper for things Electron can't reach: now playing (Windows media
  controls), full-screen detection, volume and volume keys (Core Audio), brightness, Caps Lock.
- `electron/convert.ps1`: file conversion with Windows' own components: Windows Imaging for pictures,
  Media Foundation for audio/video. PDFs come from Electron.
- `electron/hooks/claude-hook.js` and `scripts/claude-hooks.js`: the Claude Code hook and its installer.
- `ui/`: the island itself (plain HTML, CSS and JavaScript): `app.js` for the island, media, agents and pop-ups;
  `tools.js` for the sheet tools.

### Why PowerShell instead of native code

Windows Smart App Control blocks unsigned programs compiled on the PC. Electron and Windows PowerShell are trusted,
so all Windows integration goes through PowerShell (which can still call Windows APIs). No ffmpeg either: the
converter only uses what ships with Windows.

## License

[MIT](LICENSE): free to use, change and share, including commercially, as long as the copyright notice stays.

## Limits

- HEIC pictures need the free "HEIF Image Extensions" from the Microsoft Store; WEBP/HEIC can't be written.
- Brightness only works for a laptop's built-in screen.
- Not yet built: Bluetooth / Wi-Fi pop-ups, calendar.
