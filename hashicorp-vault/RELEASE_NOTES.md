# Fork release

## @jamesakeech/hashicorp-vault 2026.11.12.1

Fork the reviewed token-file provider into `jimmykeech/swamp-extensions` under
its own package and instrumentation names. Retain KV v1/v2 support, tracing,
credential fallbacks, token-file rotation, tests, and Apache-2.0 attribution.

**Upgrade note:** The type is now `@jamesakeech/hashicorp-vault`. Preserve the
existing vault ID and backend configuration when migrating from the upstream
type. This changes the provider implementation, not the stored secrets.

# Source release history

## 2026.11.12.1

**Added:** Optional `tokenFile` configuration for OpenBao Agent and Vault Agent
sinks. The provider reads and trims the file before every HTTP request, including
recursive LIST requests, so reauthentication can replace a token without restarting
the consumer. Provider creation does not require the sink to exist yet.

**Upgrade note:** When configured, `tokenFile` overrides all other credential
sources. A missing, unreadable, or empty file fails the operation without falling
back to another token. Existing configurations without `tokenFile` are unchanged.
The test task now permits temporary file creation for the token rotation regression.

## 2026.11.10.1

**Changed:** Bump @opentelemetry/api 1.9.1 → 1.10.0

## 2026.11.03.1

**Changed:** Bump zod 4.6.5 → 4.6.7

## 2026.10.21.1

**Changed:** The README's configuration example no longer shows a literal
`token:` in the vault config. A new Authentication section leads with
`vault login`, which stores the token in `~/.vault-token` where the provider
reads it, and warns against putting a literal token in the config or relying on
`VAULT_TOKEN`. The `token` config field description and the "No Vault token
found" error message now say the same; the error text changed, so update
anything that matches on its old wording.

**Fixed:** Tracing spans reported a stale instrumentation version
(`2026.08.20.1`) instead of the published version. The tracer version now
matches `manifest.yaml`, and a test fails if the two drift apart again (the
`test` task in `deno.json` now grants read access to `manifest.yaml` for it).

**Fixed:** The model-definition example used `{{ vault('hashi', ...) }}`, which
is not swamp syntax and never resolved to the secret: swamp rejects a literal
value for an argument marked sensitive, and passes it through as literal text to
one that is not. It now uses `${{ vault.get("hashi", "...") }}`. The
`swamp vault read-secret
--force` example now warns that it prints the plaintext
value.

**Upgrade note:** The token resolution order is unchanged (config `token`, then
`VAULT_TOKEN`, then `~/.vault-token`), so existing setups keep working.
