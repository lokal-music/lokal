# Casting

Lokal casts to Google TV, Android TV, Chromecast, Nest speakers and speaker
groups: the Cast button next to the search box's random button.

## How it works

- **Finding devices**: Lokal asks the network for Cast devices (mDNS,
  `_googlecast._tcp`) when the Cast menu first opens, not at start, so
  Windows doesn't ask about the firewall until casting is used. A device
  that isn't found (guest Wi-Fi, a VPN, a firewall in the way) can be added
  by its IP address from the menu; it's remembered.
- **Talking to the TV**: Lokal speaks the Cast protocol itself
  (`electron/cast/castv2.js`): TLS to port 8009, the receiver and media
  channels, plus Lokal's own channel `urn:x-cast:app.lokal.cast`.
- **The songs**: the TV fetches them from a small HTTP server on this
  computer (`electron/cast/mediaServer.js`), on a random port, at addresses
  with a random token and a random key per song. Files the TV can't play
  are converted once with ffmpeg into the cache (Settings → Data → Cache):
  lossless to FLAC (up to 24-bit / 96 kHz, or 16 / 48 with Settings →
  Playback → Casting → Cast Quality → Standard), the rest to AAC 256k. MP3,
  AAC, Opus, Vorbis, FLAC and WAV go as they are. Online songs (YouTube,
  SoundCloud, addons) are relayed, since their links only work for this
  computer.
- **Who owns what**: Lokal keeps the queue (order, shuffle, repeat,
  autoplay); the TV keeps the clock. The TV holds the playing song and the
  next three, so it moves on by itself with no gap; Lokal follows it and
  keeps that window filled (`electron/cast/controller.js`,
  `src/cast/useCastPlayback.js`). Repeat-one runs on the TV.
- **While casting** this computer's audio is parked; play, pause, seek,
  next, the volume slider and the media keys control the TV; listening time,
  Last.fm and ListenBrainz count as usual; the computer is kept awake.
- **Ending**: "This computer" in the Cast menu closes the app on the TV and
  carries on here from the same moment. If the TV is switched off, its app is
  closed, or the network drops for good (three reconnects), Lokal pauses here
  at the TV's position. Lokal restarted while the TV plays: picking the TV
  again joins what it's playing.

## The receiver (what the TV shows)

Two receivers:

