# abs-party

Synchronized audiobook listening for Audiobookshelf. Multiple people listen to the same book in real time: listeners share play, pause, and seek controls; the host can also change speed.

Each listener streams audio directly from their own Audiobookshelf account and their progress is saved there independently. The party server is a lightweight sync bus only but proxies requests to avoid CORS issues.


## How it works

Users authenticate with their Audiobookshelf credentials (username/password or API key). The host creates a room and picks a book from a searchable library browser. Guests join by room code. The host's playback controls are broadcast over WebSocket to all participants, who each have their own ABS playback session open.

Before joining, each participant's current position is saved as an ABS bookmark (`pre_party_<datetime>`), so they can return to exactly where they were if the session moves their progress.

Rooms are in-memory and ephemeral -- they disappear when the last participant leaves.


## Stack

- Backend: Rust (axum 0.7, tokio), single binary
- Frontend: Vue 3 + Vite SPA, served as static files from the same binary
- No database


## Book picker

When creating a room the host browses their ABS library. The picker supports:

- **Sort** by last listened, title (A–Z), or date added
- **Search** by title or author — uses the ABS server-side search API so results are not limited to the first page of items
- **Pagination** for browsed (non-search) results

Switching sort mode and typing in the search box are coordinated: the active sort applies to search results, and changing the sort re-runs the current search query.


## Mobile listening

The interface adapts to phone screens, with larger touch targets and collapsible
listeners, bookmarks, and room activity. Start playback with a tap before locking
the phone. If the browser blocks playback, use **Tap to listen** to join the
current room position. Use the phone's hardware buttons for volume; some mobile
browsers do not allow web pages to change system volume.

Where supported, the Media Session API supplies the book title, author, playback
position, and play/pause/skip controls to the lock screen and headphones. These
controls use the same shared room commands as the on-page buttons. Safari uses
native HLS when available; other browsers fall back to hls.js. Serve both ABS Party
and Audiobookshelf over HTTPS for phone use.

Temporary disconnections retain the listener's seat and room playback for 30
seconds. Reconnecting within that period restores the server's current position,
play/pause state, and speed without pausing everyone. A per-connection resume key
also handles network switches where the old socket has not closed yet. Choosing
**Leave**, or navigating away within the app, leaves immediately. After the grace
period, the existing behavior applies: leaving pauses the remaining listeners,
and an empty room is removed. If the creator reconnects after the room has expired,
the new room starts from that page’s local playback position.

Background audio and background synchronization have different limits. Browsers
and operating systems may suspend scripts or networking while locked, especially
after playback pauses. Returning to the page requests fresh room state. Media
Session integration does not guarantee that remote commands can wake a suspended
page, and closing the tab ends playback. Multi-file track transitions also need
real-device testing.

### Mobile verification before release

Run `npm test` and `npm run build` in `client`, and `cargo test --locked` in
`server`. Automated tests cover blocked playback, native HLS selection, multi-file
seeking, system control handlers, socket recovery, and room reconnection.

Physical-device verification is still required on both iPhone Safari and Android
Chrome, using a real Audiobookshelf server over HTTPS:

- Join as host and guest, tap to listen, then lock each phone for 10–15 minutes.
- Try lock-screen/headphone play, pause, and skip; check the other listener follows.
- Cross a file boundary while locked with both direct-play and HLS books.
- Pause remotely while locked, wait, then resume remotely; check for browser
  suspension and verify recovery on returning to the page.
- Switch between Wi-Fi and cellular, briefly disconnect, then return. Verify
  position and speed, no duplicate listeners, and no unintended group pause.
- Check portrait/landscape, a small phone, the software keyboard, seeking by touch,
  and scrolling past the player. Test calls or other audio interrupting playback.

## Security notes

All ABS REST calls from the browser go through the `/api/abs-proxy/*` route on the party server rather than directly to ABS. This avoids CORS issues and lets the server enforce an allowlist of permitted endpoints. Only read and session-management calls are forwarded; write/delete/admin paths are blocked.

Display names are taken from the ABS username and cannot be overridden. Two participants with the same ABS username cannot be in the same room simultaneously.


## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ABS_BASE_URL` | yes | `http://localhost:13378` | Base URL of your ABS instance, no trailing slash |
| `BIND` | no | `0.0.0.0:3456` | TCP address to listen on |
| `PORT` | no | -- | Alternative to BIND; sets port on `0.0.0.0` |
| `STATIC_DIR` | no | `./static` | Path to compiled Vue SPA files |
| `CORS_ORIGIN` | no | -- | Allowed cross-origin (e.g. `http://localhost:5173` for Vite dev). Omit in production. |
| `RUST_LOG` | no | -- | Log filter (e.g. `abs_party=info`) |
| `BYPASS_AUTH` | no | `0` | Set to `1` to skip ABS token validation. Never use in production. |

Copy `abs-party.env.example` and edit it before deploying.


## Docker with lima/nerdctl

Build and start:

```sh
lima nerdctl compose down
lima nerdctl compose build --no-cache
lima nerdctl compose up -d
lima nerdctl compose logs -f
```

The `down` step is required. Running `up` without it reuses the old container and silently ignores the new image.

`--no-cache` is needed when source files have changed between builds.

To set the ABS URL, either edit `docker-compose.yml` directly or create a `.env` file next to it:

```
ABS_BASE_URL=https://your-abs-instance.example.com
```


## Systemd (binary deployment)

Build the binary and Vue SPA manually, then install:

```sh
sudo useradd -r -s /sbin/nologin abs-party
sudo mkdir -p /opt/abs-party/static /etc/abs-party
sudo cp abs-party abs-party.env.example /opt/abs-party/
sudo cp abs-party.service /etc/systemd/system/
sudo cp abs-party.env.example /etc/abs-party/env
# edit /etc/abs-party/env
sudo systemctl daemon-reload
sudo systemctl enable --now abs-party
```

Logs: `journalctl -u abs-party -f`


## Development

Backend (requires Rust 1.85+):

```sh
cd server
cargo run
# or
cargo test
```

Frontend (runs on port 5173, proxies API calls to the backend on 3456):

```sh
cd client
npm install
npm run dev
```

Set `CORS_ORIGIN=http://localhost:5173` in the backend environment when running both separately.


## WebSocket protocol

The browser connects to `GET /ws`. All messages are JSON with a `type` field.

Client to server:

```
{ "type": "create_room", "abs_token": "...", "item_id": "...", "item_title": "...", "item_author": "...", "library_id": "..." }
{ "type": "join",        "abs_token": "...", "room_id": "abc12345" }
{ "type": "play",        "position": 1234.5 }
{ "type": "pause",       "position": 1234.5 }
{ "type": "seek",        "position": 1234.5 }
{ "type": "speed",       "rate": 1.25 }
{ "type": "ping",        "sent_at": 1719000000000 }
{ "type": "get_state" }
{ "type": "leave" }
```

Server to client:

```
{ "type": "room_state",        "room_id": "...", "item": {...}, "position": 0.0, "playing": false, "speed": 1.0, "participants": [...] }
{ "type": "play",              "position": 1234.5, "host_time": 1719000000000 }
{ "type": "pause",             "position": 1234.5 }
{ "type": "seek",              "position": 1234.5 }
{ "type": "speed",             "rate": 1.25 }
{ "type": "participant_joined","name": "alice" }
{ "type": "participant_left",  "name": "alice" }
{ "type": "host_changed",      "name": "alice" }
{ "type": "pong",              "sent_at": 1719000000000 }
{ "type": "error",             "message": "..." }
```

`create_room` and `join` optionally accept a `resume_key` UUID generated for that
page's connection. After ABS authentication, the same account and key can replace
its old connection. Other active duplicate logins are rejected. Keep this key
private to the page; it is not a room invite code.

`room_state.created` is true only for the response to creating a new room; other
snapshots set it to false. This lets the creator seed a new room from its own
progress without overwriting the position of an existing room.

`get_state` returns the current `room_state` (and a pending `play_intent`, if any)
without joining again. `leave` removes the listener immediately. A socket closing
without `leave` starts the 30-second reconnection grace period.

Any listener may send play intent, pause, or seek. Only the host may change speed.
