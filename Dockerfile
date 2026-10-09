# syntax=docker/dockerfile:1
#
# Self-hosted Augustus Web: Augustus compiled to WebAssembly plus web/server.js.
# It contains no game files; see web/README.md.
#
#   docker compose up -d --build
#
# The wasm build stage always runs on the build machine's native architecture
# (the output is platform independent), so cross-building for ARM NAS boxes is cheap:
#   docker buildx build --platform linux/arm64 -t augustus-web .

ARG EMSDK_VERSION=3.1.74
ARG NODE_VERSION=22-alpine

# ---------------------------------------------------------------- 1. compile Augustus to wasm
FROM --platform=$BUILDPLATFORM emscripten/emsdk:${EMSDK_VERSION} AS build
WORKDIR /src
COPY . .

# Our own HTML shell (launcher UI). CMake turns gen/shell.html.in into res/shell.html.
# Drop -s SINGLE_FILE=1 so the wasm is a separate file the browser can stream-compile.
RUN cp web/shell.html.in gen/shell.html.in \
 && sed -i -e 's/-s SINGLE_FILE=1//' -e 's/-s SINGLE_FILE_BINARY_ENCODE=0//' CMakeLists.txt

RUN emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release -DSYSTEM_LIBS=OFF -DTARGET_PLATFORM=emscripten \
 && cmake --build build-web -j "$(nproc)"

RUN mkdir /out \
 && cp build-web/augustus.js build-web/augustus.wasm /out/ \
 && cp build-web/augustus.html /out/index.html \
 && cp res/augustus_256.png /out/ \
 && (cat res/version.txt 2>/dev/null || echo unknown) > /out/version.txt

# ---------------------------------------------------------------- 2. JSZip (for zip uploads), served locally
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION} AS jszip
WORKDIR /j
RUN npm pack jszip@3.10.1 --silent && tar xzf jszip-3.10.1.tgz package/dist/jszip.min.js

# ---------------------------------------------------------------- 3. runtime
FROM node:${NODE_VERSION}
ENV NODE_ENV=production \
    PORT=8080 \
    GAME_DATA_MODE=server \
    GAMEDATA_DIR=/gamedata \
    SAVES_DIR=/saves \
    PUBLIC_DIR=/app/public

WORKDIR /app
COPY web/server.js ./server.js
COPY --from=build /out/ ./public/
COPY --from=jszip /j/package/dist/jszip.min.js ./public/
COPY web/launcher.js web/launcher.css web/login.html web/background.jpg web/pattern.webp ./public/

RUN mkdir -p /saves /gamedata
VOLUME ["/saves"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1

CMD ["node", "server.js"]