1. **Lokal's** (`receiver/`): Now playing over the cover's colours, an
   Up Next row that slides up (a moment after a song starts, in its last
   20 seconds, while paused, or with the remote's ↓), synced lyrics, and the
   music video (Cast menu → On the TV). The remote's ← → switch views.
2. **Google's Default Media Receiver**: cover, title and progress. Used
   until Lokal's is registered, and whenever Lokal's can't start.

Working on the receiver: open `http://localhost:5173/receiver/preview.html`
from Lokal's dev server (`npm run dev`). It shows the page at a TV's size
with made-up songs and buttons for each state.

## Publishing Lokal's receiver (one time)

Done once by the owner of the main repository (lokal-music/Desktop), with their
GitHub and Google accounts: the receiver's address and the Cast developer
account both belong to the project, and every copy of Lokal then uses them.

1. **Host it.** In the GitHub repository: Settings → Pages → Source:
   **GitHub Actions**. Then Actions → **Cast receiver** → Run workflow (it
   also runs on every change to `receiver/` on `main`). The receiver is then
   at `https://<owner>.github.io/<repo>/receiver/`, so for Lokal:
   `https://lokal-music.github.io/Desktop/receiver/`. Open it in a browser
   once: a blank dark page is right (it only comes alive on a Cast device).
2. **Register it.** At the [Google Cast SDK Developer
   Console](https://cast.google.com/publish), sign in, pay the one-time
   US$5 fee, then **Add New Application → Custom Receiver**: name `Lokal`,
   Receiver Application URL: the address above. Save. The console shows the
   **Application ID** (8 characters, like `1A2B3C4D`).
3. **Try it on your TV** (an unpublished app only runs on registered
   devices). In the console: **Add New Device**, with the TV's serial number
   (Google TV: Settings → System → About → Serial number; Chromecast: on its
   box or in the Google Home app → device → Settings → Device information).
   Wait about 15 minutes, then restart the TV. Set the Application ID in
   `electron/cast/appId.js` (`LOKAL_CAST_APP_ID = '1A2B3C4D'`) and run Lokal
   from source. Cast to the TV: Lokal's receiver opens, and the Cast menu
   shows "Lokal on the TV".
4. **Publish it.** In the console, **Publish** the application (it reaches
   every device within about 15 minutes). Then release Lokal with the ID in
   `electron/cast/appId.js`, so every Lokal uses it with nothing to set.
   Lokal's own receiver is `2060B9B3`.

Changes to `receiver/` go live when the workflow publishes them; no need to
register again (the URL stays the same).

## After the repository transfer

The receiver now deploys to `https://lokal-music.github.io/Desktop/receiver/`.
GitHub repository redirects do not update the URL registered with Google Cast.

1. Enable **Settings → Pages → Source: GitHub Actions** in `lokal-music/Desktop`
   and run the **Cast receiver** workflow. Verify the new receiver URL loads.
2. In the Google Cast SDK Developer Console, edit the **existing** Lokal
   application `2060B9B3` and change its Receiver Application URL to that new
   address. Keep the application ID, publication and device registrations.
   Replacing the application would leave older installed clients using the old ID.
3. Cast from an existing and a new Lokal installation to verify that the receiver
   opens. Until the console is updated, clients still launch whichever URL
   Google has registered for `2060B9B3`; changing `appId.js` alone cannot move it.

## Changing the messages on Lokal's channel

One receiver page (GitHub Pages) serves every copy of Lokal, updated or
not, and a change to `receiver/` reaches every TV as soon as the workflow
publishes it. So the messages on `urn:x-cast:app.lokal.cast` (`upnext`,
`lyrics`, `video`, `view`, `hello`) carry a version:

- Every message Lokal sends has `protocol` (`CAST_PROTOCOL` in
  `electron/cast/controller.js`). A message without it is from a Lokal from
  before versions: the receiver treats it as version 1.
- The receiver's `hello` (on each connect) has its own `protocol`
  (`PROTOCOL` in `receiver/receiver.js`); Lokal keeps it as
  `receiverProtocol` in the cast status (`0`: a receiver from before
  versions, `null`: Google's receiver or no hello yet).

The rules:

- **Adding a field or a message type**: no new version. Both sides ignore
  what they don't know, so an older one simply goes without it.
- **Changing what a field or message means, or removing one**: raise the
  version on that side, and keep the receiver handling the old shape for
  messages with a lower `protocol` (Lokal that hasn't been updated). Lokal
  checks `receiverProtocol` before sending something only a newer receiver
  understands.
- Never rename a field in place.

## When something doesn't work

- **No devices in the menu**: the TV must be on the same network as this
  computer. Some routers keep devices apart ("AP isolation", "client
  isolation", guest networks); a VPN can too. Add the TV by its IP address
  (Google TV: Settings → Network & Internet → your Wi-Fi network).
- **The TV connects but nothing plays**: the TV fetches songs from this
  computer. On Windows, allow Lokal on **private networks** when the
  firewall asks (or in Windows Security → Firewall → Allow an app). The
  network must be set as private, not public.
- **A song is skipped with "Couldn't play"**: the TV refused it even after
  converting it, or an online song couldn't be fetched (e.g. one that is
  DRM-protected on SoundCloud).
- **Lyrics, Up Next and video are missing on the TV**: those come with
  Lokal's receiver; with Google's, the TV shows the cover and title only.
- Lokal's log (Settings → About → Debug Logs) has a `cast:` line for each
  step.
