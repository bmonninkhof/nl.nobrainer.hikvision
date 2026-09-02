# Hikvision

Homey SDK v3-app voor lokale Hikvision IP-camera's en NVR's via ISAPI en RTSP.

## Functies

- Hikvision-camera's, videodeurbellen en NVR's toevoegen via HTTP of HTTPS
- Native Homey Live-video met voorkeur voor een compatibele H.264-substream en handmatige hoofd-/substreamkeuze
- Blijvende RTSP-only-modus voor deurstations zonder werkende ISAPI
- Dashboardwidget met digitale zoom, verschuiven, knijpgebaren en automatisch verversen
- Live alarmgebeurtenissen voor beweging, lokale ingang, videoverlies, sabotage,
  lijnoverschrijding, indringerdetectie en het betreden of verlaten van een gebied
- Aparte Flow-trigger wanneer een compatibele Hikvision-videodeurbel wordt ingedrukt
- Officiële ISAPI-oproepstatus als fallback voor video-intercoms die geen
  `CallButtonPress`-event versturen
- Afbeeldingstag met een actuele momentopname bij beweging, lijnoverschrijding,
  indringerdetectie en een deurbeloproep
- Advanced Flow-actie om een momentopname van een gekozen camera- of NVR-kanaal te maken
- Zichtbare Homey-alarmstatussen en Insights voor elk ondersteund alarmtype; bij
  een NVR blijft een status actief zolang minimaal één kanaal het alarm meldt
- Automatisch beëindigen van alarmstatussen wanneer een NVR geen stopmelding verstuurt
- Momentopnamen voor maximaal zestien online kanalen, met behoud van het laatste
  geldige beeld bij een tijdelijke camerafout
- Relatieve PTZ-bediening vanuit Advanced Flow
- Naar een opgeslagen PTZ-preset gaan vanuit Advanced Flow
- Een compatibel deurrelais bedienen via Hikvision AccessControl
- Een overgaande video-intercomoproep veilig beëindigen vanuit Advanced Flow
- Gebeurtenisbewaking in Homey blijvend in- en uitschakelen zonder Live-video of momentopnamen te stoppen
- Meertalige pairing en apparaatinstellingen
- Privacyveilig diagnose-/bugrapport via **Apparaat repareren**, zonder
  inloggegevens, netwerkadres, beelden of video

Schakel op het Hikvision-apparaat bij de gewenste gebeurtenis **Notify Surveillance
Center** in. De Homey Pro en het Hikvision-apparaat moeten elkaar op het lokale
netwerk kunnen bereiken. Live-video vereist een H.264-RTSP-stream; de app probeert
standaard eerst de substream. Alarmgebeurtenissen zijn optioneel en
kunnen ontbreken wanneer het camera-account of de firmware de eventstream blokkeert.
Deurbelondersteuning is afhankelijk van het model. De app gebruikt een
`CallButtonPress`-melding via de ISAPI-eventstream en controleert bij ondersteunde
video-intercoms daarnaast de officiële ISAPI-oproepstatus.

## Ontwikkeling

```sh
npm install
npm test
npm run validate
```

Versies volgen `jaar.maand.volgnummer`, bijvoorbeeld `2026.7.1`.

Deze migratie is afgeleid van de GPL-3.0-app
[`com.hikvision`](https://github.com/JohanBendz/com.hikvision).
Zie ook `NOTICE` en `LICENSE` voor herkomst en licentievoorwaarden.
