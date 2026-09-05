# Splunk HEC ingest — setup guide (end-user view)

How to get metric/event data **into** this Splunk deployment over HEC, and how the
network path (DNS, TLS, reverse proxy) is wired so that clients — local, on-LAN, or
remote — all use one stable URL. Written from the as-built setup of this deployment
(verified 2026-08-18); follow it to reproduce the setup elsewhere.

## Topology (as built)

```
┌─────────────────────────────┐
│ Exporter (e.g. spark-dashboard) │
│ POST https://splunk-hec.pjeffery.net/services/collector/event
│      Authorization: Splunk <HEC token>
└──────────────┬──────────────┘
               │  (internet or LAN)
┌──────────────▼──────────────┐
│ Edge proxy box 192.168.1.69 │   Caddy
│  • TLS termination: Let's Encrypt wildcard *.pjeffery.net (DNS-01)
│  • reverse_proxy → 192.168.1.224:8088 (TLS, verify skipped)
│  • no auth of its own on this path — HEC authenticates
└──────────────┬──────────────┘
               │  LAN only
┌──────────────▼──────────────┐
│ Splunk host 192.168.1.224   │   serverName = splunk-ai
│  • 8088  HEC (HTTPS, Splunk default self-signed cert)
│  • 8089  management port (keep private)
│  • 8000  web UI (admin)
│  • index: ai-perf (datatype = metric)
└─────────────────────────────┘
```

One public name (`splunk-hec.pjeffery.net`) → one proxy → one HEC endpoint. Clients
never see the Splunk host, its self-signed cert, or its real IP.

**Verified today:** `https://splunk-hec.pjeffery.net/services/collector/health` →
`200 {"text":"HEC is healthy","code":17}`; public cert is `CN=*.pjeffery.net` issued by
Let's Encrypt (YR1). The HEC `/health` sub-endpoint needs **no token** — use it as the
canary for the whole path before debugging tokens.

---

## 1. Splunk side (admin, on the Splunk host)

### 1.1 HEC on port 8088

This Splunk serves HEC on **8088** (its own port, separate from the 8089 management
port). In `etc/apps/splunk_httpinput/local/inputs.conf`:

```ini
[http]
disabled = 0
enableSSL = 1          ; HEC speaks TLS on 8088 (Splunk default cert)
```

> **Do not send HEC to 8089.** The management port answers `/services/collector` with
> `401 XML "call not properly authenticated"` when HEC isn't served there — that
> response shape is the signature of "wrong port", not "bad token".

Local canaries (on the Splunk host):

```bash
curl -sk https://127.0.0.1:8088/services/collector/health   # → {"text":"HEC is healthy","code":17}
# a TLS handshake against a plain-HTTP 8088 fails with
# "SSL: wrong version number" — if you see that, enableSSL is 0 and the URL must be http://
```

### 1.2 The index

Metric data goes to a metric data-model index (`etc/apps/search/local/indexes.conf`
here — note the correct file name is `indexes.conf`):

```ini
[ai-perf]
datatype = metric
metric.timestampResolution = ms
homePath = $SPLUNK_DB/ai-perf/db
coldPath = $SPLUNK_DB/ai-perf/colddb
thawedPath = $SPLUNK_DB/ai-perf/thaweddb
maxTotalDataSizeMB = 1024
```

### 1.3 HEC tokens — mint them through the live path

Create tokens in the UI: **Settings → Data → Data Inputs → HTTP Event Collector →
New Token** (name e.g. `sparkDashboard`, index `ai-perf`). A HEC token is a **UUID**;
it authenticates *only* `POST /services/collector` — it is not an MCP token and not a
management-API token (see §6).

**Lessons learned (bought the hard way in this deployment):**

- The `token =` lines in `inputs.conf` are **not a reliable source of truth**. Every
  disk-stored token here 401'd with `token name=unknown` in `splunkd.log` — even after
  a full restart — until a token was minted through the live UI/REST path. Treat
  `inputs.conf` as a mirror that can lag the live token store (e.g. after config
  edits without a reload, or a rotated `pass4SymmKey`).
- If a freshly minted token still 401s, bounce splunkd (`sudo /opt/splunk/bin/splunk restart`)
  and retest; check `splunkd.log` for `HttpInputDataHandler … token name=unknown`.
- Scope tokens to the indexes the client needs (`indexes = ai-perf,main`). A valid
  token missing the index fails with `400 code 7` ("index not available"), not 401.
- Never hand `write_only`-exempt tokens around; the HEC token travels in every
  request's `Authorization: Splunk <token>` header (the scheme is `Splunk`, **not**
  `Bearer` — `Bearer` is the MCP/JWT scheme; a wrong scheme 401s just like a bad
  token).

