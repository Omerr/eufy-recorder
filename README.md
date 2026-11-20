# Eufy motion recorder

A Windows-native motion recorder for eufy SoloCam cameras. Uses the unofficial
[eufy-sdk](https://github.com/mega-yfue/eufy-sdk), pinned to version 0.5.0.
Camera compatibility and motion notifications still need testing on your account.

The recorder opens a live connection when motion arrives and saves a short clip.
It writes complete MP4 fragments to disk throughout the event.
Recording runs on Node.js alone. Optional automations can control lights, camera audio, and music.

See [camera event automations](docs/automations.md) for the configuration page, Android presence,
Yeelight, camera speech, and Yoto setup.

## First connection

Open a normal Windows PowerShell terminal:

```powershell
cd C:\path\to\eufy-recorder
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 setup
```

Enter your eufy email and password locally. Use the country code associated with
your eufy account. Enter any verification code in the same terminal.
If asked for a captcha, open the image at the printed path.

The script stores the password with Windows DPAPI encryption under
`%LOCALAPPDATA%\EufyRecorder`. The SDK stores session tokens in that directory too.
The password stays out of source files and command-line arguments.
The launcher passes it to the Node process through its environment.

Setup prints device names and serial numbers. Use the serial of one S220 below.
Commands should run one at a time; close the previous command with Ctrl+C.

## Test a manual clip

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 record -Camera YOUR_CAMERA_SERIAL -Seconds 30
```

Walk into view, then open the saved `clip.mp4`. VLC can play H.264 and H.265.
Windows playback depends on the installed codecs.
Recordings appear in the project's `recordings` folder.

Each clip has `recording.json` with timing, bytes saved, and the result.
`firstFragmentDelayMs` measures notification receipt to the first saved fragment.
It excludes the delay between physical movement and the notification.
For a manual recording, it measures time from the manual recording request.

## Test motion notifications

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 events
```

Walk in front of the camera. Confirm a detection appears in both the eufy app and
the terminal. Close this command with Ctrl+C.
If manual recording works and events are missing, investigate the notification path.

## Record on motion

Edit `recorder.json` and put both camera serial numbers in `cameras`:

```json
"cameras": ["FIRST_CAMERA_SERIAL", "SECOND_CAMERA_SERIAL"]
```

Then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 watch
```

Only the selected cameras start recordings. Motion, person, and stranger detections
trigger clips. More detections extend an active clip, up to 120 seconds by default.
The SDK releases idle camera connections after ten seconds.
If a connection fails, the recorder retries up to three times within the original
event window.

For a disconnection test, block the camera's network connection through your router
after a recording begins. Restore connectivity and check that saved footage plays.
Stop the recorder before reviewing results.

## Battery tracking and ntfy

While `watch` runs, the recorder tracks battery percentage and charging status for
the selected cameras. It checks cloud-reported values every 30 minutes and also
handles battery updates and low-battery events received through the SDK.
Battery checks use cloud metadata; they open no video stream.
Eufy's reported levels can lag the camera's actual battery level.

Default thresholds:

- At 30% or below, send a high-priority warning.
- At 10% or below, send an urgent warning immediately, even after an earlier warning.
- Repeat warnings every 24 hours while the battery remains low.
- Reset the warning after the battery reaches at least 35%.

Alert history survives restarts. Failed deliveries remain pending for a later check.
An explicit eufy low-battery event can warn even when the percentage is unavailable.
Unknown percentages are displayed as unknown.

Install the ntfy app on your Android phone, then configure a topic:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 ntfy-setup
```

Enter your ntfy server and topic. A blank topic generates a random topic name.
Subscribe to the printed server and topic in the Android app.
An optional access token is saved with Windows DPAPI encryption.
Setup updates `recorder.json` and sends no notification.
Notification setup creates a missing config automatically and can run before camera login.
Camera setup asks you to confirm the account country and preserves the ntfy settings.

Send a test notification:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 ntfy-test
```

This checks delivery to ntfy separately from camera login and battery readings.
Check that it reaches your phone, then run `watch` for automatic alerts.
Thresholds, check interval, and reminder interval are configurable under `battery`
in `recorder.json`. Missing settings use the defaults in `recorder.example.json`.
Set `battery.enabled` to `false` to disable battery monitoring.

Read the selected cameras' latest reported levels on demand:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 battery
```

Close `watch` before running this command. The monitor saves its readings and alert
history to `%LOCALAPPDATA%\EufyRecorder\battery-status.json`.
Without an ntfy topic, battery levels still appear in the recorder terminal.

## Automatic startup and storage

The `Eufy Recorder` Windows scheduled task starts the recorder when you sign in.
Recording continues while the screen is locked. After reboot, sign in to resume recording.
The task restarts a failed process after one minute.
Logs are saved under `%LOCALAPPDATA%\EufyRecorder\logs`.

Use Windows PowerShell to manage the task:

```powershell
Get-ScheduledTask -TaskName 'Eufy Recorder'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Stop-Recorder.ps1
Start-ScheduledTask -TaskName 'Eufy Recorder'
```

Stop the task before running a manual camera command.
The recorder blocks a second realtime client from sharing its notification identity.
Use `Stop-Recorder.ps1` for a graceful stop that closes the Windows worker too.
For a fresh installation, register it with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Startup.ps1 -StartNow
```

Storage cleanup runs when `watch` starts and every hour thereafter.
It deletes the oldest completed clips beyond 14 days or a 10 GB total budget.
Active recordings and folders containing extra user files are preserved.
Change `retention.maxDays` and `retention.maxGB` in `recorder.json` to adjust these limits.

## Current limits

- Login and motion notifications use eufy's cloud services.
- Recording begins after notification receipt and camera connection.
- Previously saved camera clips are outside this experiment.
- Completed fragments remain on disk after disconnection; footage inside the camera
  or its current fragment can be lost.
- Recording errors appear in the terminal or background logs.
- Keep the Windows PC awake; manual runs also need their terminal kept open.
- Restart interactively if login expires and requires verification.

Add each camera's serial to `cameras` after connecting it in the eufy app.

## Development checks

Node.js 24.5.0 or newer is required. Run `npm ci` to install dependencies.

```powershell
npm.cmd run check
npm.cmd test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 check
```

These checks use local fixtures and make no camera login attempt.

## Publishing changes

Keep camera configuration, credentials, recordings, audio clips, logs, and exports local.
Only source files, generic examples, and the synthetic test fixture are allowed in Git.
The example video contains a generated solid-color image.

Enable the repository's local commit and push checks after cloning:

```powershell
npm run setup-hooks
npm run privacy
```

The checks inspect staged content, commit messages, and history for private data.
Your local camera identifiers and notification topic are also checked when config exists.
Findings report the file and category without printing the matching value.
Use a GitHub noreply email for commits.
An optional external denylist can block additional personal names or network labels.
Keep that JSON array outside the repository and set its path with
`git config --local privacy.denylist PATH_TO_PRIVATE_FILE`.
