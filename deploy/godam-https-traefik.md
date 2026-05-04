# GoDaam + Traefik + HTTPS (`godam.<your-domain>`)

Your browser shows **Not Secure** and/or **404** when:

1. **`https://godam...`** hits Traefik with **no router** to the GoDaam `web` container → **404**.
2. Traefik still serves the **default self-signed** cert → verification fails / **Not Secure**.
3. **`http://godam...:8080`** goes **straight to nginx** (Docker `8080→80`) — **Traefik is not in the path**, so there is **no TLS** (expected “not secure” for HTTP).

To get a **padlock** and **`https://godam...` without `:8080`**, Traefik must terminate TLS on **443** with **Let’s Encrypt**, and route that host to **`web:80`**.

---

## Prerequisites

- DNS **A** record: `godam` → VPS public IP (propagated).
- **Port 80** reachable on the VPS (HTTP-01 ACME challenge).
- Traefik container **publishes `80:80` and `443:443`** on the host (or equivalent).
- Traefik and GoDaam **`web`** share a **Docker network** (e.g. `web` or `traefik_public`).

---

## Traefik (static / command flags) — example only

Match names to **your** existing Traefik stack. Set ACME email via env on the server — **do not commit real emails to git**.

```yaml
command:
  - --providers.docker=true
  - --providers.docker.exposedbydefault=false
  - --entrypoints.web.address=:80
  - --entrypoints.web.http.redirections.entrypoint.to=websecure
  - --entrypoints.web.http.redirections.entrypoint.scheme=https
  - --entrypoints.websecure.address=:443
  - --certificatesresolvers.le.acme.email=${ACME_EMAIL}
  - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
  - --certificatesresolvers.le.acme.httpchallenge=true
  - --certificatesresolvers.le.acme.httpchallenge.entrypoint=web
ports:
  - "80:80"
  - "443:443"
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
  - ./letsencrypt:/letsencrypt
```

Resolver name here is **`le`** → labels must use `tls.certresolver=le`.

---

## GoDaam `web` service

1. **Stop publishing `8080:80`** on the host for `web` when Traefik fronts the site (otherwise you bypass Traefik and stay on plain HTTP for that URL).

   In this repo, **`docker-compose.hostinger.yml`** maps **`8080:80`** so GoDaam can coexist while another process uses **80**. When Traefik fully serves `godam...` on **80/443**, you typically **drop the hostinger override** or remove that `ports` block for `web`.

2. **Add Traefik labels** on `web` (service name in *this* repo is **`web`**, not `godaam-web`):

```yaml
labels:
  - traefik.enable=true
  - traefik.docker.network=YOUR_TRAEFIK_NETWORK_NAME
  - traefik.http.routers.godam.rule=Host(`godam.divadivya.cloud`)
  - traefik.http.routers.godam.entrypoints=websecure
  - traefik.http.routers.godam.tls.certresolver=le
  - traefik.http.services.godam.loadbalancer.server.port=80
networks:
  default:
  YOUR_TRAEFIK_NETWORK_NAME:
    external: true
```

Replace `YOUR_TRAEFIK_NETWORK_NAME` with the network Traefik uses (`docker network ls` on the VPS).

---

## Apply on the VPS (you run SSH locally)

```bash
ssh your-user@your-vps
cd /opt/godaam   # or your project path

cp docker-compose.yml docker-compose.yml.bak
# edit compose: Traefik 80/443, web labels + shared network, remove 8080 publish when ready

docker compose -f docker-compose.yml ... up -d
docker logs -f traefik-traefik-1 2>&1 | grep -i acme
```

Verify:

```bash
curl -sS https://godam.divadivya.cloud/api/health
./scripts/verify-godam-tls.sh godam.divadivya.cloud
```

---

## After HTTPS works

- Use **`https://godam.divadivya.cloud`** (no `:8080`) in the browser.
- Update **`godam-mobile`** defaults: `EXPO_PUBLIC_API_URL` / `app.config.js` / `app.json` → `https://godam.divadivya.cloud`, then rebuild the app.

---

## Gotchas

- **Port 80** must reach Traefik for HTTP-01 (`ss -tlnp | grep ':80'`).
- **DNS** must point at the VPS **before** ACME runs.
- **certresolver** name in labels **must** match Traefik’s `--certificatesresolvers.*` name (`le` vs `letsencrypt`).
