# Hikvision SDK v3 for Homey Pro

[English](README.md) | [Nederlands](README.nl.md)

Connect compatible Hikvision IP cameras, video doorbells and network video
recorders directly to Homey Pro over the local network. The app uses Hikvision
ISAPI for device functions and events, and RTSP for video. No Hikvision cloud
account is required.

- **App ID:** `nl.nobrainer.hikvision`
- **Current Test release:** `2026.9.5` (local candidate; `2026.9.4` is currently published)
- **Homey:** Homey Pro, firmware 12.3.0 or newer
- **Install:** [Homey App Store Test](https://homey.app/en-us/app/nl.nobrainer.hikvision/Hikvision/test/)
- **Support:** [Homey Community topic](https://community.homey.app/t/app-pro-test-hikvision-sdk-v3/157226)

> [!IMPORTANT]
> This app replaces the earlier test app `nl.nobrainerhomey.Hikvision`. Homey
> cannot migrate devices or Flows automatically between different app IDs. See
> [Migrating from the previous test app](#migrating-from-the-previous-test-app).

## Highlights

- Native Homey Live video with automatic selection of a compatible H.264 stream
- Snapshots for cameras, door stations and up to sixteen online NVR channels
- Dashboard widget with digital zoom, pan, pinch gestures and automatic refresh
- Motion, doorbell and smart-event triggers with snapshot image tags
- Separate alarm states and Homey Insights for supported event types
- Relative PTZ movement, safe PTZ stop and stored PTZ preset selection
- Compatible Hikvision AccessControl door-relay operation
- Safe Flow action for ending a ringing video-intercom call
- Persistent event-monitoring controls that do not interrupt video or snapshots
- Automatic reconnects and retention of the last valid snapshot during errors
- Privacy-safe diagnostics through **Repair device**

## Supported devices

The app uses one Homey camera driver for:

- Hikvision IP cameras
- Hikvision NVRs with up to sixteen online camera channels
- Compatible Hikvision video doorbells and door stations
- Compatible OEM devices exposing the same ISAPI and RTSP interfaces, including
  selected ABUS and Annke models

Support depends on the exact model, firmware, enabled services and permissions of
the local Hikvision account. Features are detected where possible, so unsupported
relays, channels or PTZ presets are not offered as valid Flow selections.

## Requirements

- Homey Pro running firmware 12.3.0 or newer
- A supported device reachable from Homey on the same local network
- A local Hikvision account with permission to view video and device events
- Door-control permission when using a relay action
- An H.264 RTSP profile for native Homey Live video
- **Notify Surveillance Center** enabled as linkage method for each required event

## Installation and pairing

1. Install the [current Test release](https://homey.app/en-us/app/nl.nobrainer.hikvision/Hikvision/test/).
2. In Homey, choose **Add device**, select **Hikvision**, then select the combined
   camera, doorbell and NVR driver.
3. Enter the local IP address or hostname, local username and password.
4. Use **Automatic** authentication unless the device specifically requires
   Digest-only or forced Basic authentication.
5. Use port `80` for HTTP or `443` for HTTPS unless the device is configured
   differently. The usual RTSP port is `554`.
6. Verify snapshots and Live video, then test the required event triggers.

HTTPS is preferred when the device supports it. Forced Basic authentication over
HTTP is not encrypted. Enable TLS certificate verification only when the device
uses a certificate trusted by Homey.

The Hikvision server port `8000` uses the proprietary HCNetSDK protocol and is not
a direct connection option in this app. ISAPI uses the configured HTTP/HTTPS port;
Live video uses the configured RTSP port.

## Live video and snapshots

Homey Live video requires H.264. Many Hikvision devices use H.265 for their main
stream, which cannot be sent directly to Homey WebRTC. In **Automatic** mode the
app inspects the available profiles and prefers a lower-resolution H.264
substream. Main-stream and substream selection can also be forced in device
settings.

For door stations with usable RTSP video but broken ISAPI support, **RTSP-only
mode** keeps Live video available. This mode intentionally disables snapshots,
events and ISAPI connection checks.

The app can expose snapshots for up to sixteen online NVR channels and keeps the
last valid image visible during a temporary camera error. The dashboard widget
adds digital zoom, panning and pinch gestures; this is client-side zoom and does
not move an optical PTZ lens.

## Events, status and Insights

Supported event triggers include:

- Video motion started and stopped
- Doorbell button pressed
- Local alarm input started and stopped
- Video signal lost and restored
- Camera tampering started and stopped
- Line crossing detected and ended
- Intrusion detected and ended
- Region entrance detected and ended
- Region exiting detected and ended
- Device connected, disconnected or reporting a connection error
- Event monitoring enabled or disabled

Motion, line-crossing, intrusion, region-entrance and region-exiting events activate
the standard Homey camera tile and its zone. The minimum active time is adjustable
from 1 to 300 seconds in device settings, which makes short Hikvision pulses easier
to use in Flows.

Separate Homey statuses, conditions and Insights are available for the supported
alarm types. NVR alarm state is aggregated across channels and remains active while
at least one channel still reports the event. A safety timeout ends events for NVRs
that send a start notification without the corresponding stop notification.

Motion, line-crossing, intrusion and doorbell triggers include a current snapshot
image tag where the device can provide one.

## Flow support

### When

- All start/stop events listed above
- Doorbell button pressed
- Connected, disconnected or connection error
- Event monitoring enabled or disabled

### And

- Connected
- Event monitoring enabled
- Local alarm active
- Video signal lost
- Line crossing active
- Intrusion active
- Region entrance active
- Region exiting active

### Then

- Take a snapshot from a selected camera or NVR channel
- Move a compatible PTZ camera relatively
- Stop PTZ movement safely
- Go to a stored PTZ preset
- Trigger a compatible door relay
- End the current ringing video-intercom call
- Enable or disable event monitoring

Available NVR channels, relays and stored PTZ presets are detected through ISAPI
and shown as Flow selections. Relay commands are rate-limited and only use a
detected, supported Hikvision AccessControl command.

## Video doorbells and door stations

Compatible door stations are handled as single-channel video devices. The
**The doorbell was pressed** trigger uses `CallButtonPress` from the ISAPI event
stream when the device supplies it. On supported video intercoms, the app can also
use the official call status and recognises `ring`, `ringing` and `calling` as an
active call. Debouncing prevents both sources from creating duplicate triggers.

Automatic authentication includes a bounded Hikvision web-session fallback for
compatible firmware that rejects regular Digest and Basic ISAPI authentication.
This addresses behaviour seen on some DS-KD8003 and DS-KV6113 door stations.

The **End current intercom call** action first verifies that the door station
advertises hang-up support and only sends the command while the call is ringing.
It therefore does not disable later Hik-Connect Live view or two-way audio. Support
still depends on the model and firmware.

## Event monitoring

Event monitoring can be enabled or disabled persistently from Advanced Flow. This
controls the ISAPI alarm stream and compatible doorbell polling inside Homey. It
does not change the Hikvision device configuration, and snapshots and Live video
remain available.

Some device accounts or firmware versions return HTTP 403 for the event stream.
This prevents alarm and doorbell events but does not prevent snapshots, the widget
or Live video from working.

## Troubleshooting

### Live video is black or only audio is available

- Set the Hikvision substream codec to H.264, not H.265/H.265+.
- Keep stream selection on **Automatic** first; otherwise explicitly select the
  H.264 substream.
- Confirm that RTSP is enabled and that the configured port is normally `554`.
- If snapshots also fail, verify the HTTP/HTTPS address, port and account rights.

### Snapshots work but events do not

- Enable **Notify Surveillance Center** for the event in the Hikvision settings.
- Confirm that the local account may access events.
- Check whether the device rejects the ISAPI event stream with HTTP 403.
- Do not enable RTSP-only mode when events or snapshots are required.

### A door station returns HTTP 401

- Use **Automatic** authentication first.
- Try HTTPS if it is enabled on the device.
- Only force Basic authentication when the model requires it, preferably over
  HTTPS.

### Temporary connection errors

The app reconnects automatically and retains the last valid snapshot. Persistent
problems should be reported with the privacy-safe diagnostic report described
below.

## Bug reports and privacy

Open the device in Homey, choose **Repair device**, then generate the privacy-safe
bug report. Review it before copying it to the
[support topic](https://community.homey.app/t/app-pro-test-hikvision-sdk-v3/157226).

The report includes the app version, detected device type and firmware, safe
settings and relevant connection, event, stream and call-control diagnostics. It
does **not** include passwords, usernames, IP addresses, hostnames, snapshots or
video.

Please mention the exact model and firmware, what you expected, what happened,
whether the device is connected directly or through an NVR, and the Flow card or
feature being tested.

## Migrating from the previous test app

The previous test app used ID `nl.nobrainerhomey.Hikvision`; the current app uses
`nl.nobrainer.hikvision`. Because Homey treats these as separate apps:

1. Install the current app and add the Hikvision devices again.
2. Recreate or update Flows that use the previous app.
3. Test devices, Live video, snapshots, widgets and Flows.
4. Remove the previous app only after the migration has been verified.

The previous test listing is planned to be withdrawn at the end of September 2026.
An existing installation will not be removed automatically, but it will no longer
receive updates.

## Development

```sh
npm install
npm run check
```

`npm run check` runs ESLint, the automated test suite and Homey publish-level
validation. Other useful commands are `npm test`, `npm run validate` and
`npm run build`.

Versions use `year.month.sequence`, for example `2026.9.5`.

## Contributing and support

- Use the [Homey Community topic](https://community.homey.app/t/app-pro-test-hikvision-sdk-v3/157226)
  for user support and model-specific testing feedback.
- Use GitHub Issues for reproducible code defects or focused technical proposals.
- Never publish camera passwords, public addresses, snapshots or video recordings
  in an issue or forum post.

## License and attribution

Licensed under [GPL-3.0-only](LICENSE).

This SDK v3 migration is derived from the GPL-3.0 licensed
[`com.hikvision`](https://github.com/JohanBendz/com.hikvision) app. See
[`NOTICE`](NOTICE) for attribution and additional provenance information.
