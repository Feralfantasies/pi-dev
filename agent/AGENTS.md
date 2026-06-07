# Project Instructions

- **Mandatory Web Search:** When implementing new features, using unfamiliar libraries, or calling external APIs, you MUST use the `web_search` tool to find the most up-to-date official documentation and code examples before writing any code.
- Do not rely solely on your internal training data for API syntax, use the web_read tool to fetch the raw markdown of relevant documentation pages before writing any code.
- If you encounter a bug or error, use the web search tool to look for community solutions or issue trackers.

## Workflow

### Commits & Pre-commit Hooks
- **Verify pre-commit success:** After every commit, check the output to confirm the pre-commit hook passed. If any hook step failed (fmt, clippy, tests, etc.), fix the reported issues before proceeding. This applies to ALL repositories.
- **Branch workflow:** Before making any changes to a repository, check out the `main` branch first, then create a new feature branch named `feature/{descriptive-name}`. All work must be done on the feature branch.
- **Protected main branch:** Never push changes directly to `main` under any circumstances. Changes should only reach `main` through a pull/merge request from a feature branch.
- **Verify push success:** After `git push`, read the output carefully to confirm refs were actually updated on the remote. A non-zero exit code means failure, but even exit code 0 can mean nothing was sent (e.g., `Everything up-to-date` when the branch doesn't exist remotely, or the branch wasn't created yet). If the output says `rejected`, `branch XYZ is not tracked`, or similar — fix the root cause and retry. Do not proceed assuming the push succeeded until you see the remote ref updated.

## Home Assistant

- **API Endpoint:** `http://192.168.1.40:8123/api`
- **Auth Token:** `HA_TOKEN` environment variable (defined in `~/.bashrc`)
- **Access:** Use `curl -H "Authorization: Bearer $HA_TOKEN" http://192.168.1.40:8123/api/...` for any Home Assistant queries (states, services, config, etc.)
- **Components:** MQTT, Roborock, MyEnergi, Reolink, Matter, and others

- **Traefik Debugging:** To diagnose routing or proxy issues, you can view Traefik's live computed state by running `curl -s http://192.168.1.2:8080/api/rawdata | jq`. Look for errors in the "routers" or "services" blocks.
- **Traefik Configuration:** When checking how traffic is routed into the cluster, inspect the desired state using `kubectl get ingressroutes,middlewares,traefikservices -A -o yaml`.

## Environment Context: Home Lab Infrastructure

### Kubernetes Cluster (K3s)

**4-node cluster** running on Proxmox VMs (`192.168.1.20`–`.23`):

| Node | IP | Role |
|------|-----|------|
| kube-1 | 192.168.1.20 | control-plane, etcd, master |
| kube-2 | 192.168.1.21 | control-plane, etcd, master |
| kube-3 | 192.168.1.22 | (worker) |
| kube-4 | 192.168.1.23 | (worker) |

**Host:** Proxmox host at `192.168.1.10` — use port-forward through jump box if needed.

**Config repo:** `/home/acleveland/kubernetes/` — contains YAML manifests and Helm values for all deployments. Some files may be outdated — always verify with `kubectl get` before assuming desired state matches live state.

### Traffic Architecture

Traffic enters via two Traefik layers:

1. **External Traefik** — dedicated VM at `192.168.1.2`, dashboard on `:8080`. Acts as the public-facing reverse proxy using Host headers, HTTP→HTTPS redirects, and TLS termination. Routes to either K3s services or bare-metal LAN services.
2. **K3s Ingress Traefik** — deployed in-cluster via K3s addon (LoadBalancer via MetalLB IP pool). Handles HTTP→HTTPS redirects and connects to Kubernetes IngressRoute CRDs.

**Traffic flow:** Public DNS → External Traefik (`192.168.1.2`, ports 80/443) → either:
- K3s internal Traefik (via kube-system LoadBalancer service at `10.43.7.27`) for managed services, or
- Direct to LAN hosts (Home Assistant on `192.168.1.40:8123`, TrueNAS/Jellyfin/Audiobookshelf/Garage on `192.168.1.120`, Proxmox on `192.168.1.10:8006`)

### Routers (External Traefik)

**From file provider (bare-metal/LAN routing):**

| Host | Entry | Backend |
|------|-------|---------|
| `audiobookshelf.feralfantasies.co.uk` | websecure | `192.168.1.120:30067` |
| `garage.feralfantasies.co.uk` | websecure | `192.168.1.120:30186` |
| `homeassist.feralfantasies.co.uk` | websecure | `192.168.1.40:8123` |
| `jellyfin.feralfantasies.co.uk` | websecure | `192.168.1.120:30013` |
| `proxmox.firethorn.feralfantasies.co.uk` | websecure | `192.168.1.10:8006` |
| `s3.larderly.net` / `s3-public.larderly.net` | websecure | `192.168.1.120:30188/30189` |
| `truenas.firethorn.feralfantasies.co.uk` | websecure | `192.168.1.120` |

**From kubernetescrd provider (in-cluster routing):**

