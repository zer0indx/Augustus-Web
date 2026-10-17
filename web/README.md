# Augustus Web

The web version of [Augustus](https://github.com/Keriew/augustus): the engine compiled to WebAssembly with Emscripten, a start page and a small Python server (`server.py`, standard library only) packaged as one Docker image. It is meant for self-hosting, for example on a NAS, and playing from a browser.

No game files are included. The original **Caesar III** files (GOG, Steam or CD) are required.

## Features

- A sign-in page in front of everything: the game, the game files and the saves.
- **Import Game Files**: copies the game files into the browser's storage (IndexedDB) once per browser.
- **Update Game Files**: offered when the files on the server have changed; only the changed files are fetched.
- **Remove Game Files From Browser**: frees the browser storage without touching the saves on the server.
- Saves are synced with the server both ways, so a city started on one computer can be continued on another.
- **Download Saves** / **Upload Saves**: all saves as one ZIP, as a manual backup.
- Pixel-perfect rendering of the original fonts and graphics.

## Quick start

```bash
cp .env.example .env      # set your paths and AUGUSTUS_PASSWORD, at least 9 characters
docker compose up -d --build
```

Then open `http://<host-ip>:8080`.

The first build compiles the engine and takes several minutes. The wasm build stage runs on the build machine's native architecture, so cross-building for an ARM NAS is cheap:

```bash
docker buildx build --platform linux/arm64 -t augustus-web .
```

The GitHub workflow in `.github/workflows/docker.yml` publishes the image as `ghcr.io/zer0indx/augustus-web`: a `web-v1.2` git tag gives the image tags `1.2` and `latest`, a manual run gives `edge`. `docker compose up -d` without `--build` uses the published image when there is one.

## Settings (`.env`)

| Variable | Meaning |
|---|---|
| `AUGUSTUS_USER` | Sign-in name (default `caesar`) |
| `AUGUSTUS_PASSWORD` | Password, at least 9 characters. There is no default: the container does not start without one. Or `AUGUSTUS_PASSWORD_HASH`, made with `docker run --rm -it augustus-web python /app/server.py hash-password` |
| `AUGUSTUS_GAME_SOURCE` | `server` or `local`, see below (default `server`) |
| `AUGUSTUS_GAME_PATH` | The Caesar III folder on the host (the one with `c3.sg2`, `c3.eng`), mounted read-only at `/game`. Only read with `AUGUSTUS_GAME_SOURCE=server` |
| `AUGUSTUS_DATA_PATH` | Where `/data` lives: the saves, their older versions and the session secret. Not set: the Docker volume `augustus-data`. A path on the host (with a slash): that folder |
| `AUGUSTUS_HTTP_PORT` | Port on the host (default `8080`) |
| `AUGUSTUS_SESSION_DAYS` | How long a sign-in lasts (default 30) |
| `AUGUSTUS_TRUST_PROXY` | `1` when a reverse proxy is in front: the client address and scheme are taken from its `X-Forwarded-*` headers. `0` (default in `docker-compose.yml`) when browsers reach the port directly |

### Game files: two modes

- `AUGUSTUS_GAME_SOURCE=server`: the Caesar III files are in `AUGUSTUS_GAME_PATH` on the host. After signing in, **Import Game Files** copies them into that browser's storage, once. Nothing is downloaded before the button is pressed.
- `AUGUSTUS_GAME_SOURCE=local`: the server has no game files. Each browser picks a Caesar III folder on its own computer with **Choose Game Folder**.

Saves found in the game folder (`.sav`, `.svx`) are imported as your saves, unless the browser already has one of that name.

### Access

Everything except the sign-in page needs a session: the game, the game files and the API. There is one account and no default password.

- Five wrong passwords lock an address out for 30 seconds, doubling each time up to an hour. Sign-ins and failures are written to the container log.
- Sessions are signed cookies (`HttpOnly`, `SameSite=Strict`, `Secure` behind HTTPS). The signing key is created in the data volume on first start; deleting `session-secret` there and restarting signs everyone out.
- The page works over plain `http://` on a home network. If the game is reachable from the internet, put a reverse proxy with HTTPS in front of the port and set `AUGUSTUS_TRUST_PROXY=1`.

## Saves

Saves are stored in the data volume (`/data/saves`) and synced with the browser: on opening the page, right after the game writes a save, and every 20 seconds while the start page is open.

- What is synced is what the game writes into its folder and belongs to the player: saves (`.sav`, `.svx`), maps (`.map`, `.mapx`) and settings (`.ini`, `.inf`). Screenshots and logs stay in the running game and are gone when the page is closed.
- If a save was changed in two places, the newer one wins; the other is kept as an older version.
- The server keeps the last 5 versions of every save in `saves-history/` and moves deleted saves to `saves-trash/` for 30 days, so a mistake in one browser does not lose anything.
- While the game runs it only sends its own saves. If another browser changed them meanwhile, the game says so; reload the page to get them.
- **Download Saves** / **Upload Saves** still work as a manual backup.

Back up the data volume to back up the saves.

The container runs as user 1000. With `AUGUSTUS_DATA_PATH` set to a folder on the host, the saves are plain files in its `saves/` subfolder; make the folder writable and the game folder readable for that user, or set `user:` in `docker-compose.yml`.

### Coming from the Node.js server

Earlier versions of Augustus Web had a Node.js server with other variable names and kept the saves directly in `SAVES_PATH`.

| Before | Now |
|---|---|
| `AUTH_USER`, `AUTH_PASSWORD` | `AUGUSTUS_USER`, `AUGUSTUS_PASSWORD` |
| `GAME_DATA_MODE=server` / `upload` | `AUGUSTUS_GAME_SOURCE=server` / `local` |
| `GAME_DATA_PATH` | `AUGUSTUS_GAME_PATH` |
| `SAVES_PATH` | `AUGUSTUS_DATA_PATH`, optional. To bring your saves over, zip them and use **Upload Saves** on the start page, or set `AUGUSTUS_DATA_PATH` to a folder and put them into its `saves/` subfolder |
| `AUGUSTUS_PORT` | `AUGUSTUS_HTTP_PORT` |
| `TRUST_PROXY` | `AUGUSTUS_TRUST_PROXY` |

## Playing

1. **Sign in**: the browser shows the sign-in page first.
2. **First launch**: **Play** is disabled until the game files are imported. Press **Import Game Files** (or **Choose Game Folder** with the local game source); the files are stored in the browser's IndexedDB.
3. **Ready**: **Play** becomes active, together with **Download Saves**, **Upload Saves**, **Remove Game Files From Browser** and **Sign Out**.
4. **In the game**: every save is synced to the server. Fullscreen: `F11` or `Alt+Enter`.

## Layout

| Path | What it is |
|---|---|
| `web/shell.html` | The start page: importing game files, syncing saves, starting the engine. It replaces the page made from `gen/shell.html.in` during the Docker build |
| `web/login.html` | The sign-in page |
| `web/static/` | Background, stone tile and the Marcellus SC font (SIL Open Font License, see `MarcellusSC-OFL.txt`) |
| `web/server.py` | The server: sign-in, game files and the saves API |
| `web/gamefiles.py` | Which files of a Caesar III folder the browser needs |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | The Docker service |

Without Docker, with a web build of the engine in `build-web`:

```bash
AUGUSTUS_PASSWORD=... AUGUSTUS_APP_DIR=build-web AUGUSTUS_DATA_DIR=./data AUGUSTUS_GAME_DIR="/path/to/Caesar 3" AUGUSTUS_GAME_SOURCE=server python web/server.py
```

The pages and the server are shared with [eZeus Web](https://github.com/zer0indx/eZeus-Web) and [Akhenaten Web](https://github.com/zer0indx/Akhenaten-Web). `web/login.html` and `web/server.py` are the same there except for the theme and the "This game" block; in `web/shell.html` the markup, the style and the behaviour are the same, while the script keeps the game files and the saves in IndexedDB rather than OPFS, so the page also works over plain `http://`.

## License

Like Augustus itself, the web port is licensed under [AGPL-3.0](../LICENSE.txt).
