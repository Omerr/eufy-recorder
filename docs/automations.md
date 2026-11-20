# Camera event automations

Recording and battery alerts run independently of automation rules.
Rules can turn on a Yeelight, play a camera audio clip, start a Yoto card, or call a webhook.

## Setup and configuration page

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 automation-setup
```

Setup creates an encrypted API key under `%LOCALAPPDATA%\EufyRecorder`.
It adds disabled example rules to your local `recorder.json`.
The example is also available in `automation.example.json`.

Choose a bind address under `automations.api.host`. The default is loopback.
For phone access, use the Windows machine's Tailscale address and keep Tailscale connected on the phone.
Bind to that specific address. The HTTP connection travels inside the encrypted Tailscale network.
Avoid router port forwarding or exposing the control API to the public internet.

Restart the recorder after changing its bind address:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Stop-Recorder.ps1
Start-ScheduledTask -TaskName 'Eufy Recorder'
```

Open `http://WINDOWS_TAILSCALE_ADDRESS:8788/` in a browser.
Display the key in a local terminal:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 automation-info
```

Enter the key without the `Authorization: Bearer` prefix.
The page keeps the key in memory for that tab.
You can adjust rules and save them while recording continues.
API address and token-variable changes require a restart.

Each rule specifies:

- Camera serial numbers and detection types.
- An optional time window in the configured IANA time zone.
- A required phone state: home, away, or any.
- A cooldown to suppress repeated detections of the same visitor.
- One or more named device actions.

`after: "17:00"` matches 17:00 through midnight each day.
Add `before: "07:00"` to continue through the following morning.
Person and stranger detections share a rule's cooldown.

## Android presence with MacroDroid

Presence starts as unknown after each recorder restart.
An away-only rule requires a fresh, explicit away report.
Missing or stale reports become unknown and block that rule.
Returning home cancels active actions and prevents later actions in the same rule.

Keep Tailscale connected on Android, including when using mobile data.
Allow MacroDroid to read Wi-Fi connection information and run in the background.
Select your home Wi-Fi networks inside MacroDroid; the recorder needs no SSID or Wi-Fi password.

Use an HTTP Request action with these settings:

The configuration page also provides ready-to-copy requests under **Set up MacroDroid**.
In MacroDroid's HTTP Request action, use its menu's **Import from cURL string** option.
The page fills in your endpoint and key locally after you sign in.

```text
Method: POST
URL: http://WINDOWS_TAILSCALE_ADDRESS:8788/api/presence
Header: Authorization: Bearer YOUR_PRIVATE_KEY
Header: Content-Type: application/json
Body: {"state":"home"}
```

Create these macros:

1. When connecting to either home Wi-Fi network, send `home` immediately.
2. When disconnecting, wait 60 seconds. If still disconnected from both home networks, send `away`.
3. Every five minutes, report the current state. Send `home` on a home network and `away` after leaving.

If Android cannot determine the Wi-Fi state, send `unknown`.
Grant location permission all the time and keep Android Location enabled for reliable SSID detection.
If Location is disabled, the heartbeat must send `unknown`.
Confirm the home and away reports on the configuration page before enabling rules.
The default report expiry is 15 minutes and can be changed in the configuration.
Wi-Fi presence describes network membership; it is an approximation of physical presence.

## Yeelight

Enable LAN Control in the Yeelight app and set the lamp's host or IP address locally.
The adapter queries `power` and sends `set_power` only when the lamp reports off.
It preserves brightness and color settings.
Multicast discovery can fail even when direct connections work.
A router DHCP reservation helps keep the configured address stable.

## Camera speech

Put a short audio file under the ignored `audio` directory.
The `eufy-audio` device selects the camera and file.
The file must be AAC-LC, 16 kHz, mono, in ADTS format. Use 16 kbps for speech.
Convert a phone recording with FFmpeg:

```text
ffmpeg -i recording.m4a -ac 1 -ar 16000 -c:a aac -b:a 16k -f adts audio/visitor.aac
```

With FFmpeg installed on Windows, you can also generate speech from text:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Make-Speech.ps1 -Text "Hello. Is someone there?"
```

The text is synthesized locally with a Windows voice. The generated audio remains ignored by Git.

The adapter waits for the SDK's playback-completion signal before closing talkback.
It rejects oversized frames before opening the speaker. A higher average bitrate can
produce frames beyond the device limit even when the file's average bitrate looks acceptable.
The camera must expose a supported talkback path.
Audio shares the camera's live connection with recording.
An automatic speech rule plays its clip once and respects the rule's cooldown.

The configuration page's device-test button runs a selected action immediately.
This includes audible playback and applies outside automatic time and presence conditions.
For an audible walk-through test, select a camera audio device and choose
**Play on next person detection**. This arms one playback on that camera for five minutes.
You can then walk into view. The one-time test bypasses automatic time and presence conditions.
It leaves the normal rules unchanged, ignores duplicate detections, and expires if unused.
Use **Cancel speaker test** to disarm it or stop its playback.

## Yoto

Yoto support uses its official OAuth and MQTT APIs.
Create a public client in the [Yoto developer portal](https://yoto.dev/get-started/start-here).
Register `http://127.0.0.1:8787/callback` as its redirect URL.
Allow device-control, library-read, and offline-access scopes.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 yoto-setup
```

Enter the public client ID, then open the printed authorization URL on the Windows PC.
Login stores the session outside the repository. Refresh tokens rotate automatically.
Configure the player ID, card URI, and optional volume in the Yoto device entry.
The `tokenEnv` setting can provide an access token for an existing external integration.
Without that environment variable, the locally saved OAuth session is used.

Playback waits for a player acknowledgment. An unavailable player produces an action failure.
Yoto actions have a timeout and do not queue commands for a later reconnection.
Keep the music rule disabled until account setup and a device test succeed.

## API reference

All API routes require the bearer key. The root page contains only the login UI before authentication.

| Route | Purpose |
|---|---|
| `GET /api/state` | Phone presence and latest detection decisions |
| `GET /api/config` | Local automation configuration |
| `PUT /api/config` | Validate and save rules and devices |
| `POST /api/presence` | Report home, away, or unknown |
| `POST /api/simulate` | Preview a camera event without executing actions |
| `POST /api/test` | Run one configured device action immediately |
| `POST /api/speaker-test` | Arm one speaker playback on the next person detection |
| `DELETE /api/speaker-test` | Cancel the one-time speaker test |

Simulation accepts `kind`, `camera`, an optional ISO timestamp `at`, and an optional presence override.
Overrides affect the preview only. They leave actual phone presence unchanged.
Device tests accept `{"device":"DEVICE_ALIAS"}`.

Local config, API keys, camera IDs, network addresses, audio clips, and OAuth sessions stay private.
The public-source checks reject runtime files and matching private configuration values.