### 1.4 Firewall

- Allow **443** (the proxy's public TLS port) from outside.
- Keep **8088/8089/8000** off the public path — LAN + proxy only (ufw/nftables on the
  Splunk host). The proxy reaches 8088 over the LAN.

---

## 2. DNS (internal / external)

| Name | Purpose | Resolves to |
|---|---|---|
| `splunk-hec.pjeffery.net` | HEC ingest (one URL for everyone) | edge proxy `192.168.1.69` |
| `splunk-ai.pjeffery.net` | (legacy) management/MCP-ish paths | `192.168.1.69` — **not** the HEC target; don't use it for HEC |

**Split-horizon options (pick one, stay consistent):**

1. **Same name, same IP** (this deployment): internal and external clients both
   resolve `splunk-hec.pjeffery.net` to the edge proxy; the proxy is the single
   entry point. Simplest; the edge box must be reachable from the LAN (it is:
   `192.168.1.69`), and the LAN path works even when WAN is down.
2. **Split-horizon**: internal DNS (or each host's `/etc/hosts`) points the name at
   an *internal* proxy or directly at the Splunk host, while the public zone points
   at the edge. Cuts one hop on LAN traffic, but doubles the paths to keep in sync —
   only worth it at scale.

Whichever you pick: give clients **the name, never an IP** — IPs here are dynamic
(LAN DHCP) and the topology should be able to move without touching clients.

---

## 3. SSL / TLS

Two TLS domains, deliberately different:

| Segment | Cert | Why |
|---|---|---|
| client → proxy (public) | **Let's Encrypt** `*.pjeffery.net` (90-day, auto-renew) | public trust, zero client config |
| proxy → Splunk (LAN) | Splunk default `SplunkServerDefaultCert` (self-signed, `SplunkCommonCA`) | internal hop; the proxy skips verification |

- **Let's Encrypt wildcard note:** wildcard certs require a **DNS-01** challenge (HTTP-01
  can't validate `*.`). In Caddy that's the DNS provider's ACME module or
  `dns manual` with a renewal hook; the cert here renews automatically
  (notBefore Jul 29 → notAfter Oct 27, 2026 observed).
- **Client → proxy** requires nothing special: standard https, valid chain.
- **LAN direct** (admin tools, `curl` canaries) uses `-k`/insecure-skip-verify against
  the Splunk default cert, or install Splunk's CA (`/opt/splunk/etc/auth/splunkcert.pem`-equivalent)
  into the trust store for a clean handshake.
- Optional hardening: terminate Splunk's 8088 with a proper internal-CA cert
  (`web.conf` sslCertFile/sslPeerCertFile) so the proxy verifies instead of skipping.
  The proxy configs below skip verification because the Splunk default cert is in use.

---

## 4. Reverse proxy

### 4.1 Caddy (what this deployment uses)

```caddyfile
{
    # ACME / Let's Encrypt for the pjeffery.net zone (DNS-01 for the wildcard)
    email admin@pjeffery.net
}

splunk-hec.pjeffery.net {
    # Forward HEC to the Splunk host's HEC port. HEC is just an HTTPS POST,
    # so a plain reverse_proxy is all it needs:
    #   • Authorization header passes through untouched (default)
    #   • request body passes through untouched (default)
    #   • responses are small and immediate — no streaming concerns
    reverse_proxy 192.168.1.224:8088 {
        transport http {
            tls_insecure_skip_verify      # Splunk's self-signed backend cert
        }
    }
}
```

Apply: `sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

**Caddy gotchas that bit here:**
- **No `authenticate`/`forward_auth`/`basicauth` on this site/path** — HEC clients
  authenticate with the HEC token only (`Authorization: Splunk <token>`); a proxy-level gate 401s before Splunk ever
  sees the request (and hides the real error).
- If you use `encode gzip` site-wide, it's harmless for HEC (responses are tiny),
  but keep any SSE/streaming paths (e.g. an MCP endpoint) out of the buffered encode.
- Point the upstream at the **Splunk host's IP**, never at the proxy's own name
  (loop) and never at the management port 8089 (wrong-port 401 XML).

### 4.2 nginx (equivalent)

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name splunk-hec.pjeffery.net;

    ssl_certificate     /etc/letsencrypt/live/pjeffery.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pjeffery.net/privkey.pem;

    location /services/collector/ {
        proxy_pass https://192.168.1.224:8088;
        proxy_ssl_verify off;                 # Splunk default self-signed cert
        proxy_set_header Host $host;
        proxy_pass_request_body on;
        proxy_buffering off;
        # no auth directives here — HEC token does the auth
    }
}
```

### 4.3 Proxy debugging cheat-sheet

| Symptom (curl to the public name) | Meaning |
|---|---|
| `200 {"text":"HEC is healthy","code":17}` on `/health` | whole path good |
| `401 XML "call not properly authenticated"` | hit the **management port** (8089) — wrong upstream port |
| `405 Not Allowed` (nginx) | path isn't proxied; you hit another app behind the name |
| `SSL: wrong version number` | TLS vs plain-HTTP mismatch (backend `enableSSL` disagrees with the URL scheme) |
| connection refused / timeout | wrong IP, firewall, or upstream not listening |
| `401 {"text":"Invalid authorization","code":3}` on `/collector` | path is right; **token** problem (§6) |

---

## 5. Client side (the exporter)

Any HTTP client works. The contract: `POST <url>` with
`Authorization: Splunk <hec-token>` (note the `Splunk` scheme — **not** `Bearer`,
which is the MCP/API-token scheme) and a JSON array body; `2xx` = accepted.

```bash
# minimal probe (event into ai-perf):
curl -s -X POST https://splunk-hec.pjeffery.net/services/collector/event \
  -H 'Authorization: Splunk <HEC-TOKEN>' -H 'content-type: application/json' \
  -d '[{"index":"ai-perf","event":{"message":"hello","metric_name":"probe.ok","metric_value":1}}]'
# → 200, empty body on success; {"text":…,"code":3} etc. on rejection
```

**spark-dashboard** (the reference client in this repo): header ⚙️ → *Export to
Splunk*:

- **HEC URL:** `https://splunk-hec.pjeffery.net/services/collector/event`
- **HEC token:** paste the UI-minted UUID (the field is write-only; re-GETs show
  `…last4` and saving an untouched field keeps the stored token)
- **Index:** `ai-perf` — **Events index:** `main` (GPU events)
- **Save → Test connection** → expect `OK — test event written to ai-perf`; the
  header dot polls `/api/export-status` and goes green when the endpoint is reachable.

---

## 6. Token types — don't mix them up

| | HEC token | MCP / static API token |
|---|---|---|
| format | UUID (`1f161d92-…`) | JWT (`eyJraWQ…`, `typ:"static"`, `aud:"mcp"`, `exp:0` = no expiry) |
| auth header | `Authorization: Splunk <token>` | `Authorization: Bearer <jwt>` |
| authenticates | `POST /services/collector` only | `/services/mcp` (and the mgmt-REST bearer path) |
| created | Settings → Data Inputs → HEC → New Token | MCP/API-token admin page |
| rejection | HEC JSON envelope `{"text":"Invalid authorization","code":3}` (401/403) | JSON-RPC `Authentication failed: Invalid or expired token` |

A 401 on one endpoint proves nothing about the other. Name the endpoint first.

---

## 7. Troubleshooting

| Error | Where | Fix |
|---|---|---|
| `401 code 3` + `splunkd.log`: `HttpInputDataHandler … token name=unknown` | Splunk | token not in the **live** store. Mint via UI/REST; `splunk restart` if still unknown. Do not trust `inputs.conf` `token =` lines as the live table. |
| `400 code 7` | HEC | token's `indexes` list lacks the target index |
| `401 XML` on `:8089/services/collector*` | proxy/client | wrong port — HEC is 8088 here |
| `405` from nginx | proxy | path not routed; another app answers that name/port |
| `SSL: wrong version number` | client↔HEC | scheme mismatch: `http://` vs `https://` vs backend `enableSSL` |
| health 200 but POST 401 | token | path is fine; token/index problem |
| dashboard says `reachable` but events never land | exporter | check `last_error` (e.g. `hec-401`); the zero-ingest liveness probe proves *endpoint* liveness, not *acceptance* — acceptance is the 2xx the JSON-tick path reports. Verify in the index (`index=ai-perf`) when in doubt. |

Verification that data actually landed (no MCP needed):

```bash
# as admin in the Splunk UI, or via the CLI with an admin session:
index=ai-perf metric_name=* sourcetype=_json   # last 15 min, in the UI's search box
```

---

## 8. Open items (this deployment, 2026-08-18)

- **Live HEC token store still rejects the UUIDs mirrored in `inputs.conf`** — the
  externally reachable path is proven healthy end-to-end; a UI-minted token (and a
  splunkd bounce if needed) is the remaining step for live ingest.
- **Dashboard status probe semantics:** the zero-ingest liveness probe currently treats
  *any* HTTP response (including a 401) as "last contact OK" and clears the last
  error, so a token failure can show as green. The JSON-tick path still surfaces
  `hec-401`; the probe branch should keep the last error instead of wiping it.
  (In-flight fix, uncommitted.)
