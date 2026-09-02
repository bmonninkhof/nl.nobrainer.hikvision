# Hikvision SDK v3 for Homey Pro

[English](README.md) | [Nederlands](README.nl.md)

A Homey SDK v3 app for connecting compatible Hikvision IP cameras, video doorbells
and network video recorders over the local network using ISAPI and RTSP.

## Features

- Add Hikvision cameras, video doorbells and NVRs over HTTP or HTTPS
- Native Homey Live video, preferring a compatible H.264 substream, with manual
  main-stream and substream selection
- Persistent RTSP-only mode for door stations without working ISAPI support
- Dashboard widget with digital zoom, panning, pinch gestures and automatic refresh
- Live alarm events for motion, local input, video loss, tampering, line crossing,
  intrusion detection, region entrance and region exiting
- Dedicated Flow trigger when a compatible Hikvision video doorbell is pressed
- Official ISAPI call status as a fallback for video intercoms that do not send a
  `CallButtonPress` event
- Image tags containing a recent snapshot for motion, line crossing, intrusion and
  doorbell events
- Advanced Flow action for taking a snapshot from a selected camera or NVR channel
- Visible Homey alarm states and Insights for every supported alarm type; an NVR
  alarm remains active while at least one channel still reports it
- Automatic alarm-state reset for NVRs that do not send a stop event
- Snapshots for up to sixteen online channels, retaining the last valid image during
  temporary camera errors
- Relative PTZ control from Advanced Flow
- Recall saved PTZ presets from Advanced Flow
- Operate a compatible door relay through Hikvision AccessControl
- Safely end a ringing video-intercom call from Advanced Flow
- Persistently enable or disable Homey event monitoring without stopping Live video
  or snapshots
- Multilingual pairing and device settings
- Privacy-safe diagnostics and bug reports through **Repair device**, without login
  credentials, network addresses, images or video

Enable **Notify Surveillance Center** for the required events on the Hikvision
device. Homey Pro and the Hikvision device must be able to reach each other on the
local network. Live video requires an H.264 RTSP stream; by default, the app tries
the substream first. Alarm events are optional and may be unavailable when the
camera account or firmware blocks the event stream. Doorbell support depends on the
model. The app processes `CallButtonPress` notifications from the ISAPI event stream
and also checks the official ISAPI call status on supported video intercoms.

## Development

```sh
npm install
npm test
npm run validate
```

Versions use `year.month.sequence`, for example `2026.7.1`.

This migration is derived from the GPL-3.0 licensed
[`com.hikvision`](https://github.com/JohanBendz/com.hikvision).
See `NOTICE` and `LICENSE` for attribution and licensing details.
