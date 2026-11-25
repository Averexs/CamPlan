# CamPlan

Self-hosted, web-based floor plan and camera placement tool. Import a PDF floor plan or draw one from scratch, add doors, doorways and windows, then drag cameras onto the plan and adjust their field of view. Works on desktop and tablets (iPad).

## Quick start (no clone needed)

Create a folder, save this as `docker-compose.yml`, then run `docker compose up -d`:

```yaml
services:
  camplan:
    image: ghcr.io/YOUR_GITHUB_USERNAME/camplan:latest
    container_name: camplan
    restart: unless-stopped
    ports:
      - "8080:3000"
    volumes:
      - ./plans:/data/plans
```

Open http://localhost:8080 (or http://SERVER-IP:8080 from a tablet). Projects are saved as JSON files in `./plans` next to the compose file.

Update to the newest version: `docker compose pull && docker compose up -d`

Images are built for amd64 and arm64 (Raspberry Pi, Apple Silicon, most NAS devices).

## Build from source

    git clone https://github.com/YOUR_GITHUB_USERNAME/camplan.git
    cd camplan
    # in docker-compose.yml, swap "image:" for "build: ."
    docker compose up -d --build

## Releasing a version

Bump `version` in `package.json`, then:

    git tag v1.0.0 && git push --tags

The GitHub Action publishes `ghcr.io/<owner>/camplan:1.0.0`, `:1.0` and `:latest`.
