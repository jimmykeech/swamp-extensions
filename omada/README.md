# @jamesakeech/omada

Monitor a [TP-Link Omada](https://www.omadanetworks.com/) controller with
[swamp](https://github.com/swamp-club/swamp). Read network inventory, detect
configuration changes, and run device operations. Use one model per controller.

## Setup

1. In the controller, open **Global View → Settings → Platform Integration →
   Open API → Add New App**. Select **Client mode** and grant site privileges. A
   viewer role can run `sync`; operational methods need write access.
2. Copy the Client ID and store the Client Secret in a vault.
3. Install the extension and create a model:

```sh
swamp extension pull @jamesakeech/omada
swamp vault create local_encryption omada
swamp vault put omada CLIENT_SECRET
swamp model create @jamesakeech/omada home-net \
  --global-arg baseUrl=https://192.0.2.10:8043 \
  --global-arg clientId=YOUR_CLIENT_ID \
  --global-arg 'clientSecret=${{ vault.get("omada", "CLIENT_SECRET") }}'
```

For cloud northbound hosts, also set `omadacId`. Local controllers discover it
through `/api/info`.

For a self-signed controller certificate, add its PEM certificate to `caCertPem`
in the model's `globalArguments`. This adds trust without disabling
verification.

```yaml
globalArguments:
  caCertPem: |
    -----BEGIN CERTIFICATE-----
    YOUR_CONTROLLER_CERTIFICATE
    -----END CERTIFICATE-----
```

Optional arguments include `siteFilter` (site names; default: all accessible
sites), `controllerLabel`, and `requestTimeoutSec` (default: 30).

The Open API is required. Optional `username` and `password` arguments enable
web API fallback reads. A failed web login produces a warning; Open API reads
continue.

## Read inventory and drift

```sh
swamp model method run home-net sync
swamp data get home-net controller --json
swamp data get home-net drift --json
```

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

Resource names use lowercase MAC addresses without separators.

`drift` compares sites, devices, switch ports, WANs, and SSIDs against the
previous sync. It tracks configuration and device availability, excluding
clients and telemetry such as CPU, uptime, and traffic. The first sync
establishes a baseline and reports `hasBaseline: false`.

Each drift entry contains `kind`, `instanceName`, `subject`, `field`, `before`,
and `after`. A workflow can test
`data.latest("home-net", "drift").attributes.changed`.

## Methods

| Method             | Purpose                                 |
| ------------------ | --------------------------------------- |
| `sync`             | Read inventory and detect drift         |
| `rebootDevices`    | Reboot devices by MAC address           |
| `setPoePorts`      | Enable or disable PoE on switch ports   |
| `setClientAccess`  | Block or unblock clients                |
| `reconnectClients` | Force clients to reconnect              |
| `setLed`           | Enable or disable site-wide device LEDs |
| `locateDevices`    | Start or stop device location flashes   |
| `upgradeFirmware`  | Start an online firmware upgrade        |

`sync` accepts `includeClients`, `includePorts`, `includeSsids`, and
`detectDrift`. All default to `true`. Disable client collection to reduce work
on busy sites.

```sh
swamp model method run home-net rebootDevices \
  --input 'macs=["AA-BB-CC-DD-EE-01","AA-BB-CC-DD-EE-02"]'

swamp model method run home-net setPoePorts \
  --input 'ports=[{"switchMac":"AA-BB-CC-DD-EE-03","port":5,"enabled":false}]'
```

Batch operations record individual failures in `change` and report
`action: partial` when only some targets succeed. MAC address case and
separators are normalized. `setPoePorts` enables profile override before
changing PoE.

## Limits and troubleshooting

- SSID, VLAN, firewall, and port-profile configuration changes are not
  supported.
- Write methods run `credentials-present` and `controller-reachable` pre-flight
  checks. The latter has the `live` label and can be skipped with
  `--skip-check-label live`.
- Verified against controller 6.0.0 build 25 (`apiVer 3`). The extension also
  handles known 5.x response differences. Missing fields remain empty or `null`.
- `could not read /api/info`: check `baseUrl`, or set `omadacId` for cloud
  hosts.
- `Open API authorization failed`: check Client mode and the Client Secret.
- `could not read <collection> — reporting none`: the endpoint is unavailable;
  other collections still sync.
- `siteFilter matched no sites`: use the accessible site names listed in the
  error.

## Development

```sh
~/.swamp/deno/deno check omada.ts
~/.swamp/deno/deno test --allow-net omada_test.ts
```

## License

MIT — see [LICENSE.md](LICENSE.md).
