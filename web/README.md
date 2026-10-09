# Augustus Web

The web version of [Augustus](https://github.com/Keriew/augustus): the engine compiled to WebAssembly with Emscripten, a launcher page and a small Node.js server (`server.js`, no npm dependencies) packaged as one Docker image. It is meant for self-hosting, for example on a NAS, and playing from a browser.

No game files are included. The original **Caesar III** files (GOG, Steam or CD) are required.

## Features

- A sign-in page that keeps the game private when it is reachable from the internet.
- **Import Game Files**: copies the game files into the browser's storage (IndexedDB) once per browser.
- **Remove Game Files From Browser**: frees the browser storage without touching the saves on the server.
- **Download Saves** / **Upload Saves**: all saves as one ZIP (`.svx`, `.sav`, `.mapx`, `.map`).
- Saves live on the server: every save made in the game is sent to it, so they follow you to every browser you sign in from.
- Pixel-perfect rendering of the original fonts and graphics.

## Quick start

```bash
cp .env.example .env      # set your paths and password
docker compose up -d --build
```

Then open `http://<host-ip>:8080`.

The first build compiles the engine and takes several minutes. The wasm build stage runs on the build machine's native architecture, so cross-building for an ARM NAS is cheap:

```bash
docker buildx build --platform linux/arm64 -t augustus-web .
```

## Game file modes (`GAME_DATA_MODE`)

| Mode | Description |
|---|---|
| `server` *(default)* | The Caesar III files are in `GAME_DATA_PATH` on the host. The player presses **Import Game Files** and they are copied into the browser's storage once. |
| `upload` | Every player picks their own local folder or ZIP with the game: **Choose Game Folder** / **Import From Zip**. |

In both modes the saves are kept on the server, in `SAVES_PATH`.

## Settings (`.env`)

| Variable | Purpose |
|---|---|
| `GAME_DATA_MODE` | `server` or `upload` |
| `GAME_DATA_PATH` | The Caesar III folder on the host (the one with `c3.sg2`, `c3.eng`). Only read in `server` mode. |
| `SAVES_PATH` | Folder for saves on the host, e.g. `./saves` or `/volume1/docker/augustus/saves` |
| `AUGUSTUS_PORT` | Port on the host (default `8080`) |
| `AUTH_USER` | User name (optional; when empty only the password is asked) |
| `AUTH_PASSWORD` | Password. When empty the game opens without a sign-in page. |

If the game is reachable from the internet, set a strong `AUTH_PASSWORD` and put a reverse proxy with HTTPS in front of the port.

## Playing

1. **Sign in**: with `AUTH_PASSWORD` set, the browser shows the sign-in page first. The session lasts 30 days.
2. **First launch**: **Play** is disabled until the game files are imported. Press **Import Game Files** (or choose a folder or ZIP in `upload` mode); the files are stored in the browser's IndexedDB.
3. **Ready**: **Play** becomes active, together with **Download Saves**, **Upload Saves**, **Remove Game Files From Browser** and **Sign Out**.
4. **In the game**: every save is synced to the server. Fullscreen: `F11` or `Alt+Enter`.

## Layout

| Path | What it is |
|---|---|
| `web/shell.html.in` | The launcher page; replaces `gen/shell.html.in` during the Docker build |
| `web/launcher.js`, `web/launcher.css` | Launcher logic and style: importing game files, syncing saves, starting the engine |
| `web/login.html` | The sign-in page |
| `web/server.js` | The server: static files, sign-in, game files and saves API |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | The Docker service |

## License

Like Augustus itself, the web port is licensed under [AGPL-3.0](../LICENSE.txt).
