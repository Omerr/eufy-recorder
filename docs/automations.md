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

## Check before leaving

Keep the recorder running, then use **Check before leaving** on the control page.
The same check is available from Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 readiness
```

The check reads the lamp's current power state and requests a live Yoto playback report.
A light that is off and reachable appears as standby.
Yoto can be stopped or paused and still pass the connection check.
An unreachable device fails its check. Check mains power, Wi-Fi, and Yoto internet access.
Yoto authorization failures also fail the check.
The check leaves light power, player volume, and playback unchanged.

The report also checks household presence and whether response rules are enabled.
Unknown presence and paused rules need attention even when both devices are reachable.
The command exits with status 1 when a device fails or an automation prerequisite needs attention.
Status 0 means the listed checks passed. Rule time windows and detection conditions still apply.
This checks connections at the displayed time. Use separate recording and audible playback tests to verify those functions.

Yoto playback accepts both documented acknowledgement names and the names returned by player firmware.
A live status request runs before playback. Retained status messages cannot confirm reachability.

## Router-based household presence

The HOT Box 5F adapter supports the GR140IG local interface.
It reads the router's current Wi-Fi association lists for both bands.
Cached device names help identify phones; cached leases never count as presence.

Save the local router administrator credentials on Windows:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Connect-Router.ps1
```

The prompt uses the local gateway address by default. Use `-Address` to select another local router URL.
It saves credentials with Windows encryption in the private application state folder.
Restart the recorder after saving or changing those credentials.

On the configuration page, enable **Use the router to check everyone at home**.
Register each person's phone addresses under **Household Wi-Fi**.
The connected-device table can add addresses to a person with a checkbox.
Include the phone's addresses for every home Wi-Fi network; Android can use a different randomized address per network.
Save the household configuration after editing it.

Defaults:

- Read the router every 60 seconds.
- Either registered phone connected means home immediately.
- All registered phones absent for three minutes means away.
- Missing phone mappings or failed router reads mean unknown.

An away-only rule stays blocked during unknown states and the departure grace period.
Changing phone mappings restarts that grace period.
In router mode, MacroDroid reports cannot override household presence.
The phone apps are optional with this mode.
The phone reports mode below uses positive Wi-Fi association as additional home evidence.

Wi-Fi presence is a connection-based estimate of occupancy. A phone with Wi-Fi switched off counts as absent.
Check that phones remain associated with their screens off before relying on the setup.
Rejected router credentials pause further login attempts until the recorder is restarted with corrected credentials.
No router network settings are changed by the monitor.

## Android presence with MacroDroid

Choose a presence method under **Household presence settings**, then save.
Router mode remains the default for existing installations.

### Last reported state

Select **Last reported state (events)** to use `household.mode: "events"`.
Each person's home, away, or unknown state persists until another event or manual correction changes it.
Periodic phone updates are optional with this method.
Any person recorded as home makes the household home.
Everyone recorded as away starts the three-minute departure grace period.
Missing person states keep the household unknown until corrected.

The top of the control page provides these controls:

- **Automatic** combines each person's recorded state and applies the departure grace period.
- **Someone home** holds household presence at home until you change the mode.
- **Everyone away** sets household presence to away immediately. A new home report returns the mode to Automatic.

Each person also has Home, Away, and Unknown buttons for correcting a missed event.
The page shows the source and date of the last update.
A missed return can leave a person recorded as away. Review and correct the state on the page when needed.
Presence controls affect enabled rules; rule switches remain independent.
Time windows, camera selection, and cooldowns still apply to manual everyone-away mode.

Person states, departure timing, and manual mode are saved privately in `presence-state.json` and survive recorder restarts.
Changing the person IDs or presence method starts with unknown states and Automatic mode.
The encrypted recovery snapshot includes the saved state. Review it before enabling responses on a restored installation.

Open the page through Tailscale and enter your access key.
**Remember this browser** saves that key in the browser for subsequent visits.
**Disconnect and forget key** removes the saved key.

### Expiring reports

Select **Phone reports with router home detection** to use `household.mode: "hybrid"`.
This method expires individual reports after `presenceMaxAgeMinutes`, which defaults to 15 minutes.
Fresh explicit away reports are required from every person throughout the departure grace period.
Missing or expired reports become unknown and block away-only rules.
Periodic location verification can renew those reports.

