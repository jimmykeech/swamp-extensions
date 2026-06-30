# swamp-extensions

[swamp](https://github.com/swamp-club/swamp) extensions published under the
`@jamesakeech` collective.

## Extensions

- **[`@jamesakeech/fly`](fly/)** — monitor Fly.io organisations and applications
  (app discovery, machine/deploy state, volumes, snapshots, events) and take
  safe volume snapshots, via the Fly Machines API.

## Development

```sh
deno test --allow-net fly/
deno fmt --check
deno lint
```

Each extension lives in its own directory with a self-contained `manifest.yaml`
(using `paths.base: manifest`). Publish with
`swamp extension push fly/manifest.yaml`.
