# Hearth ships as one image built in three stages:
#   1. build the React frontend into static files
#   2. compile the Go server into a single static binary
#   3. assemble a tiny runtime image with just the binary + built frontend
# The result runs from `docker compose up -d` and stores everything in /data.

# --- Stage 1: build the frontend ------------------------------------------
FROM node:24-alpine AS web
WORKDIR /web
# Install deps first (cached until the lockfile changes), then build.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Stage 2: build the Go server -----------------------------------------
FROM golang:1.26-alpine AS server
WORKDIR /src
# Download modules first for better layer caching.
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# CGO is off: the SQLite driver is pure Go, so we get a static, portable binary.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/hearth .

# --- Stage 3: runtime ------------------------------------------------------
FROM alpine:3.20
# tzdata lets us honour the TZ env var so "day" boundaries (streaks, seasons)
# match the couple's local time instead of UTC.
RUN apk add --no-cache tzdata
WORKDIR /app
COPY --from=server /out/hearth /app/hearth
COPY --from=web /web/dist /app/web

ENV HEARTH_ADDR=":3000" \
    HEARTH_DATA_DIR="/data" \
    HEARTH_WEB_DIR="/app/web"

# The data folder is the single source of truth; mark it as a volume so it is
# obvious it must be persisted (compose binds the host ./data over it).
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/app/hearth"]
