# swamp-extensions

[swamp](https://github.com/swamp-club/swamp) extensions published under the
`@jamesakeech` collective.

## Extensions

- **[`@jamesakeech/fly`](fly/)** — monitor Fly.io organisations and applications
  (app discovery, machine/deploy state, volumes, snapshots, events) and take
  safe volume snapshots, via the Fly Machines API.
- **[`@jamesakeech/audiobookshelf`](audiobookshelf/)** — monitor a self-hosted
  Audiobookshelf server (libraries, audiobooks/podcasts, listening progress,
  listening sessions, aggregate listening statistics), via the Audiobookshelf
  REST API.

## Development

```sh
deno test --allow-net fly/ audiobookshelf/
deno fmt --check
deno lint
```

Each extension lives in its own directory with a self-contained `manifest.yaml`
(using `paths.base: manifest`). Publish with
`swamp extension push fly/manifest.yaml`.
