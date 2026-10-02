# Changelog

## 1.0.0

First release. Manage Caddy from Ervisio, whether it runs as the system service (caddy.service) or in a Docker
container: the plugin finds every Caddy on the machine and lets you switch between them.

* Sites: every site of the Caddyfile and the files it imports, with what answers it (container, port, folder,
  redirect), whether that backend answers, and the state of its HTTPS certificate. Add, edit, turn off and delete sites
  with a form (reverse proxy, static files, PHP, redirect; compression, security headers, access log, password). The
  form rewrites only the lines of that site and shows them before saving.
* Caddyfile: editor with colours, format, check with `caddy validate`, the blocks of the file and checks (syntax,
  backends that do not answer, domains whose DNS points elsewhere). Every save keeps a version; any version can be
  restored. A change that Caddy refuses is rolled back by itself.
* Certificates: time left, issuer, renewal window, failed renewals explained (DNS, unreachable server, rate limit,
  CAA), Caddy's local root certificate.
* Logs: requests in the last hour, most visited paths, who gets errors, the stream with a plain explanation of failed
  requests, live.
* Overview widget with the sites and their backends.

Permissions: commands to read and control caddy.service and its journal, `caddy validate`, `curl` checks of backends
and certificates, `ip` and `ss`; the folders /etc/caddy, Caddy's storage and logs, /var/lib/ervisio-caddy; the Docker
API (containers, logs, exec) for Caddy in Docker, which is equivalent to root; DNS over HTTPS at cloudflare-dns.com.
See the README for each one and why.
