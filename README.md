# Caddy plugin for Ervisio

Manage the [Caddy](https://caddyserver.com) web server from [Ervisio](https://github.com/Ervisio/ervisio). It works
with Caddy installed on the system (caddy.service) and with Caddy in a Docker container, and finds both by itself.

* **Sites**: each site with what answers it and whether that answers, its HTTPS state, and a form to add or change
  reverse proxies, static sites, PHP sites and redirects. The form writes only the lines of the site it changes.
* **Caddyfile**: an editor with versions, formatting, `caddy validate`, and checks for backends and DNS. A change
  Caddy refuses is rolled back by itself.
* **Certificates**: time left, renewals and why they fail, the local root certificate.
* **Logs**: traffic of the last hour, who gets errors, and each request explained.
* An Overview widget.

## Install

In Ervisio, open Plugins › Browse, find Caddy and choose Install. The dialog lists the permissions below. The build
in the marketplace is signed by the Ervisio team.

## How it reaches Caddy

| Caddy runs… | Config | Reload | Certificates, logs |
|---|---|---|---|
| as caddy.service | read and written in `/etc/caddy` | `systemctl reload caddy.service` | `/var/lib/caddy/.local/share/caddy`, the journal, `/var/log/caddy` |
| in a container | read and written inside the container with `cat` and `sh` (works whether the Caddyfile is mounted or not) | `caddy reload` in the container | Caddy's data folder in the container, the container's output |

Before every save the plugin keeps the files as they are, writes the new ones, runs `caddy validate` and reloads. If
the check or the reload fails it writes the old files back. Versions live in `/var/lib/ervisio-caddy/history/system`
for the system service and in `~/.config/ervisio/plugins/caddy/history/` for containers (members of the docker group
manage those without administrator rights).

A site turned off stays in the Caddyfile as lines starting with `#ervisio:off `, so it comes back as it was.

Not supported: Caddy configured with JSON or `--resume`, caddy-docker-proxy (configured by labels), a system Caddyfile
outside `/etc/caddy`, and containers without a shell. The plugin says so instead of showing the editor.

## Permissions

The manifest is [plugin/manifest.json](plugin/manifest.json).

* **Commands as you**: `systemctl show caddy.service`, `caddy version`, `id -un` / `id -Gn` (your name for the
  history, and whether you are in the docker group), `test -S /var/run/docker.sock`, `journalctl -u caddy.service`
  (read and follow), `curl` to check that a backend answers (one request, 4 seconds) and to read the certificate a
  site presents on 127.0.0.1:443, `ip -j addr` and `ss -ltnH` (addresses for the DNS check, open ports as
  suggestions).
* **Commands with administrator rights** (the app asks to unlock): `systemctl start|stop|restart|reload
  caddy.service`, `caddy validate` on a file in `/etc/caddy` (with a scratch data folder in `/run`, so Caddy's storage
  is never touched), `journalctl` when your account cannot read the journal, `tail` of logs in `/var/log/caddy`.
* **Folders**: `/etc/caddy` and `/var/lib/ervisio-caddy` (read as you, written as administrator), Caddy's storage
  `/var/lib/caddy/.local/share/caddy` and `/var/log/caddy` (read as administrator), `~/.config/ervisio/plugins/caddy`
  (your settings and the history of containers).
* **Docker API** on `/var/run/docker.sock`: list and inspect containers, start/stop/restart, read their output, and
  run commands in them (exec), which the plugin uses to read and write a container's Caddyfile, check and reload it.
  Members of the docker group use it as themselves, other administrators unlock. Access to the Docker API is
  equivalent to root on the machine.
* **Network**: `cloudflare-dns.com`, for DNS over HTTPS (does a domain point to this server?).
* **Visible to** members of `wheel`, `sudo` and `docker` (administrators always see it).

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npm test            # Caddyfile parser and X.509 reader
npm run build       # typecheck, bundle to dist/caddy/index.js, copy plugin/* next to it
npm run dev         # rebuild on change
npm run pack        # dist/caddy-<version>.tar.gz and .sha256 (what a release publishes)
```

Turn on developer mode in Ervisio (`plugins.dev = true`, or a daemon started with `--dev`) and load `dist/caddy`
from Plugins › Developer; after a rebuild use "Reload" there.

A Caddy to try it with, in Docker:

```sh
docker network create caddytest
docker run -d --name whoami --network caddytest traefik/whoami
printf 'app.localhost {\n\treverse_proxy whoami:80\n}\n' > Caddyfile
docker run -d --name caddy --network caddytest -p 127.0.0.1:8443:443 -v "$PWD/Caddyfile:/etc/caddy/Caddyfile" caddy:2
```

## Releasing

1. Set the version in `plugin/manifest.json` and `package.json`, add a `## X.Y.Z` section to `CHANGELOG.md` (say
   when a release asks for new permissions, and why).
2. Commit, then `git tag -a vX.Y.Z -m "X.Y.Z" && git push origin vX.Y.Z`.
3. The release workflow builds, validates the manifest with Ervisio's own validator and publishes
   `caddy-X.Y.Z.tar.gz` and its `.sha256` (unsigned).
4. The Ervisio plugin registry, [Ervisio/plugins](https://github.com/Ervisio/plugins), picks the release up, a
   maintainer reviews it, and the registry signs it and lists it in the marketplace.
