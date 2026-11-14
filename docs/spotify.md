# Spotify playback setup

1. Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Register `http://127.0.0.1:3210/api/spotify/callback` as a Redirect URI. Use
   your actual `LIL_DEADLINE_PORT` if it differs from 3210. Spotify requires the
   full callback path to match; use `127.0.0.1` rather than `localhost`.
3. Start Lil Deadline and open `http://127.0.0.1:3210`. In **Settings → Spotify
   music**, enter the 32-character **Client ID** and save. Click **Link Spotify
   account** and grant playback access.
4. Open Spotify on a computer, phone, or another Spotify Connect device and
   start a track. The dashboard can then show the track and control play/pause,
   previous/next, and volume if that device supports volume control.

Spotify Premium is required for playback controls. A development-mode app's
owner must have Premium; additional test users must be added in the Spotify app
dashboard. Lil Deadline requests only `user-read-playback-state` and
`user-modify-playback-state`. It uses [authorization code with
PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow):
the browser receives an authorization URL, while the verifier and access/refresh
tokens remain in the local Node host. The Client ID is public; **no client
secret or API key is needed**. Do not paste tokens into chat or source files.

The dashboard controls an existing Spotify playback device through the
[Spotify Web API](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback).
It does not download tracks, stream music into the browser, or send audio to
the ESP32. Spotify and Internet access are optional; the pet, tasks, and ESP32
display continue to work without them.

The **Music** display slide shows the current song's album cover above its title
and artist, in both the browser preview and the mirrored ESP32 frame. Select it
with the display's previous/next slide buttons or the two-finger gesture. Covers
update with the existing playback refresh (normally within 10 seconds), and
remain visible while paused. Missing or failed artwork shows a music note.

The host uses `item.album.images` from Spotify's
[playback response](https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback).
It keeps just the current image in memory and serves it through a local route so
the canvas remains readable for RGB565 uploads. Image downloads have a size
limit and timeout, use Spotify's image CDN without OAuth headers, and never run
on the ESP32. No additional Spotify permissions or firmware changes are needed.
The artwork retains its aspect ratio; the RGB565 display has reduced color precision.
The white logo in `public/spotify-logo.svg` is from Spotify's official
[brand assets](https://developer.spotify.com/documentation/design).

## ESP32 camera gestures

Click **Start gestures** in the music card or Camera page. Hand detection uses
the ESP32 live feed and runs on your computer. The preview and detector share
one authenticated connection; neither opens the computer webcam. Stopping
gestures releases its subscription, while an open preview can continue.

Two fingers pointing left/right change display slides, a fist toggles playback,
a rotated open hand skips tracks, a pointing-finger circle adjusts volume, and
a wave greets Sprout. Directions follow the unmirrored camera preview. Hold
poses briefly (two frames); move circles and waves slowly enough for the
camera's target 5 fps. Navigation and greeting work without Spotify.

See [camera and gesture setup](camera.md) for Python installation, higher native
resolution, and firmware update instructions. If controls say no active device,
start playback in Spotify. Music buttons remain available without gestures.

See Spotify's [Redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
and [player endpoint reference](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).