With either individual method, **Check home Wi-Fi connections** optionally adds current router association as home evidence.
Wi-Fi absence contributes no away evidence.
Leave that option off when using only phone events and manual controls.
Returning home cancels active actions and prevents later actions in the same rule.

### Phone settings

Keep Tailscale connected on the reporting phone, including when using mobile data.
Give MacroDroid precise location access **Allow all the time** and allow background battery usage.
Keep Android Location enabled.
Notification access is needed only when forwarding Google Maps alerts.
Home coordinates stay on the phone; the recorder receives a person ID, source, and state.

### HTTP action

Open **Set up MacroDroid** on the recorder's control page.
Select the person and report source.
Copy the appropriate home, away, or unknown request.
These requests include the private access key; keep them on your own devices.

In MacroDroid, add an **HTTP Request** action.
Use its menu's **Import from cURL string** option to paste the request.
The control page fills in the endpoint, access key, person ID, and source locally.
An individual report has this shape:

```text
Method: POST
URL: http://WINDOWS_TAILSCALE_ADDRESS:8788/api/presence
Header: Authorization: Bearer YOUR_PRIVATE_KEY
Header: Content-Type: application/json
Body: {"person":"person-1","source":"geofence","state":"home"}
```

### Geofence transitions

Create a home geofence in MacroDroid, with a radius of about 200–300 metres.
Create two macros:

1. **My arrival:** Geofence Trigger, entering Home; send this person's `geofence` home request.
2. **My departure:** Geofence Trigger, exiting Home; send this person's `geofence` away request.

Enable **Trigger if Previous Location Unknown** if available, to help initialize after restart.
Keep the light and sound rules disabled during setup.
Check each person's state on the control page while testing arrival and departure.
Testing an HTTP action manually verifies delivery; it bypasses the macro's location trigger.

In event mode, these transitions keep their state until the next event or correction.
Expiring mode needs periodic verification using a newly obtained location fix.
Send unknown when a location check cannot distinguish inside from outside.
Repeating a stored value cannot provide that verification.

### Google Maps notifications through one phone

