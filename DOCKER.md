# Docker

Run KhatamRouter in a container. Published image: [`ghcr.io/rqzbeh/khatamrouter`](https://github.com/rqzbeh/KhatamRouter/pkgs/container/khatamrouter) — multi-platform `linux/amd64` + `linux/arm64`. There is no Docker Hub image.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -p 20129:20129 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name khatamrouter \
  ghcr.io/rqzbeh/khatamrouter:latest
```

App listens on port `20128`. Open: http://localhost:20128

Port `20129` is exposed by the image but reserved for the Phase 2 Go gateway data plane; nothing serves traffic on it yet.

## Manage container

```bash
docker logs -f khatamrouter   # view logs
docker stop khatamrouter      # stop
docker start khatamrouter     # start again
docker rm -f khatamrouter     # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -p 20129:20129 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name khatamrouter \
  ghcr.io/rqzbeh/khatamrouter:latest
```

## Optional Headroom sidecar

The KhatamRouter image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point KhatamRouter at that proxy:

```yaml
services:
  khatamrouter:
    image: ghcr.io/rqzbeh/khatamrouter:latest
    ports:
      - "20128:20128"
      - "20129:20129"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use `http://host.docker.internal:8787` on macOS/Windows. On Linux, add `--add-host=host.docker.internal:host-gateway` or the equivalent compose `extra_hosts` entry.

## Update to latest

```bash
docker pull ghcr.io/rqzbeh/khatamrouter:latest
docker rm -f khatamrouter
# re-run the quick start command
```

To follow the newest master build instead of the last release, use the `edge` tag:

```bash
docker pull ghcr.io/rqzbeh/khatamrouter:edge
```

To pin a specific version instead of following `latest`, use a numbered image tag:

```bash
docker pull ghcr.io/rqzbeh/khatamrouter:0.1.0
```

---

# 🛠 For Developers

## Build image locally (test)

```bash
docker build -f Dockerfile.bun -t khatamrouter .

docker run --rm -p 20128:20128 -p 20129:20129 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  khatamrouter
```

Source builds use `Dockerfile.bun`, the same file CI publishes from. It pins `oven/bun:1.4.3-slim` and installs from the official Debian and npm registries.

## Publish (automatic via CI)

Merging to `master` (after the `Verify` workflow succeeds) publishes:

- `ghcr.io/rqzbeh/khatamrouter:edge`
- `ghcr.io/rqzbeh/khatamrouter:sha-<short>`

Pushing a semver git tag `vX.Y.Z` (or a prerelease such as `vX.Y.Z-rc.1`) builds `linux/amd64` and `linux/arm64` on native runners and publishes:

- `ghcr.io/rqzbeh/khatamrouter:X.Y.Z`
- `ghcr.io/rqzbeh/khatamrouter:X.Y` (moving major.minor alias)
- `ghcr.io/rqzbeh/khatamrouter:latest` (stable tags only)

The `v` prefix is used only for the git tag; image tags omit it. A prerelease tag such as `vX.Y.Z-rc.1` publishes its own numbered tag but is left out of the `latest` alias.

Tagged builds are checked after the manifest is assembled: the workflow boots the merged image on `linux/amd64`, polls `/dashboard` until it answers within 90 seconds, and asserts that the SQLite migrations ran. A failing boot check fails the publish.

```bash
# Use scripts/release.js (recommended)
node scripts/release.js "Release title" "Notes"

# Or manually
git tag v0.1.0 && git push origin v0.1.0
```

Numbered image tags are mutable because a republish can replace their manifest. For a deployment that must be immutable, pin the image digest instead:

```bash
docker pull ghcr.io/rqzbeh/khatamrouter@sha256:<verified-digest>
```

The workflow is tag- and merge-driven. Creating a git tag does not automatically create a GitHub Release, so the Releases page and the published image tags can be at different versions unless a maintainer creates a release separately.

Publishing uses the workflow's `GITHUB_TOKEN` with package write permission, so no Docker Hub secrets are needed. Forks can publish to their own GHCR namespace by changing `IMAGE_NAME`.

Workflow: `.github/workflows/docker-publish.yml`
