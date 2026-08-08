# @jamesakeech/omada

A [swamp](https://github.com/swamp-club/swamp) extension for observing a
**TP-Link Omada controller** — and, when you need it, acting on one.

The centre of gravity is observability. One `sync` reads the whole controller
and fans it out into individually addressable resources: a site, a device, a
client, a switch port, a gateway WAN, an SSID. It then writes a **`drift`**
resource comparing this sync against the last one, restricted to configuration
fields. Uptime, CPU, traffic counters and signal strength are never compared, so
a network where nothing happened reports no drift — and the things that do show
up are things somebody changed:

- a device's firmware version moved, or a newer one became available
- a WAN address, gateway, netmask or DNS server changed
- a PoE port was switched off, or a port's profile changed
- an SSID's security mode, VLAN, broadcast or enablement changed
- a device stopped answering, or an AP appeared that was not there yesterday

One model type: **`@jamesakeech/omada`**. One instance is one controller —
authentication is controller-wide and every API path is scoped by the controller
id, so a per-site or per-device model could not resolve its own dependencies.

## Which API it uses

Omada exposes two HTTP interfaces and this extension uses both, deliberately
unevenly.

The **Open API** (`/openapi/v1/...`) is TP-Link's supported northbound
interface. It is versioned, survives controller upgrades, and is the only option
against the regional cloud hosts. Every read and every write here goes through
it, and it is **required**.

Everything is read through the paginated path with explicit `page` and
`pageSize`, including endpoints that answer with a bare array. On controller
6.x, `/devices` and `.../ssids` return a bare HTTP 400 — no Omada error envelope
at all — when `page` is missing, while `/wlans` and `switch-detail` answer fine
without it. Since a 400 that degrades gracefully reads as "this site has no
devices", the safe move is to always paginate.

The controller's own **web API** (`/{omadacId}/api/v2/...`) is what the browser
UI calls. It is undocumented and TP-Link changes it without notice, but it is
the only place some configuration lives. It is **optional**: supply
`username`/`password` and it is used as a fallback for reads the Open API cannot
serve; omit them and the sync runs Open-API-only. A failed web login degrades to
a warning rather than failing the run.

## Setup

### 1. Create an Open API application

On the controller: **Global View → Settings → Platform Integration → Open API →
Add New App**. Choose **Client mode** (not Authorization Code), give it a role,
and grant it site privileges. Copy the **Client ID** and **Client Secret**.

A viewer role is enough for `sync`. The operational methods need write access.

### 2. Store the secret

```sh
swamp vault create local_encryption omada
swamp vault put omada CLIENT_SECRET
```

### 3. Create the model

```sh
swamp model create @jamesakeech/omada home-net \
  --global-arg baseUrl=https://192.0.2.10:8043 \
  --global-arg clientId=1234567890abcdef1234567890abcdef \
  --global-arg 'clientSecret=${{ vault.get(omada, CLIENT_SECRET) }}' \
  --global-arg controllerLabel=home-net
```

`omadacId` is discovered automatically from the unauthenticated `/api/info` on a
self-hosted or OC200 controller. Against a **cloud northbound host** — e.g.
`https://euw1-omada-northbound.tplinkcloud.com` — that endpoint does not exist,
so set it explicitly:

```sh
--global-arg omadacId=de382a0e78f4deb681f3128c3e75dbd1
```

### 4. Self-signed certificates

Omada ships a self-signed certificate on 8043 and most installations never
replace it, so the first `sync` usually fails on certificate verification.
Rather than disabling verification, paste the controller's own PEM into
`caCertPem` — it is trusted in addition to the system roots, and an impersonated
controller still fails:

```yaml
globalArguments:
  caCertPem: |
    -----BEGIN CERTIFICATE-----
    MIIDdzCCAl+gAwIBAgIEexample...
    -----END CERTIFICATE-----
```

Grab it with:

```sh
openssl s_client -connect controller.example.com:8043 -showcerts </dev/null \
  2>/dev/null | openssl x509
```

### 5. Sync

```sh
swamp model method run home-net sync
```

The first run establishes the drift baseline and reports `hasBaseline: false` —
there is nothing to compare against yet. Every run after that compares.

## Reading the output

```sh
# Controller rollup
swamp data get home-net controller --json

# What changed since last time
swamp data get home-net drift --json

# Every device that is not connected
swamp data query 'modelName == "home-net" && specName == "device"' \
  --select '{"name": attributes.name, "state": attributes.state}'

# PoE draw per switch port
swamp data query 'modelName == "home-net" && specName == "switchPort"' \
  --select '{"port": attributes.port, "watts": attributes.poeDrawW}'
```

Resource instance names are stable and predictable, so CEL can address one
object directly:

| Spec         | Instance name              |
| ------------ | -------------------------- |
| `controller` | `controller`               |
| `drift`      | `drift`                    |
| `site`       | `site-<slugged name>`      |
| `device`     | `device-<mac>`             |
| `client`     | `client-<mac>`             |
| `switchPort` | `port-<switch mac>-<port>` |
| `wan`        | `wan-<gateway mac>-<port>` |
| `ssid`       | `ssid-<wlan id>-<ssid id>` |
| `change`     | `change`                   |

MACs are lowercase hex with no separators, so the name does not move if the
controller changes how it formats them.

## Reacting to drift

The point of the `drift` resource is that it is queryable. In a workflow, guard
a notification step on it:

```yaml
- name: notify-on-drift
  guard: data.latest("home-net", "drift").attributes.changed
  # ...
```

Or narrow it — only wake up when a PoE port moved:

```sh
swamp data query 'modelName == "home-net" && specName == "drift"' \
  --select '{"entries": attributes.entries}'
```

Each entry carries `kind`, `instanceName`, `subject`, `field`, `before` and
`after`, so "Rack port 3 poeEnabled true → false" is directly readable.

Drift tracks sites, devices, switch ports, WANs and SSIDs. **Clients are not
tracked** — they associate and leave constantly, and treating that as drift
would bury the one line that matters.

## Methods

| Method             | What it does                                               |
| ------------------ | ---------------------------------------------------------- |
| `sync`             | Read everything; fan out resources; write the drift record |
| `rebootDevices`    | Reboot APs, switches or gateways by MAC                    |
| `setPoePorts`      | Switch PoE on or off for specific switch ports             |
| `setClientAccess`  | Block or unblock clients by MAC                            |
| `reconnectClients` | Force clients to re-associate                              |
| `setLed`           | Turn site-wide device LEDs on or off                       |
| `locateDevices`    | Start or stop the locate flash                             |
| `upgradeFirmware`  | Start an online firmware upgrade                           |

`sync` takes `includeClients`, `includePorts`, `includeSsids` and `detectDrift`,
all defaulting to true. Turning `includeClients` off is the big saving on a busy
site.

Every write method takes a **list** and fans out internally, so a batch is one
controller session holding the model lock once — not N separate runs contending
on the same instance:

```sh
swamp model method run home-net rebootDevices \
  --input 'macs:json=["AA-BB-CC-DD-EE-01","AA-BB-CC-DD-EE-02"]'

swamp model method run home-net setPoePorts \
  --input 'ports:json=[{"switchMac":"AA-BB-CC-DD-EE-03","port":5,"enabled":false}]'

swamp model method run home-net setClientAccess \
  --input 'macs:json=["11-22-33-44-55-66"]' --input blocked=true
```

MAC separators and case are normalised, so `aa:bb:cc:dd:ee:01` and
`AA-BB-CC-DD-EE-01` both resolve. A MAC the controller does not know is recorded
as a per-target failure rather than abandoning the rest of the batch.

Each write produces a `change` resource. `action` collapses the batch to one
word a guard can branch on — and reports `partial`, never the successful verb,
when some targets failed:

```sh
swamp data get home-net change --json
```

### A note on `setPoePorts`

The controller ignores a PoE change on a port that is still following its
profile, so this enables profile override first and only then sets PoE mode.
Ports are grouped by switch **and** by desired state, because the batch endpoint
applies one mode to a whole port list — turning port 3 on and port 5 off on the
same switch is genuinely two calls.

## What it deliberately does not do

No configuration CRUD. There is no create/update/delete for SSIDs, VLANs,
firewall rules or port profiles. Every write here is a reversible operational
action that the controller UI exposes as a button. If you want declarative
config management of an Omada network, this is not that — and the drift record
is arguably the better half of that problem anyway.

## Pre-flight checks

Two checks run before every write method:

- `credentials-present` — catches an unset vault reference before a call is made
- `controller-reachable` — labelled `live`; separates an unreachable controller
  from a rejected client secret. Skip it offline with `--skip-check-label live`.

## Controller version notes

Developed and verified against **controller 6.0.0 build 25** (`apiVer 3`). Where
6.x differs from the 5.x line, both are handled:

| Thing          | 5.x                           | 6.x                          |
| -------------- | ----------------------------- | ---------------------------- |
| Device state   | `statusCategory` (+ `status`) | coarse value in `status`     |
| Device uptime  | `uptimeLong`, seconds         | `uptime`, `"171day(s) 18m"`  |
| Clients        | `/openapi/v2/.../clients`     | v1 only; v2 returns 405      |
| Switch ports   | `switch-detail` port list     | `poe-info`, one row per port |
| Site PoE total | single object                 | array, summed per switch     |

`statusCategory` is preferred over `status` so a 5.x controller — where `status`
holds a _fine-grained_ code — still decodes correctly.

Fields 6.x does not send on `/devices` (`latestFirmwareVersion`, uplink,
per-device client count, PoE headroom) come back as `""` or `null` rather than
invented values, so `needsUpgrade` is `false` on 6.x unless the controller says
otherwise.

## Troubleshooting

**`could not read /api/info`** — you are pointed at a cloud northbound host, or
at something that is not the controller. Set `omadacId` explicitly.

**`Open API authorization failed`** — the application is in Authorization Code
mode rather than Client mode, or the secret is wrong. Both are set under
Settings → Platform Integration → Open API.

**Certificate errors** — see
[Self-signed certificates](#4-self-signed-certificates).

**`could not read <collection> — reporting none`** — that endpoint is missing on
your controller build. The sync completes with everything else; the warning
names what was skipped so an empty list is never mistaken for an empty network.

**`siteFilter matched no sites`** — the error lists the site names the
credentials can actually see.

## Development

```sh
~/.swamp/deno/deno check omada.ts
~/.swamp/deno/deno test --allow-net omada_test.ts
~/.swamp/deno/deno lint .
```

## License

MIT — see [LICENSE.md](LICENSE.md).
