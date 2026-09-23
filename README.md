# ExcaliDash Live

> **This is a fork.** It builds on [`siredvin/excalidash-obsidian-sync`](https://github.com/siredvin/excalidash-obsidian-sync)
> (MIT, © 2026 SirEdvin), which already provides the ExcaliDash REST client, authentication,
> frontmatter contract, scene parsing and collection resolution. **All of that is theirs.**
> This fork stays MIT and keeps the original `LICENSE` unchanged.
>
> **What this fork adds:** real-time sync over ExcaliDash's socket.io channel, element-level
> conflict resolution with permanent tombstones, and live updates of an already-open Excalidraw
> view via `ExcalidrawAutomate`. Upstream is deliberately manual-command-driven and states that
> its bidirectional conflict handling is limited — that gap is the whole point of this fork.
>
> Upstream fixes that are not about real-time are kept on separate branches so they can go back
> as pull requests.

## Status

Early. The feasibility probes pass (see `docs/current_status.md`), the plumbing is not written yet.

```bash
node scripts/probe-socket.mjs    --base http://127.0.0.1:6768 --env <instance>/.env
node scripts/probe-roundtrip.mjs --base http://127.0.0.1:6768 --env <instance>/.env
```

Measured against a live ExcaliDash instance:

| Question | Answer |
|---|---|
| Can a non-browser client join a drawing room? | **Yes — with a login JWT only.** Anonymous and API-key handshakes are denied (the handshake runs `jwt.verify`, and an API key is not a JWT) |
| Where does the token go? | `handshake.auth.token` **or** `Cookie: excalidash-access-token=…` — both work |
| Does `element-update` propagate? | **Yes** — but the payload **must** carry `drawingId`, or the server drops it silently |
| Does the socket persist anything? | **No.** It relays only (`socket.to(roomId).emit(...)`); persistence is REST |

That last row is why this plugin uses two channels: **REST for storage, socket for notification and
propagation.** Excalidraw's reconciliation is never reimplemented.

---

## Upstream documentation

![vibe-coded](https://img.shields.io/badge/Hermes%20Agent-Completely%20vibe%20coded%20%F0%9F%98%8E-FFD700?style=for-the-badge&labelColor=07070d)

Sync the current Obsidian Excalidraw note to [ExcaliDash](https://github.com/ZimengXiong/ExcaliDash) by using frontmatter opt-in metadata.

It supports multiple different [ExcaliDash](https://github.com/ZimengXiong/ExcaliDash) instances, sync to collections, one-way (by default) or bidirectional sync.

## How to use it? 

1. Install plugin via obsidian community plugins
2. Enable it
3. Configure access to your [Excalidash](https://github.com/ZimengXiong/ExcaliDash) instance, using username/password or api keys. Use the server root as the base URL; the plugin uses ExcaliDash's fixed `/api` routes internally.
4. Use Excalidash Sync command to edit settings for one drawing or fall all drawings in specific folder.
5. Hit manual sync command.

### Api keys?

For now, [ExcaliDash](https://github.com/ZimengXiong/ExcaliDash) don't support any api keys, PR for this already [opened](https://github.com/ZimengXiong/ExcaliDash/pull/172), for now you can use docker images from [my fork](https://github.com/SirEdvin/ExcaliDash/) or use username/password and wait for PR to be merged.

## Frontmatter format

```yaml
excalidash-destination: home
excalidash-collection: My collection # optional id, name, or title
excalidash-sync: obsidian-to-excalidash # or bidirectional
excalidash-id: generated-after-first-sync
excalidash-version: 4
excalidash-last-hash: sha256-like-browser-hash
excalidash-last-synced: 2026-05-13T12:00:00.000Z
```

## Conflict behavior

- Existing remote drawings are fetched before update and written back with the latest remote version.
- If `excalidash-collection` is set, the plugin fetches `/collections`, resolves id first and then exact name/title, and fails that drawing if no collection matches.
- Collection changes are included in drawing create and update requests, so changing or clearing `excalidash-collection` can move an existing remote drawing.
- A remote version change since the last sync is reported as a conflict for one-way sync.
- Bidirectional sync pulls the remote scene into Obsidian only when the local scene hash still matches `excalidash-last-hash`.
- If both local and remote changed, the plugin reports a conflict and leaves both copies untouched.
- Bidirectional remote pulls into `compressed-json` Excalidraw notes are not supported; convert the note to plain JSON or use Obsidian-to-ExcaliDash sync for those files.

## Future plans: 

- Advanced syncing (on save, periodical, etc)
- Debug information in logs (disabled by default)
- Maybe collection detection
