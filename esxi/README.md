# @jamesakeech/esxi

A [swamp](https://github.com/swamp-club/swamp) extension for taking a complete,
read-only inventory of a **standalone VMware ESXi host** — shaped for planning a
migration off it and decommissioning it.

Standalone ESXi has no vSphere Automation REST API; that surface exists only on
vCenter. So this reads over SSH from three sources:

- the guests' own **`.vmx`** files, captured whole, for every configured knob;
- **`vim-cmd vmsvc/get.guest`**, for what only the running OS knows — hostname,
  addressing, DNS, default route, mounted filesystems;
- **`vim-cmd vmsvc/get.summary`**, for power state, live usage, and committed
  storage.

Where the vmx and `vim-cmd` overlap on configured values the vmx wins. Where
they do not, `get.guest` is the only source: the vmx knows a NIC exists, but not
what address the OS put on it.

One model type: **`@jamesakeech/esxi/vm`**.

It is deliberately **read-only**. Nothing here starts, stops, or deletes a
guest — the host is being retired, and the disk moves themselves belong to the
target hypervisor's tooling.

## Setup

SSH must be enabled on the host (`TSM-SSH`; it is off by default). Key auth is
preferred — ESXi reads `/etc/ssh/keys-root/authorized_keys`, so no secret has to
round-trip through the model definition:

```sh
swamp model create @jamesakeech/esxi/vm esxi01
```

Then edit the definition — `transport` must be a nested YAML mapping, not a
`--global-arg` string:

```yaml
globalArguments:
  name: esxi01
  transport:
    host: 192.0.2.10
    user: root
    auth:
      kind: key
      identityFile: ~/.ssh/id_ed25519
```

For password auth instead, store the secret in a vault and use:

```yaml
    auth:
      kind: password
      password: "${{ vault.get('esxi', 'root-password') }}"
```

Password auth requires [`sshpass`](https://sourceforge.net/projects/sshpass/) on
the machine running swamp — it is not in homebrew-core and is not part of a
stock macOS install. The password is passed via the `SSHPASS` environment
variable (`sshpass -e`), never in argv where the process table would expose it.

## Usage

```sh
swamp model method run esxi01 inventory
swamp data query esxi01 'resource.warnings.size() > 0'
```

| Method      | Captures                                                           |
| ----------- | ------------------------------------------------------------------ |
| `inventory` | every guest on the host, plus the host itself, in one SSH round trip |

`inventory` is a fan-out: it writes one `vm` resource per guest and one `host`
resource, rather than making the caller loop. Arguments:

- `vmNames` — restrict the emitted `vm` resources to these guests. Host totals
  still describe the whole machine, since that is what is being retired.
- `includeDiskDetail` (default `true`) — read vmdk descriptors and size guest
  folders. Turn it off for a fast name/power-state-only pass.

## What a `vm` record carries

The inventory assumes the migration may be a **rebuild** rather than a
lift-and-shift, so a record has to carry enough to reconstruct an equivalent
guest from nothing.

| Group             | Fields                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Virtual hardware  | vCPUs, cores/socket, memory, hardware version, firmware, Secure Boot, boot order/delay, BIOS UUID |
| Storage           | Per disk: controller, mode, bus sharing, CBT, **provisioned _and_ allocated bytes**               |
| Virtual network   | Per NIC: port group, adapter model, effective MAC, address type                                   |
| In-guest identity | Hostname, domain, per-NIC IPs with prefix lengths, DNS servers, search domains, default gateway   |
| In-guest layout   | Mounted filesystems with type, capacity, free space                                               |
| Live usage        | CPU/memory in use, uptime, heartbeat — the rightsizing evidence                                   |
| Constraints       | Snapshots, RDMs, PCI passthrough, serial/parallel/USB, reservations and limits                    |
| Everything else   | `rawVmx` — the complete vmx, verbatim                                                             |

The typed fields are the queryable summary; **`rawVmx` is the guarantee that
nothing was dropped**. When a rebuilt guest behaves oddly, the answer is usually
one of the several hundred vmx keys nobody thought to model.

Provisioned and allocated bytes are recorded **separately** because a thin
disk's apparent size is not its copy cost — `ls` reports the full provisioned
size while the datastore holds far less.

### Warnings

Each `vm` carries a `warnings` list of what blocks a clean rebuild: snapshots
present, raw device mappings, PCI passthrough, Secure Boot enforced,
independent-mode disks, an unreadable vmx — and, importantly, **a guest that
could not be surveyed at all** because it is powered off or has no VMware Tools.
Those are the guests that must be booted before they can be planned for, and
they are easy to miss otherwise.

## Version notes

Tested against **ESXi 6.7**; the collection avoids the things that differ across
versions:

- **esxcli uses the `xml` formatter, not `json`.** The JSON formatter only
  exists from ESXi 7.0 — 6.7 answers `Unable to find requested formatter: json`.
  The XML formatter has been present since 5.0 and uses the same field names.
- **`esxcli hardware cpu list` reports only `GenuineIntel` on 6.7.** The real
  part number comes from `vim-cmd hostsvc/hostsummary`.
- **`command -v` is not reliable in ESXi's busybox `ash`.** The pre-flight probe
  uses `[ -x ... ]` with a `which` fallback and always exits 0, so a failure is
  a readable statement rather than exit 127.

esxcli's stderr is captured rather than discarded, so a failed call is reported
as what it said instead of silently producing an empty datastore list.

## Safety

- The collection script is fed to the remote shell over **stdin** (`sh -s`), not
  argv — ESXi's busybox `ash` would otherwise re-parse a long quoted string, and
  every datastore or guest name in it becomes a quoting hazard. There is no
  local `sh -c` at any point; `Deno.Command` spawns directly.
- Transport option values are newline/NUL-guarded at schema time, so a crafted
  host or proxy value cannot smuggle extra `-o` flags into the SSH invocation.
- **`-flat.vmdk` files are never read.** Only descriptor vmdks are `cat`-ed,
  with `head -c 4096` as a second bound — reading a flat file would pull the
  entire disk across the SSH session.
