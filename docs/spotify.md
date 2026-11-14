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

## Computer-webcam gestures

Install Python 3, `opencv-python`, and `mediapipe`, then ensure
`CV/models/hand_landmarker.task` exists. On Windows the host starts `py -3`; on
macOS/Linux it starts `python3`. Set `LIL_DEADLINE_PYTHON` to a Python executable
path if needed. Click **Start gestures** in the music card. The button explicitly
starts the local webcam process; **Stop gestures** closes it. A horizontal
two-finger pose moves between the five mirrored display slides. Slide navigation
and greeting work without Spotify; music gestures need a linked account. The
existing debounced CV gesture interpreter supplies fist
(play/pause), rotated open hand (next/previous), pointing-finger circle
(volume), and wave (greet) events. Only event names and volume deltas pass to
the Node host. The ESP32 MJPEG camera viewer is separate and cannot currently
be selected as the gesture camera.

If controls say no active device, start playback in Spotify first. If linking
fails, verify the port, `127.0.0.1` address, and exact Redirect URI in the
Spotify dashboard. If gestures fail to start, check Python dependencies,
computer webcam permissions, and whether another application is using the
camera. The music buttons remain available without CV.

See Spotify's [Redirect URI rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)
and [player endpoint reference](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback).
