# Hikvision SDK v3 voor Homey Pro

[English](README.md) | [Nederlands](README.nl.md)

Verbind compatibele Hikvision IP-camera's, videodeurbellen en
netwerkvideorecorders rechtstreeks via het lokale netwerk met Homey Pro. De app
gebruikt Hikvision ISAPI voor apparaatfuncties en gebeurtenissen en RTSP voor
video. Er is geen Hikvision-cloudaccount nodig.

- **App-ID:** `nl.nobrainer.hikvision`
- **Huidige testversie:** `2026.9.5`
- **Homey:** Homey Pro met firmware 12.3.0 of nieuwer
- **Installeren:** [Homey App Store Test](https://homey.app/nl-nl/app/nl.nobrainer.hikvision/Hikvision/test/)
- **Ondersteuning:** [Homey Community-topic](https://community.homey.app/t/app-pro-test-hikvision-sdk-v3/157226)

> [!IMPORTANT]
> Deze app vervangt de eerdere testapp `nl.nobrainerhomey.Hikvision`. Homey kan
> apparaten en Flows niet automatisch tussen verschillende app-ID's migreren. Zie
> [Migreren vanuit de vorige testapp](#migreren-vanuit-de-vorige-testapp).

## Belangrijkste functies

- Native Homey Live-video met automatische keuze van een compatibele H.264-stream
- Momentopnamen voor camera's, deurstations en maximaal zestien online NVR-kanalen
- Dashboardwidget met digitale zoom, verschuiven, knijpgebaren en automatisch verversen
- Bewegings-, deurbel- en slimme gebeurtenistriggers met afbeeldingstags
- Aparte alarmstatussen en Homey Insights voor ondersteunde gebeurtenistypen
- Relatieve PTZ-beweging, veilig stoppen en opgeslagen PTZ-presets
- Bediening van compatibele Hikvision AccessControl-deurrelais
- Veilige Flow-actie om een overgaande video-intercomoproep te beëindigen
- Blijvende bediening van gebeurtenisbewaking zonder video of momentopnamen te stoppen
- Automatisch opnieuw verbinden en behoud van het laatste geldige camerabeeld
- Privacyveilige diagnostiek via **Apparaat repareren**

## Ondersteunde apparaten

De app gebruikt één Homey-cameradriver voor:

- Hikvision IP-camera's
- Hikvision-NVR's met maximaal zestien online camerakanalen
- Compatibele Hikvision-videodeurbellen en deurstations
- Compatibele OEM-apparaten met dezelfde ISAPI- en RTSP-interfaces, waaronder
  geselecteerde modellen van ABUS en Annke

Ondersteuning hangt af van het exacte model, de firmware, ingeschakelde diensten
en rechten van het lokale Hikvision-account. Functies worden waar mogelijk
automatisch gedetecteerd, zodat niet-ondersteunde relais, kanalen of PTZ-presets
niet als geldige Flow-keuzes worden aangeboden.

## Vereisten

- Homey Pro met firmware 12.3.0 of nieuwer
- Een ondersteund apparaat dat voor Homey bereikbaar is op hetzelfde lokale netwerk
- Een lokaal Hikvision-account met rechten voor videoweergave en gebeurtenissen
- Rechten voor deurbediening wanneer de relaisactie wordt gebruikt
- Een H.264-RTSP-profiel voor native Homey Live-video
- **Notify Surveillance Center** als koppelingsmethode ingeschakeld voor elke gewenste gebeurtenis

## Installatie en koppelen

1. Installeer de [huidige testversie](https://homey.app/nl-nl/app/nl.nobrainer.hikvision/Hikvision/test/).
2. Kies in Homey **Apparaat toevoegen**, selecteer **Hikvision** en kies daarna de
   gecombineerde driver voor camera's, deurbellen en NVR's.
3. Vul het lokale IP-adres of de hostnaam, gebruikersnaam en het wachtwoord in.
4. Gebruik **Automatisch** als authenticatiemethode, tenzij het apparaat specifiek
   alleen Digest of geforceerde Basic-authenticatie nodig heeft.
5. Gebruik poort `80` voor HTTP of `443` voor HTTPS, tenzij het apparaat anders is
   ingesteld. De gebruikelijke RTSP-poort is `554`.
6. Controleer momentopnamen en Live-video en test daarna de gewenste gebeurtenistriggers.

HTTPS heeft de voorkeur wanneer het apparaat dit ondersteunt. Geforceerde
Basic-authenticatie via HTTP is niet versleuteld. Schakel TLS-certificaatcontrole
alleen in wanneer het apparaat een door Homey vertrouwd certificaat gebruikt.

De Hikvision-serverpoort `8000` gebruikt het gesloten HCNetSDK-protocol en is geen
rechtstreekse verbindingsoptie in deze app. ISAPI gebruikt de ingestelde
HTTP/HTTPS-poort; Live-video gebruikt de ingestelde RTSP-poort.

## Live-video en momentopnamen

Homey Live-video vereist H.264. Veel Hikvision-apparaten gebruiken H.265 voor de
hoofdstream; die kan niet rechtstreeks naar Homey WebRTC worden gestuurd. In de
stand **Automatisch** controleert de app de beschikbare profielen en kiest bij
voorkeur een H.264-substream met lagere resolutie. In de apparaatinstellingen kan
ook handmatig de hoofdstream of substream worden gekozen.

Voor deurstations met werkende RTSP-video maar defecte ISAPI-ondersteuning houdt
**Alleen RTSP gebruiken** de Live-video beschikbaar. Deze stand schakelt bewust
momentopnamen, gebeurtenissen en ISAPI-verbindingscontroles uit.

De app kan momentopnamen voor maximaal zestien online NVR-kanalen aanbieden en
behoudt het laatste geldige beeld tijdens een tijdelijke camerafout. De
dashboardwidget biedt digitale zoom, verschuiven en knijpgebaren. Dit is zoom op
het getoonde beeld en beweegt geen optische PTZ-lens.

## Gebeurtenissen, status en Insights

Ondersteunde gebeurtenistriggers zijn onder meer:

- Videobeweging gestart en gestopt
- Deurbelknop ingedrukt
- Lokaal alarm gestart en gestopt
- Videosignaal weggevallen en hersteld
- Camerasabotage gestart en gestopt
- Lijnoverschrijding gedetecteerd en beëindigd
- Indringing gedetecteerd en beëindigd
- Betreden van gebied gedetecteerd en beëindigd
- Verlaten van gebied gedetecteerd en beëindigd
- Apparaat verbonden, verbinding verbroken of verbindingsfout
- Gebeurtenisbewaking ingeschakeld of uitgeschakeld

Beweging, lijnoverschrijding, indringing en het betreden of verlaten van een gebied
activeren de standaard Homey-camerategel en de bijbehorende zone. De minimale
actieve tijd kan in de apparaatinstellingen van 1 tot 300 seconden worden
ingesteld. Hierdoor zijn korte Hikvision-detectiepulsen beter in Flows te gebruiken.

Voor de ondersteunde alarmtypen zijn aparte Homey-statussen, voorwaarden en
Insights beschikbaar. Bij een NVR wordt de alarmstatus van de kanalen samengevoegd
en blijft die actief zolang minimaal één kanaal de gebeurtenis meldt. Een
veiligheidstime-out beëindigt gebeurtenissen wanneer een NVR wel een startmelding,
maar geen bijbehorende stopmelding verstuurt.

Triggers voor beweging, lijnoverschrijding, indringing en de deurbel bevatten waar
mogelijk een actuele momentopname als afbeeldingstag.

## Flow-ondersteuning

### Als

- Alle hierboven genoemde start- en stopgebeurtenissen
- Deurbelknop ingedrukt
- Verbonden, verbinding verbroken of verbindingsfout
- Gebeurtenisbewaking ingeschakeld of uitgeschakeld

### En

- Verbonden
- Gebeurtenisbewaking ingeschakeld
- Lokaal alarm actief
- Videosignaal weggevallen
- Lijnoverschrijding actief
- Indringing actief
- Gebied betreden actief
- Gebied verlaten actief

### Dan

- Een momentopname maken van een gekozen camera- of NVR-kanaal
- Een compatibele PTZ-camera relatief bewegen
- PTZ-beweging veilig stoppen
- Naar een opgeslagen PTZ-preset gaan
- Een compatibel deurrelais schakelen
- De huidige overgaande video-intercomoproep beëindigen
- Gebeurtenisbewaking inschakelen of uitschakelen

Beschikbare NVR-kanalen, relais en opgeslagen PTZ-presets worden via ISAPI
gedetecteerd en als Flow-keuzes getoond. Relaisopdrachten zijn begrensd tegen snel
herhalen en gebruiken alleen een gedetecteerde, ondersteunde Hikvision
AccessControl-opdracht.

## Videodeurbellen en deurstations

Compatibele deurstations worden als videoapparaten met één kanaal behandeld. De
trigger **De deurbel is ingedrukt** gebruikt `CallButtonPress` uit de
ISAPI-gebeurtenisstream wanneer het apparaat dit verstuurt. Bij ondersteunde
video-intercoms kan de app daarnaast de officiële oproepstatus gebruiken en worden
`ring`, `ringing` en `calling` als actieve oproep herkend. Debouncing voorkomt dat
beide bronnen dubbele triggers veroorzaken.

Automatische authenticatie bevat een begrensde Hikvision-websessie-fallback voor
compatibele firmware die normale Digest- en Basic-ISAPI-authenticatie weigert. Dit
is bedoeld voor het gedrag dat bij sommige DS-KD8003- en DS-KV6113-deurstations is
waargenomen.

De actie **Beëindig huidige intercomoproep** controleert eerst of het deurstation
ondersteuning voor ophangen meldt en verzendt de opdracht alleen terwijl de oproep
overgaat. Hierdoor blijven later Live-weergave en tweerichtingsaudio in Hik-Connect
beschikbaar. Ondersteuning blijft afhankelijk van model en firmware.

## Gebeurtenisbewaking

Gebeurtenisbewaking kan blijvend vanuit Advanced Flow worden in- of uitgeschakeld.
Dit bestuurt de ISAPI-alarmstream en compatibele deurbelcontrole binnen Homey. Het
wijzigt de configuratie van het Hikvision-apparaat niet; momentopnamen en Live-video
blijven beschikbaar.

Sommige accounts of firmwareversies geven HTTP 403 terug voor de
gebeurtenisstream. Daardoor werken alarm- en deurbelgebeurtenissen niet, maar
momentopnamen, de widget en Live-video blijven wel functioneren.

## Problemen oplossen

### Live-video is zwart of alleen audio werkt

- Stel de codec van de Hikvision-substream in op H.264, niet H.265/H.265+.
- Gebruik eerst **Automatisch**; kies anders expliciet de H.264-substream.
- Controleer of RTSP is ingeschakeld en of de ingestelde poort normaal `554` is.
- Controleer bij ontbrekende momentopnamen ook adres, HTTP/HTTPS-poort en accountrechten.

### Momentopnamen werken, maar gebeurtenissen niet

- Schakel **Notify Surveillance Center** in bij de gebeurtenis in Hikvision.
- Controleer of het lokale account gebeurtenissen mag lezen.
- Controleer of het apparaat de ISAPI-gebeurtenisstream met HTTP 403 weigert.
- Gebruik de RTSP-only-stand niet wanneer gebeurtenissen of momentopnamen nodig zijn.

### Een deurstation geeft HTTP 401

- Gebruik eerst **Automatisch** als authenticatiemethode.
- Probeer HTTPS wanneer dit op het apparaat is ingeschakeld.
- Forceer Basic alleen wanneer het model dit nodig heeft, bij voorkeur via HTTPS.

### Tijdelijke verbindingsfouten

De app verbindt automatisch opnieuw en behoudt het laatste geldige camerabeeld.
Meld blijvende problemen met het onderstaande privacyveilige diagnoserapport.

## Bugrapporten en privacy

Open het apparaat in Homey, kies **Apparaat repareren** en maak daar het
privacyveilige bugrapport. Controleer het rapport voordat je het naar het
[supporttopic](https://community.homey.app/t/app-pro-test-hikvision-sdk-v3/157226)
kopieert.

Het rapport bevat de appversie, het gedetecteerde apparaattype en firmware, veilige
instellingen en relevante diagnose over verbindingen, gebeurtenissen, streams en
oproepbediening. Het bevat **geen** wachtwoorden, gebruikersnamen, IP-adressen,
hostnamen, momentopnamen of video.

Vermeld het exacte model en de firmware, het verwachte en werkelijke gedrag, of het
apparaat rechtstreeks of via een NVR is verbonden en welke Flow-kaart of functie
werd getest.

## Migreren vanuit de vorige testapp

De vorige testapp gebruikte ID `nl.nobrainerhomey.Hikvision`; de huidige app
gebruikt `nl.nobrainer.hikvision`. Homey behandelt deze als aparte apps:

1. Installeer de huidige app en voeg de Hikvision-apparaten opnieuw toe.
2. Maak Flows van de vorige app opnieuw of pas ze aan.
3. Test apparaten, Live-video, momentopnamen, widgets en Flows.
4. Verwijder de vorige app pas nadat de migratie is gecontroleerd.

De vorige testvermelding wordt naar verwachting eind september 2026 ingetrokken.
Een bestaande installatie wordt niet automatisch verwijderd, maar ontvangt daarna
geen updates meer.

## Ontwikkeling

```sh
npm install
npm run check
```

`npm run check` voert ESLint, de geautomatiseerde tests en Homey-validatie op
publicatieniveau uit. Andere bruikbare opdrachten zijn `npm test`,
`npm run validate` en `npm run build`.

Versies volgen `jaar.maand.volgnummer`, bijvoorbeeld `2026.9.5`.

## Bijdragen en ondersteuning

- Gebruik het [Homey Community-topic](https://community.homey.app/t/app-pro-test-hikvision-sdk-v3/157226)
  voor gebruikersondersteuning en tests met specifieke modellen.
- Gebruik GitHub Issues voor reproduceerbare codeproblemen of gerichte technische voorstellen.
- Publiceer nooit camerawachtwoorden, openbare adressen, momentopnamen of video in
  een issue of forumbericht.

## Licentie en herkomst

Uitgebracht onder [GPL-3.0-only](LICENSE).

Deze SDK v3-migratie is afgeleid van de GPL-3.0-app
[`com.hikvision`](https://github.com/JohanBendz/com.hikvision). Zie
[`NOTICE`](NOTICE) voor naamsvermelding en aanvullende informatie over de herkomst.