| Host | Entry | Pod IP | Namespace |
|------|-------|--------|-----------|
| `cookbook.feralfantasies.co.uk` | websecure | `10.42.0.236:443` | default |
| `jellyfin-requests.feralfantasies.co.uk` | websecure | `10.42.0.234:443` | default (ombi) |
| `admin.foxyfabrications.co.uk` | websecure | `10.42.0.237:443` | foxy-fabrications-production |
| `foxyfabrications.co.uk` / `www.foxyfabrications.co.uk` | websecure | `10.42.2.249:443` | foxy-fabrications-production |
| `larderly.net` / `www.larderly.net` | websecure | `10.42.0.231:443` | larderly-production |
| `tavern.feralfantasies.co.uk` | websecure | `10.42.2.253:443` | sillytavern |
| `telegram-notifications.firethorn.feralfantasies.co.uk` | websecure | `10.42.2.248:443` | telegram-notifications |
| `wyrmspan.feralfantasies.co.uk` | websecure | `10.42.2.252:443` | wyrmspan |

**TCP Passthrough:** TLS-terminating services use TCP routers on `websecure` entrypoint — these preserve client certificates or require SNI-based routing.

### TLS / Certificates

Managed by **cert-manager** with four ClusterIssuers:
- `letsencrypt-production` (HTTP-01 challenge)
- `letsencrypt-production-dns` (DNS-01 via **Cloudflare API token**, stored via 1Password Connect in `cert-manager` namespace)
- `letsencrypt-staging` / `letsencrypt-staging-dns` (testing)

**Active certificates** (11 total, all using `letsencrypt-production-dns`):
- `cookbook.feralfantasies.co.uk`, `jellyfin-requests.feralfantasies.co.uk`, `wyrmspan.feralfantasies.co.uk` (default ns)
- `foxyfabrications.co.uk` + `admin.foxyfabrications.co.uk` (production + test namespaces)
- `larderly.net` (larderly-production)
- `tavern.feralfantasies.co.uk` (sillytavern)
- `telegram-notifications.firethorn.feralfantasies.co.uk`
- `foundry-feralfantisies` (default ns)
- `ombi` (default ns)

External Traefik also has its own ACME/DNS resolver (`le-dns`; Cloudflare) for hosts it terminates directly (Proxmox, Traefik dashboard, LAN services).

### Storage

| StorageClass | Provisioner | Use Case |
|---|---|---|
| `local-path` (default) | `rancher.io/local-path` | Ephemeral local storage |
| `nfs` | `k8s-sigs.io/nfs-subdir-external-provisioner` | Shared PVCs backed by TrueNAS NFS shares |
| `nfs-noac` | NFS with no attribute cache | Caches where stale NFS metadata is problematic |
| `truenas-iscsi` / `truenas-iscsi-raw` | Democratic CSI (iSCSI) | Block storage from TrueNAS |

**TrueNAS CSI:** Installed in `truenas-csi` namespace via Democratic CSI — config stored via 1Password Connect item. Node plugins on all 4 nodes, controller on kube-1.

**SMB CSI** also installed (`csi-smb-*` pods on all nodes) for SMB share access where needed.

### Secrets Management

All secrets (API keys, credentials, tokens, OCI registry passwords) stored in **1Password** vault `kubernetes`, injected via **1Password Connect** operator:

| Namespace | 1Password Items |
|---|---|
| `arc-runners` | `garage-github-runners`, `github-org-token` |
| `cert-manager` | Cloudflare API token (DNS-01 challenges) |
| `claude-code` | Claude API key, GitHub token |
| `default` | Factorio token, open-webui config, postgres password, factorio github token |
| `foxy-fabrications-production` | App credentials, hcaptcha keys, GHCR registry, MongoDB |
| `larderly-production` | GHCR, app secrets |
| `sillytavern` | HTTP basic auth credentials |
| `telegram-notifications` | Telegram bot token |
| `truenas-csi` | TrueNAS CSI config (creds for iSCSI/SMB) |

### CI/CD: GHA Enterprise Runner Controller (ARC)

GitHub-hosted **Arc systems** for self-hosted ephemeral runners:
- `arc-systems` namespace: `arc-gha-rs-controller` + `firethorn` listener service
- **AutoscalingRunnerSet** named `firethorn`: scales 0–12 ephemeral runners based on queued workflows. Currently at 0 (no pending workflows).
- **Cargo caching:** `nfs-noac` PVCs in `arc-runners` namespace for Cargo registry cache (prevents stale dependency downloads due to NFS attr cache)

### Active Namespaces Summary

| Namespace | Purpose | Key Services |
|---|---|---|
| `ai` | AI search tools | **SearXNG** (`:30601/TCP`) — used by Pi's web_search tool |
| `arc-systems` / `arc-runners` | GitHub Actions runners | ARC controller, autoscaling runners, cargo cache |
| `cert-manager` | TLS cert management | cert-manager + cainjector + webhook |
| `claude-code` | Claude Code API server | NodePort on `:30123` (exposed externally for remote coding) |
| `default` | Core services | **Home Assistant**, **ClamAV**, **Cookbook**, **Ombi**, **Open WebUI**, **Postgres**, **Factorio**, **Minecraft** |
| `foxy-fabrications-production` | Production web app | Main app + admin panel (NestJS + MongoDB) |
| `foxy-fabrications-test` | Staging/test web app | Same stack, separate instances |
| `larderly-production` | Personal food storage app | Larderly instance (`larderly.net`) |
| `onepassword` | 1Password Connect | Operator + Connect server (secrets injection) |
| `reloader` | Bitnami Contour Reloader | Auto-restarts pods on ConfigMap/Secret changes |
| `sillytavern` | AI roleplay/web UI | SillyTavern instance with basic auth |
| `telegram-notifications` | Telegram bot notifications | Bot for home automation alerts |
| `truenas-csi` | TrueNAS CSI driver | Democratic CSI controller + node plugins |
| `wyrmspan` | TTRPG character management | Wyrmspan API instance |