Google Maps supports arrival and departure notifications for a person sharing their location with you.
On the receiving phone, open Maps, profile picture, **Location sharing**, then select that person.
Under **Notifications**, tap **Add**, choose home, and enable arrival and departure alerts.
Google informs the sharing person when these alerts are added.
See [Google's notification instructions](https://support.google.com/maps/answer/11966807).

Grant MacroDroid Android **Notification access**.
Create two macros using **Notification received**, with **Maps** as the selected app:

1. Match that person's actual arrival alert for home; send their `maps-notification` home request.
2. Match that person's actual departure alert for home; send their `maps-notification` away request.

Match the person, location, and arrival/departure wording from a real notification in the phone's language.
Use exact text or a carefully bounded pattern.
Matching only a person's name or the word home can include unrelated notifications.
Leave each macro unconfigured until a real alert establishes its wording.
Only the state is forwarded; notification text stays on the phone.

Maps alerts report transitions and cannot supply periodic location verification.
Forward each new alert once.
Do not repeat an old departure alert through a timer or retry queue.
Event mode keeps the reported state until another alert or manual correction.
In expiring mode, the person becomes unknown after the report expiry.

### Recover the phone macros

Export the macros and geofences through MacroDroid's **Export/Import** screen after changing them.
The export contains home coordinates and HTTP access keys. Keep it in private encrypted recovery storage.
Copy a fresh export after phone changes; computer backups cover the last copied version.

On a replacement phone, import the saved macros and geofences through MacroDroid.
Use **Select items to import** to preserve existing macros.
Connect Tailscale and grant background location, notification access, and the required battery exemption.
Update HTTP request addresses and keys if the restored recorder uses different values.
Check Google Maps arrival and departure notifications separately; those settings belong to the Google account.
Keep device response rules paused until real arrivals and departures verify each person's reports.

### Legacy single-state reports

With router checks disabled and `household.mode` set to `router`, the original
`{"state":"home"}` API body remains supported.
That body describes the whole household.
Use individual reports when tracking multiple people.

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
Allow device-read, device-control, library-read, and offline-access scopes.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-Recorder.ps1 yoto-setup
```

Enter the public client ID, then open the printed authorization URL on the Windows PC.
Login stores the session outside the repository. Refresh tokens rotate automatically.
Configure the player ID, card URI, and optional volume in the Yoto device entry.
The configuration page can load your players and library cards, then save that selection locally.
Card playback uses a URI in the form `https://yoto.io/CARD_ID`.
The `tokenEnv` setting can provide an access token for an existing external integration.
Without that environment variable, the locally saved OAuth session is used.

Playback waits for a player acknowledgment. An unavailable player produces an action failure.
Existing playback is preserved by default: the action checks playback state before changing volume or starting a card.
Uncheck **Preserve existing playback** to allow replacing it.
Yoto actions have a timeout and do not queue commands for a later reconnection.
Playback uses the player's current **Repeat All** setting for continuous looping.
Returning home blocks new away-only starts and leaves audio that already started playing.
Stop it on the player or in the Yoto app, or select another playlist.
Keep the music rule disabled until account setup and a device test succeed.

## Sleep music phone widget

Configure a Yoto device named `sleep-music` with the desired playlist URI.
Set `skipIfPlaying` to `false` so a tap can switch from other audio.
Omit `volume` to keep the player's current volume.

Generate a private MacroDroid import on Windows:

```powershell
.\Start-Recorder.ps1 sleep-widget
```

The export is saved as `phone-exports/yoto-sleep-widget.mdr` in the private recorder state folder.
It contains one macro and a playback-only access key. Keep the file private.
Import that file on each Android phone using MacroDroid's **Select items to import** option.
Then add a MacroDroid button widget to the home screen and select **Yoto - Sleep music**.
The default export uses Tailscale. The Windows recorder service must be running.

For a phone that uses home Wi-Fi only, save `sleep-lan.json` in the private recorder state folder:

```json
{"host":"WINDOWS_LAN_ADDRESS","port":8789}
```

Use the Windows PC's private LAN IPv4 address and allow the selected TCP port on the home network in Windows Firewall.
Restart the recorder, then run `sleep-widget` again.
It also creates `phone-exports/yoto-sleep-widget-home.mdr`, which works over home Wi-Fi without a VPN app.
This listener only serves Sleep playback and a basic connection check. Camera and presence controls stay on the original API address.
Guest Wi-Fi must allow access to the PC; otherwise use the main home network.
After restoring to a different PC, update the saved LAN address, firewall access, and widget exports.

A tap starts the configured playlist independently of presence, camera events, and security rule switches.
The widget key only permits the sleep playback endpoint; camera settings and presence controls require the main access key.
The same export works on both phones. Regenerate and import it again after changing the recorder address or main access key.
Home screen placement must be recreated on a replacement phone.

## API reference

All API routes require the bearer key. The root page contains only the login UI before authentication.

| Route | Purpose |
|---|---|
| `GET /api/state` | Phone presence and latest detection decisions |
| `GET /api/config` | Local automation configuration |
| `GET /api/yoto` | Player and card selection metadata from the connected account |
| `PUT /api/config` | Validate and save rules and devices |
| `POST /api/presence` | Report or manually correct a person's home, away, or unknown state |
| `POST /api/presence/mode` | Select auto, home, or away household mode |
| `POST /api/simulate` | Preview a camera event without executing actions |
| `POST /api/router/refresh` | Read the current router association snapshot |
| `POST /api/test` | Run one configured device action immediately |
| `POST /api/shortcuts/sleep` | Play the sleep-music Yoto device; accepts the playback-only widget key |
| `POST /api/speaker-test` | Arm one speaker playback on the next person detection |
| `DELETE /api/speaker-test` | Cancel the one-time speaker test |

Simulation accepts `kind`, `camera`, an optional ISO timestamp `at`, and an optional presence override.
Overrides affect the preview only. They leave actual phone presence unchanged.
Device tests accept `{"device":"DEVICE_ALIAS"}`.
Household mode accepts `{"mode":"auto"}`, `{"mode":"home"}`, or `{"mode":"away"}`.
Individual corrections use `source: "manual"` alongside the person ID and state.

Local config, API keys, camera IDs, network addresses, audio clips, and OAuth sessions stay private.
The public-source checks reject runtime files and matching private configuration values.
