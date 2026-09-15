# Elo Ra Kings LAN demo

This is a synchronized, local-only interaction preview for Computer Elo. It is
deliberately smaller than the eventual WebUI: one room, no accounts, no
database, no analytics, no raw Computer History collection, and no external
services.

The typed Node server owns the temporary ratings and match counts. Every duel is
calculated by the authoritative TypeScript engine in `packages/elo-engine`.
Restarting the server erases the room.

## Run on a trusted local network

Bind the specific private address of this computer and allow only its local
subnet:

```bash
npm run dev -- \
  --host 192.168.1.23 \
  --port 8765 \
  --allow-cidr 192.168.1.0/24
```

The server prints one room URL containing a random capability token after `#`.
The page keeps that fragment in the current tab's session storage, removes it
from the address bar, and forwards it in a private request header. This lets a
refresh stay connected without leaving the token in browser history. The
**Copy LAN link** button restores the complete URL when you are ready to share
it. Give that link only to the other person on the same Wi-Fi or local network.

This is not authenticated identity. Anyone holding the link can control both
players. Do not configure router port forwarding or expose the port to the
internet, guest Wi-Fi, or an untrusted VPN. Stop the process when the demo is
finished.

The server requires a specific numeric interface address, rejects wildcard
binding and public CIDRs, drops off-subnet sockets before creating request
threads, and caps concurrent handlers. These controls reduce accidental LAN
exposure; they do not turn the demo into an internet-facing service.

Run a duel to preview and download a privacy-safe SVG or PNG card. The LAN card
intentionally omits Form and confidence inputs as well as every raw or named
activity field. The engine's canonical Phase 1 cards and receipts remain the
portable, fingerprinted artifacts.

## Test

```bash
npm run typecheck
npm test
```

The API accepts only Form, aggregate coverage/certainty, mode, compatibility,
revision, and an idempotency key. It does not accept names, messages, URLs,
contacts, filenames, project names, receipts, or private evidence.
