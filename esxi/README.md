# @jamesakeech/esxi

Collect a read-only inventory of a standalone VMware ESXi host for migration
planning. The `@jamesakeech/esxi/vm` model reads `.vmx` files, `vim-cmd`, and
`esxcli` over SSH. It does not start, stop, move, or delete guests.

## Install

```sh
swamp extension pull @jamesakeech/esxi
```

## Setup

Enable SSH (`TSM-SSH`) on ESXi. The machine running swamp needs an SSH client.
The remote user must be able to read VM files and run `vim-cmd` and `esxcli`.
For root key authentication, ESXi uses `/etc/ssh/keys-root/authorized_keys`.

```sh
swamp model create @jamesakeech/esxi/vm esxi01
```

Edit the model definition with the required `name` and nested `transport`
mapping:

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

Omit `identityFile` to use the SSH agent or SSH configuration. For password
authentication, install `sshpass` on the swamp machine and replace `auth` with:

```yaml
auth:
  kind: password
  password: "${{ vault.get('esxi', 'root-password') }}"
```

The password is passed through `SSHPASS`, not command arguments.

## Usage

```sh
swamp model method run esxi01 inventory
swamp data list esxi01
```

`inventory` collects the host in one SSH session and writes one `host` resource
plus one `vm` resource per guest. Optional method inputs:

| Input               | Default    | Effect                                                                           |
| ------------------- | ---------- | -------------------------------------------------------------------------------- |
| `vmNames`           | All guests | Emit only matching guests. Host totals still cover all guests.                   |
| `includeDiskDetail` | `true`     | Read VMDK descriptors and measure guest folders. Disable to speed up collection. |

Each VM record includes:

- Virtual hardware, firmware, boot settings, and BIOS UUID.
- Disks, controllers, and separate provisioned and allocated sizes.
- NICs, port groups, adapter models, and MAC addresses.
- Guest hostname, IP addresses, DNS, routes, and mounted filesystems.
- Power state, CPU and memory usage, uptime, and heartbeat.
- Migration constraints, including snapshots, RDMs, and passthrough devices.
- `rawVmx`, the full VMX key/value map, plus a `warnings` list.

VMX values take precedence for overlapping configuration fields. Guest OS
details require a running guest and VMware Tools. Review warnings for missing
guest data, unreadable VMX files, and constraints that can affect migration.

## Limits and compatibility

Tested with ESXi 6.7. Collection uses the `esxcli` XML formatter for
compatibility. Only VMDK descriptors are read; `-flat.vmdk` disk contents are
never transferred.

## License

[MIT](LICENSE.md).
