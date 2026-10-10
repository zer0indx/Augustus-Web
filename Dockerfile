# syntax=docker/dockerfile:1
#
# Self-hosted Augustus Web: Augustus compiled to WebAssembly plus web/server.py.
# It contains no game files; see web/README.md.
#
#   docker compose up -d --build
#
# The wasm build stage always runs on the build machine's native architecture
# (the output is platform independent), so cross-building for ARM NAS boxes is cheap:
#   docker buildx build --platform linux/arm64 -t augustus-web .

# The version Augustus's own CI builds with (.ci_scripts/setup_environment.sh).
ARG EMSDK_VERSION=5.0.6

# ---------------------------------------------------------------- 1. compile Augustus to wasm
FROM --platform=$BUILDPLATFORM emscripten/emsdk:${EMSDK_VERSION} AS build
WORKDIR /src
COPY . .

# Drop -s SINGLE_FILE=1 so the wasm is a separate file the browser can stream-compile.
RUN sed -i -e 's/-s SINGLE_FILE=1//' -e 's/-s SINGLE_FILE_BINARY_ENCODE=0//' CMakeLists.txt

# Our own start page instead of the one CMake makes from gen/shell.html.in. It is put in
# place after the configure step: configure_file() would expand the ${...} in its script.
RUN emcmake cmake -S . -B build-web -DCMAKE_BUILD_TYPE=Release -DSYSTEM_LIBS=OFF -DTARGET_PLATFORM=emscripten \
 && cp web/shell.html res/shell.html \
 && cmake --build build-web -j "$(nproc)"

# ---------------------------------------------------------------- 2. runtime
FROM python:3.13-alpine
RUN adduser -D -u 1000 augustus \
 && mkdir /data /game \
 && chown augustus:augustus /data
COPY --from=build /src/build-web/augustus.html /src/build-web/augustus.js \
     /src/build-web/augustus.wasm /app/web/
COPY web/static /app/web/static
COPY res/augustus_256.png /app/web/static/
COPY web/server.py web/gamefiles.py web/login.html /app/
ENV AUGUSTUS_APP_DIR=/app/web \
    AUGUSTUS_DATA_DIR=/data \
    AUGUSTUS_GAME_DIR=/game \
    AUGUSTUS_PORT=8080 \
    PYTHONUNBUFFERED=1
USER augustus
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["python", "/app/server.py"]
