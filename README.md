# ![Lokal](https://i.imgur.com/O9SwX2c.png) <img src="public/lokal-icon.png" alt="lokal icon" width="115"> ![convient photo of toro](https://i.imgur.com/KgjwTvk.png)




**Your music, your files, a modern player.** Lokal is a local-first music player built with Electron and React, for people with big local libraries who want the polish of a streaming app without the subscription: word-by-word synced lyrics, official music videos synced to your files, new releases from the artists you follow, listening recaps, recommendations from Last.fm or YouTube Music, smart playlists, an audio-quality checker, and one search bar that finds, streams and downloads.

![Lokal Music](https://img.shields.io/badge/version-10.0.1-blue) ![Electron](https://img.shields.io/badge/Electron-latest-47848F) ![React](https://img.shields.io/badge/React-19-61DAFB) ![License](https://img.shields.io/badge/license-MIT-green) [![Discord](https://img.shields.io/badge/Discord-7289DA?logo=discord&logoColor=white)](https://discord.gg/Wv3zfpG6UT)

![Lokal's home page: mixes built from your listening, the song playing in the side panel, and its audio quality under the artist](docs/screenshots/home.webp)

<sub>Screenshots show a demo library: the artists, songs and artwork are made up.</sub>

---
## Before reading further, check the common links:

>Download the [latest up-to-date release.](https://github.com/sipbuu/lokal/releases/latest) Windows releases are code-signed through [SignPath Foundation](https://signpath.org/) (see the [code signing policy](#code-signing-policy)).

>If you are wondering why you have to create an account or other general questions, please [read the FAQ](./FAQ.md).

>Interested in creating TTML lyrics? Check out [our side TTML editor!](https://github.com/sipbuu/lokal-ttml)

>See [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) for known issues, and report any [issues/bugs](https://github.com/sipbuu/lokal/issues) you find.

>Read the [contribution guide](./CONTRIBUTING.md) if you'd like to help!
---

## Highlights

- **Synced lyrics from 9 sources**, word by word, with translation, romanization and duets
- **Music videos**: the official video of the song playing, found for you and kept in time with *your* file
- **New releases** from the artists you follow, with your follows imported from Spotify or Apple Music
- **One search bar** for your library, YouTube Music, SoundCloud, Soulseek and addons: stream, save or paste a link to download
- **Built-in Soulseek**: sign in with a username and password, nothing else to install
- **Listening recaps** for every week, month and year, with a story you can tap through
- **Audio quality checker** that sorts your files into Hi-res, Lossless, High and Low, spots fake FLACs, and upgrades a whole selection to lossless at once
- **Discovery, Mix and Radio** from your Last.fm or YouTube Music account, played from your library first, then from YouTube Music, SoundCloud or your addons
- **Smart playlists** that fill themselves from rules, and **share cards** for playlists, artists and recaps
- **Mixes, playlists and stats** built from your own listening history
- **Full-screen player** with moving canvas covers, a colour backdrop, a glass player bar, a mini player and crossfade
- **Playlists that keep up**: import from a link, a file or a pasted list, and link one to Spotify, Tidal, Apple Music or Qobuz to pull in what's added there
- **Account connections** for Last.fm, ListenBrainz, YouTube Music and Discord, plus a phone remote

---

## Synced Lyrics

![Full-screen lyrics lighting up word by word](docs/screenshots/lyrics.webp)

Lyrics light up **word by word** (or syllable by syllable) like Apple Music, in the side panel or full screen. Lokal asks every source at the same time and uses them in the order you set (drag to reorder, or turn sources off, in Settings → Playback). The first source with lyrics wins. With **Prioritize syllable lyrics** on, it keeps looking past line-timed lyrics for word-timed ones.

| Source | What it's good for |
|---|---|
| Local file | Lyrics embedded in the file, or a `.lrc` / `.ttml` next to it |
| BiniLyrics, BetterLyrics | Apple Music timings, word by word |
| BetterLyrics Portato | QQ Music karaoke timings |
| LyricsPlus | Syllable timings from community mirrors |
| Unison | Lyrics contributed by listeners |
| LRCLIB, KuGou | Whole lines; LRCLIB is reliably up, KuGou is strong outside English |
| lyrics.ovh | Plain-text fallback |

- **Translate** lyrics into your language (or turn on auto-translate), and see **romanization** for Japanese, Korean, Chinese and more.
- **Duets and background vocals** are laid out left and right, and background lines appear under the lead.
- **Pick another source** from the lyrics panel if the first match is wrong, or import your own `.lrc` / `.ttml` (make one with the [TTML editor](https://github.com/sipbuu/lokal-ttml)).
- **Lyrics are written into files you download**, so they come with the song.

---

## Music Videos

![The official music video of the playing song, full screen, with the player controls and the video sync control](docs/screenshots/music-video.webp)

Press the 🎬 button in the side panel (or in full screen) and the song's **official music video** plays, **in time with your own file**: Lokal listens to the video and to your song and lines them up, intros, skits and longer edits included. Your audio keeps playing; the video only adds the picture.

- **Only the real one:** the video must come from the artist and be the same song: no lyric videos, live cuts, covers, "visualizers" or still-image uploads (it checks that the picture actually moves).
- **Versions:** a remix or radio edit with no video of its own gets the original's video.
- **Video sync:** nudge the timing with − / + if it's ever off; Lokal remembers it for that video.
- **Around the picture:** when the video doesn't fill the screen, the bars continue its own colours instead of black.
- **Mini player:** keep the video playing in a small window while you use the rest of the app.
- **Music Video Quality** (Settings → Playback) caps the resolution, to save data or start faster.

| Your music videos | |
|---|---|
| ![The Videos page: a grid of music videos from the library, some saved and downloaded](docs/screenshots/videos.webp) | **Videos** (sidebar) lists every music video found for your library. Play them back to back, **save** the ones you like, or **download** them to your Videos folder to watch offline. *Find videos for my library* looks up the video of every song in one go. |

---

## Search, Stream and Download in One Place

| Search everything | Paste a link |
|---|---|
| ![Search results for "neon": albums and songs from the library](docs/screenshots/search.webp) | ![A pasted SoundCloud playlist link, ready to download](docs/screenshots/link.webp) |

The search bar at the top covers your own library, then songs that aren't in it yet:

- **Online results** from YouTube Music, SoundCloud, **Soulseek** (via slskd) and any **addons** you've added. Play them right away (streamed with your own yt-dlp, nothing is hosted by Lokal), add them to playlists, or save them to your library with one click. The saved file takes the stream's place in your likes and playlists.
- **Playlists and channels** from YouTube Music, downloadable whole.
- **Paste a link** (YouTube, SoundCloud, Bandcamp and anything else yt-dlp supports) and press Enter to download a song, an album or a whole playlist.
- **Downloads land in your library as they finish**, tagged, with a square cover and lyrics. No rescan needed. Choose the format (Original, MP3, M4A or Opus) in Settings → Library.
- **The Downloads button** (top left, next to Settings) shows the queue, the playlists you've downloaded, and library jobs (artist info, music videos) under **Others**. A download that fails says why in plain words ("TIDAL is limiting requests for now"), with the full message one click away (ⓘ). Downloads from addons are paced gently, two at a time per source, so you hit fewer rate limits.

<img src="docs/screenshots/downloads.webp" alt="The Downloads panel: a music video and a FLAC from Soulseek downloading, a failed addon download explained in plain words with the full error below, and a finished song" width="400">

(*yt-dlp is not included on install; see [Downloader Setup](#downloader-setup)*)

**Addons:** paste an addon's manifest URL in Settings → Addons. Lokal speaks the same addon protocol as Eclipse Music (manifest, `/search`, `/stream`, and `/album` / `/artist` pages when an addon has them), so those addons work as another source in search. It also runs **SpotiFLAC extensions**: add a repository to browse its sources, or install a `.sflx` package. Lokal ships no addons and doesn't host or vouch for any; you're responsible for the ones you add. (*[Ultramax](https://ultramax.vip/eclipse.html) and [LastWave](https://lastwaveaddons.clashprojects.qd.je/) have been tested and work; Tido requires whitelisting, so it isn't compatible.*)

**Soulseek:** search and download from Soulseek, where lossless FLAC files are common. Sign in with a Soulseek username and password in **Settings → Integrations → Soulseek** (a new name creates the account) and that's it: Lokal downloads the Soulseek client ([slskd](https://github.com/slskd/slskd)) once, checks it, runs it in the background on this computer only while Lokal is open, and **updates it** from the same place. Optionally share your music folder back. Soulseek is a sharing network and most of what's on it is copyrighted, so only download what you own.

<img src="docs/screenshots/soulseek.webp" alt="Settings → Soulseek: username and password, share my music folder, signed in, the Soulseek client's version and Check for updates" width="720">

---

## New Releases

![Home → Releases: the newest releases from followed artists, the two from this week marked New, with their type and date](docs/screenshots/releases.webp)

**Home → Releases** lists the newest albums, EPs and singles of the artists you follow, newest first, marked **New** for their first week. Play one, open it, or go to the artist. **Refresh** checks again and only adds what's new.

| Followed artists | |
|---|---|
| <img src="docs/screenshots/followed.webp" alt="The Followed artists dialog: every library artist with a checkbox, a search, Unfollow all, and Import from Spotify or Apple Music" width="420"> | **You choose who to follow.** *Followed artists* lists every artist in your library with a checkbox and a search; tick them one by one, or all at once. **Import** the artists you follow on **Spotify**, or the ones in your **Apple Music** library. Artist pages have a **Follow** button, and **Artists** can show only the ones you follow. Your library artists are followed on the first run, so nothing changes until you do. |

---

## Discovery, Mix and Radio

![Discovery on Home: Fresh Finds and Quick Picks from Last.fm, each song ready to play from the library](docs/screenshots/discovery.webp)

Home has five tabs: **Local** (mixes from your own library), **Discovery**, **Mix**, **Releases** (above) and **History** (everything you've played in Lokal).

**Discovery** shows recommendations from the account you pick at the top, **Last.fm** or **YouTube Music**:

| | Last.fm | YouTube Music |
|---|---|---|
| New music | **Fresh Finds**: songs similar to what you scrobble, and more from your artists | **Fresh Finds** from your YouTube Music home |
| Your favourites | **Quick Picks**: what you scrobbled most this week | **Likes**: your 30 latest liked songs |
| History | **Scrobble History**, grouped by day | **YouTube Music History** |
| Collections | **Albums For You** and **Artists For You** | **Mixed for you** (your "My Mix" playlists), **Artists For You** |

Click a song to play it; the rest of the shelf queues up behind it. Save Fresh Finds, Quick Picks or your Likes as a playlist, and download a song, an album or a whole YouTube Music mix to your library from its menu (right-click).

**Where songs play from:** a song you already have plays from your files. Otherwise Lokal looks for the *same* recording (same title and artist, never a cover or remix) in your **Playback Search Priority** (Settings → Integrations → Recommendations): YouTube Music first by default, then SoundCloud and any searchable addons, in the order you set. YouTube Music's own recommendations play their exact video, without searching. If a source only has a preview or can't play a song, the next one is tried, and if none can, the next song plays.

| Mix | |
|---|---|
| ![The Mix tab: a 24-track mix sampled from your recommendations](docs/screenshots/mix.webp) | **Mix** builds a 24, 32 or 40-track mix from a fresh sample of your recommendations. **Regenerate** for a new one; the last mix is kept until you do. Play it, or save it as a playlist.<br><br>**Radio** (*Start radio* on any song, *Start artist radio* or *Start album radio*) plays a station of related songs from YouTube Music's own radio and Last.fm's similar tracks; **Regenerate** for a new one. |

---

## Listening Recaps

| Every week, month and year | …and a story to tap through |
|---|---|
| ![The Recap page: a week's minutes, tracks, artists and peak hour](docs/screenshots/recap.webp) | ![The recap story: 7h 46m of music in one week](docs/screenshots/recap-story.webp) |

Lokal builds a recap from your own listening for every finished week (Monday to Sunday), every month and every year:
- minutes, tracks, artists and your peak listening hour
- top tracks, artists, albums and genres
- your **listening sessions**, named by what they were ("Late night listening", "Neon Harbor deep dive")

Play any recap, save it as a playlist, watch it as a **full-screen story**, or **share** it as a picture (see [Share cards](#smart-playlists-and-share-cards)). New recaps appear on their own when a week or month ends.

---

## Audio Quality

![The Audio Quality page: how much of the library is Hi-res, Lossless, High and Low, and the songs worth upgrading](docs/screenshots/quality.webp)

Know what you're actually listening to:

| Tier | Meaning |
|---|---|
| **Hi-res** | Above CD quality (lossless, more than 16-bit or 48 kHz) |
| **Lossless** | CD quality |
| **High** | Lossy at 256 kbps and up (160 kbps and up for Opus/Vorbis) |
| **Low** | Lossy below that |

- **Spectrum check:** looks at the spectrum of your lossless files to catch **fake FLACs**, ones converted from an MP3 (needs ffmpeg).
- **Worth upgrading:** lists your lossy and suspect files, lowest quality first.
- **Get it in lossless:** finds a better copy through MusicBrainz store links, Qobuz, Bandcamp, 7digital and Soulseek, with **Discogs** and **AllMusic** to check which releases exist.

  ![Get it in lossless: Qobuz, Bandcamp, 7digital, Discogs, AllMusic and Soulseek for one song](docs/screenshots/lossless.webp)

- **Many songs at once:** select songs (a whole album, a playlist), right-click → **Get N songs in lossless…**. Each one is looked up on your addon sources and the closest lossless copy is suggested, ticked when its length matches yours. **Replace** downloads the ticked ones, and each replaces its song's file **in place**, keeping its playlists, likes and plays.

  <img src="docs/screenshots/lossless-many.webp" alt="Get 7 songs in lossless: lossless matches for each song of an album, four ticked, one with a different length and one with an unknown length left for you to check" width="700">

- **Pill in the player bar:** the playing song's tier shows under the artist, and hovering says what it means.

---

## Your Library

| Library, filtered by genre | Albums |
|---|---|
| ![The Library filtered to Synthwave](docs/screenshots/library.webp) | ![An album page: compact header with Play, Shuffle and Full album online, the tracklist, and the playing song in the side panel](docs/screenshots/album.webp) |

| Artists | Playlists |
|---|---|
| ![An artist page with bio, popular songs and releases](docs/screenshots/artist.webp) | ![A playlist with its songs](docs/screenshots/playlist.webp) |

![The Library's column picker: track number, artwork, artist, source, quality, date added, duration and quick actions](docs/screenshots/columns.webp)

- **Library:** your music folder indexed from the files' own tags. Drum kits, sample packs and loops are filtered out, and you can opt out if something gets flagged by mistake (*via the minimum duration*). Filter by **source** (music folder, YouTube, SoundCloud, Soulseek, addons), **genre** and **quality**, and sort by date, title, artist, plays or length.
- **Track lists you can adjust:** pick the columns (track number, artwork, artist, source, quality, date added, duration, quick actions, drag handle) from **Columns**; the layout tightens on its own when the window gets narrow. An icon shows where a downloaded or streamed song came from (YouTube, SoundCloud, Soulseek, an addon), and playlists show each song's quality.
- **Albums:** albums, EPs and singles are kept apart; hover a cover to play the whole release. An album page shows its tracklist under a compact header, and **Full album online** fills in the songs you don't have (streamable, or downloadable one by one).
- **Online album and artist pages:** a streamed song, or an artist you only have a few songs of, still opens a real album or artist page (from YouTube Music or your addons), marking what's already in your library.
- **Artists:** each artist gets a page with a **photo and bio**, fetched automatically from **Wikidata**, Deezer, TheAudioDB, MusicBrainz or Wikipedia, or set by hand. *Auto* takes bios from Wikidata first (the artist's own Wikipedia article) and photos from Deezer first. Top songs and releases are on the same page, in sections, with a per-artist choice of release types. Names like "Tyler, the Creator" stay one artist. Switch the Artists page between **All** and **Followed**.
- **Playlists:** create, reorder, sort by any column, search, download, and get recommendations. **Import** one from a link (YouTube, YouTube Music, SoundCloud or Bandcamp playlists and albums), a file (Exportify CSV, JSON, M3U) or a pasted list of songs; songs you don't own come in as streamable ghost songs. **Link** a playlist to one on Spotify, Tidal, Apple Music or Qobuz and **Sync** adds the songs added there since (or at every launch).
- **Ghost songs:** songs of an imported playlist that aren't in your library yet stay in it as ghosts. They play from your sources, and the **Ghost songs** dialog finds each one and downloads them all, or the ones you pick.
- **Repair missing downloads** (Settings → Library → Maintenance): songs whose file went missing are downloaded again from where they came from and reattached, likes and plays included.
- **Select several songs** (or videos) with Ctrl/Cmd+click (Shift for a range) to queue, add to a playlist, upgrade to lossless or delete them all at once; the selection bar floats over the page and folds itself to fit.
- **Duplicate detection:** a smart merge scores each copy by bitrate, artwork and metadata completeness, then keeps the best one; duplicates are removed for good (a rescan doesn't bring them back), and **Remove Duplicate Songs** cleans one playlist.
- **Search by words:** the library matches title, artist and album together, and online results correct typos ("micheal jackson" finds Michael Jackson).

---

## Smart Playlists and Share Cards

| Smart playlists | Share cards |
|---|---|
| ![A smart playlist's rules: Synthwave from 2022 or later, in random order](docs/screenshots/smart.webp) | ![The share card for the Night Drive playlist](docs/screenshots/share.webp) |

- **Smart playlists** are made of rules instead of a list, and update themselves as your library and listening change: genre, artist, album, title, folder, year, date added, last played, plays, liked, length, quality and source. Match all or any of them, pick an order (random included) and an optional limit. A live count shows what the rules give before you save. Create one with the ✨ button next to Playlists.
- **Share cards** turn a playlist, an artist or a recap into one picture (1080×1350, the size social apps show in full) with its covers, numbers and top songs. Copy it or save it from the **Share** button.

---

## Mixes, Profile and Stats

![The profile page: plays, hours listened, likes and this week, top genres, top artists and tracks](docs/screenshots/profile.webp)

- **Mixes on Home** (the **Local** tab) are built from your history and likes: a Daily Mix, New Arrivals, Most Played and Discovery (songs you haven't played yet). Save any mix, or a suggested song, as a playlist.
- **History** (Home → History) shows what you played recently, streamed songs included.
- **Your profile** shows your total plays, hours listened, likes and this week's plays, plus your top genres, artists and tracks.

---

## Now Playing

![The full-screen player: the cover with its controls on hover, the seek bar, title, artist and album over a colour backdrop](docs/screenshots/fullscreen.webp)

- **Full-screen player** in the style of Apple Music: the cover with its controls, which hide when you stop moving the mouse, or full-screen lyrics; switch with one click. **Double-click the cover to like** the song. The computer doesn't go to sleep while it's open.
- **Side panel:** the song's details, lyrics and queue, with one row of buttons for full screen, lyrics, its music video and its canvas.
- **Canvas covers:** looping video covers from Apple Music, Tidal, community lists or Spotify Canvas (*Spotify needs your own account cookie*).
- **Colour backdrop** taken from the cover.
- **Glass player bar:** the player floats over the pages, which scroll on underneath it, frosted. Switch it off (or the waveform next to the volume) in Settings → Appearance → Player Bar.
- **Audio output picker** in the player bar, to send the music to another device (headphones, speakers, an interface).
- **Mini player** to keep the music in a corner.
- **Sleep timer.**
- **Crossfade** between tracks, with separate fade-in and fade-out times and a logarithmic or linear curve.
- **Queue:** play next and add to queue, with shuffle you can fully step back through.
- **Collapsible sidebar**, down to icons only.

---

## Casting

- **Cast to Google TV, Android TV, Chromecast and Nest speakers** with the Cast button next to the search box. Lokal finds them on your network (or add one by its IP address) and keeps the queue: shuffle, repeat, autoplay and the media keys all work as usual, and the TV moves to the next song with no gap.
- **Lossless on the TV:** FLAC up to 24-bit / 96 kHz goes as it is; Apple Lossless, AIFF, WMA and hi-res beyond the TV are converted once. Songs from YouTube, SoundCloud and addons play too.
- **Lokal on the TV:** now playing over the cover's colours, an Up Next row, synced lyrics and the music video. Choose in the Cast menu → On the TV.
- **Back to this computer** from the same menu: the song carries on here from the same moment.

How it works, and how to publish the TV app: [docs/CASTING.md](docs/CASTING.md).

---

## Integrations

![Account connections in Settings: Last.fm and ListenBrainz connected; YouTube Music and Discord connect from the desktop app](docs/screenshots/accounts.webp)

Everything is connected from **Settings → Integrations → Account Connections**:

- **Last.fm:** *Sign in*, then follow the numbered steps: create an API account, paste its key and secret, your username, and *Authorize* in the browser. Lokal sends "now playing" and scrobbles (after half the track or 4 minutes); scrobbles made offline are kept and sent later. Your account also powers Discovery, Mix and Radio.
- **ListenBrainz:** *Sign in* with your user token, for the open alternative by MetaBrainz. Same scrobbling rules, offline listens kept.
- **YouTube Music** (desktop app): *Sign in* opens YouTube Music in its own Lokal window; use the site's Sign in button. Lokal keeps the session (restored at every start) and uses it for Discovery, your mixes and likes, and to stream songs that need an account. *Verify* checks it's still valid.
- **Discord Rich Presence:** *Connect* to show what you're listening to ("Listening to…", with the album cover). Use the built-in app, or your own from Discord's developer portal (Settings → Integrations → Discord Rich Presence).
- **Scrobbling** has one switch per service (Settings → Integrations → Scrobbling), to pause it without signing out.
- **Phone remote:** built into the desktop app. Open **Settings → Phone Remote**, enable it, then scan the QR code or copy the LAN link. Your phone and computer must be on the same Wi-Fi; no `npm run dev:web` is needed.
- **Web mode:** run Lokal as a server and listen to your library from another device (see [Web Mode Setup](#web-mode-setup)).
- **Plugins:** install plugins from a folder in **Settings → Plugins**.
- **Backups:** full app export and import, play-history export, and track metadata import.

---

## Requirements

- [Node.js](https://nodejs.org/) v22.12+ (24 recommended, see `.nvmrc`)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): for downloading and streaming online songs (optional)
- [ffmpeg](https://ffmpeg.org/): for audio conversion and the spectrum check (optional)

---

## Getting Started

```bash
git clone https://github.com/sipbuu/lokal/
cd lokal
npm install
```

**Electron app (desktop):**
```bash
# rebuild sqlite3 for electron
npm run rebuild:electron

npm run dev
```

**Web mode (access from another device):**
```bash
# Copy .env.example to .env and set LOKAL_DATA_DIR to your Electron app's data folder
# copy .env.example .env (for windows)
cp .env.example .env


# rebuild sqlite3 for web
npm run rebuild:web

npm run dev:web
# Open http://localhost:3421
```

---

## Web Mode Setup

If you want to access your library from another device (e.g. devices on the go/laptops), run the web server on your home machine and point it at your existing Electron data:

1. Copy `.env.example` to `.env`
2. Set `LOKAL_DATA_DIR` to your data folder:
   - Windows: `C:\Users\<you>\AppData\Roaming\lokal-music\data`
   - macOS: `~/Library/Application Support/lokal-music/data`
   - Linux: `~/.config/lokal-music/data`
3. Optionally set `API_KEY` to a random string to protect remote access. Every `/api` request then needs it:
   - **In the web app:** it's asked once per browser and kept in a cookie.
   - **Other clients:** send it as an `x-api-key` header.
   - **Use HTTPS on any network you don't fully trust** (a reverse proxy or tunnel with TLS): plain HTTP sends the key unencrypted, so anyone on the same network could read it. With `API_KEY` set, plain HTTP is only accepted from this machine and your local network, and reaching Lokal from outside needs HTTPS.
4. Run `npm run dev:web`

---

## Downloader Setup

*Lokal will attempt an auto install, but if it fails, please refer to the following below*

The downloader requires `yt-dlp` and `ffmpeg` to be installed and available on your PATH:

- **yt-dlp:** https://github.com/yt-dlp/yt-dlp#installation
- **ffmpeg:** https://ffmpeg.org/download.html

On Windows, the easiest way is to drop both `.exe` files somewhere and add that folder to your PATH, or place them in the project root.

If Lokal still struggles to find your *ffmpeg* or *yt-dlp*, you can point to them manually in Settings as well.

YouTube often asks downloaders to "confirm you're not a bot". Signing in to YouTube Music in **Settings → Integrations → Account Connections** fixes that: streams and downloads then use your session. Signed in, yt-dlp needs a JavaScript runtime to read YouTube's audio links; Lokal gives it its own (Electron's Node), so there's nothing to install, and a [deno](https://deno.com/) you've installed is used first. Keep yt-dlp up to date (Settings → Integrations → External Tools): YouTube changes often.

---

## Project Structure

```
electron/         Electron main process
  ipc/            IPC handlers (scanner, downloader, recaps, discord, ...)
  lyrics/         Lyrics sources and the shared lyrics pipeline
  online/         Online search, streaming and addons
  quality/        Audio quality tiers and the spectrum check
  preload.js      Context bridge
server/           Express web server (web mode, phone remote)
  routes/         API routes
src/              React frontend
  components/     Reusable components
  pages/          Page components
  store/          Zustand state
```

---

## Built With (and much thanks to)

- [Electron](https://electronjs.org/)
- [React](https://react.dev/)
- [Vite](https://vitejs.dev/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [music-metadata](https://github.com/borewit/music-metadata)
- [Framer Motion](https://www.framer.com/motion/)
- [Tailwind CSS](https://tailwindcss.com/)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [slskd](https://github.com/slskd/slskd), run by Lokal for Soulseek
- Lyrics: [LRCLIB](https://lrclib.net/), BiniLyrics, BetterLyrics, LyricsPlus, Unison, KuGou and lyrics.ovh
- Artist info: [Wikidata](https://www.wikidata.org/), [MusicBrainz](https://musicbrainz.org/), [TheAudioDB](https://www.theaudiodb.com/), [Deezer](https://www.deezer.com/) and [Wikipedia](https://www.wikipedia.org/)
- Recommendations: [Last.fm](https://www.last.fm/) and [YouTube Music](https://music.youtube.com/)

---

## Code Signing Policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Official Windows releases are built from this repository's source by GitHub Actions. Only those builds are signed: never a file built on someone's own computer, and never third-party programs (yt-dlp, ffmpeg and slskd are not part of the installer).

**Team roles**

- Committers and reviewers: [sipbuu](https://github.com/sipbuu), [CHEYCKIT](https://github.com/CHEYCKIT)
- Approvers (who approve each signing request): [sipbuu](https://github.com/sipbuu)

Everyone with these roles signs in to GitHub with two-factor authentication.

**Privacy**

Lokal has no accounts, analytics or telemetry. Your library, listening history and settings stay on your computer. It only connects to other services for the features that need them:

- checking GitHub Releases for a new version (stable builds only);
- looking up lyrics, artwork, artist information, new releases and music videos (the services listed above under *Built With*);
- Last.fm, ListenBrainz, YouTube Music and Discord, if you connect them;
- searching, streaming and downloading, if you use those features.

---

## License

[MIT](https://opensource.org/license/mit)
