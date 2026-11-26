# @jamesakeech/nix-vm-vuln

A [swamp](https://github.com/swamp-club/swamp) extension that scans a running
NixOS virtual machine for known vulnerabilities and writes a report.

The scan opens one SSH session, reads `/run/current-system`, and lists that
closure with `nix-store -qR`. It does not run `nixos-rebuild`, install
packages, or change the generation. Advisory matching happens on the machine
running swamp.

Two pieces:

- **`@jamesakeech/nix-vm-vuln-scan`** — behavior with one `scan` method. It
  stores a `vulnerabilityScan` resource named `scan`.
- **`@jamesakeech/nix-vm-vuln-report`** — method-scope report that renders that
  resource as markdown and JSON. The behavior attaches it, so a scan run
  produces the report.

OSV.dev has no Nix ecosystem. A finding with confidence `version-match` means
the same package name and version are vulnerable in another catalog. Findings
with confidence `nixpkgs-advisory` or `nix-advisory` come from the published
GitHub security advisories for NixOS/nixpkgs and NixOS/nix. An advisory range
that this scanner cannot parse is kept, so a listed fix can still appear when
the installed version is already newer.

## Installation

```sh
swamp extension install @jamesakeech/nix-vm-vuln
```

The host that runs swamp needs an `ssh` client. The guest needs a booted NixOS
system and `nix-store` on `PATH`. The default SSH user is `jimmykeech` and the
default port is 22. Key authentication uses the SSH agent, or an identity file
path passed as `identityFile`. The scan stores that path only as an argument
on the behavior, not in the scan resource.

## Usage

```sh
swamp behavior create @jamesakeech/nix-vm-vuln-scan guest \
  --global-arg host=192.0.2.10 \
  --global-arg sshUser=example

swamp behavior run guest scan --input maxPackages=500

swamp report get @jamesakeech/nix-vm-vuln-report --behavior guest --markdown
```

`host` is a hostname, `localhost`, or an IPv4 address. `maxPackages` caps how
many closure packages are sent to OSV (1–1000, default 500). The running
kernel is queried as the OSV package `Kernel` in the `Linux` ecosystem and
shown as `linux`. Connection failures and a machine that is not NixOS fail the
run before anything is stored. A feed that does not answer still stores the
scan and lists the failure under feed errors.

A direct run creates the definition when it does not exist yet:

```sh
swamp behavior run @jamesakeech/nix-vm-vuln-scan scan guest \
  --input host=192.0.2.10 \
  --input sshUser=example \
  --input maxPackages=500
```

## License

MIT — see [LICENSE.md](LICENSE.md) for details.
