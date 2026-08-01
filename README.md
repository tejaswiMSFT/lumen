# Lumen

Move a file between two devices on light alone.

One HTML file. No install, no account, no server, no pairing — and **no network**.
The sender turns your file into a stream of QR codes; the receiver's camera reads
them back. Both devices can be in airplane mode.

## Use it

**<https://tejaswimsft.github.io/lumen/>**

Open that on both devices. On iPhone, tap **Share ▸ Add to Home Screen** — it then
launches like a native app and never needs the network again.

## What this page does and does not do

This site exists only to *deliver the app*. Once the page has loaded, it makes no
further requests: no analytics, no telemetry, no CDN, no fonts, no service worker.
Everything — QR encoder, QR decoder, fountain code, compression — is inside the
single HTML file.

**Your files are never uploaded.** They never touch this host, GitHub, or any
network. The transfer happens between two screens and two cameras. The host can
see that *someone fetched the app*, and nothing else.

You can verify this: load the page, then kill your connection. Everything still works.

## Why it must be https

Browsers only grant camera access on a secure origin. A plain `http://192.168.x.x`
address will load Lumen but the receiver's camera will be blocked. https (or a
`file://` local copy, or `localhost`) is required.

## Why iPhones need a link at all

iOS sandboxes every app, so nothing can hand a local `.html` file to Safari — the
share sheet only ever offers Notes, Mail and similar. Tapping the file in Files
shows a *preview*, which cannot run scripts. A link is the only route in, and the
easiest way to open one is to point the iPhone **Camera** at a QR code of it: the
Camera app opens links in Safari directly.

## Running it yourself

Nothing here is required. The file works from disk on Android, Windows, macOS and
Linux — just open it. To serve it locally:

    node serve.js 8000            # http://127.0.0.1:8000  (localhost is secure)
    node serve-https.js 8443      # https on your LAN, for phones

## How it works

- **Fountain code (LT)** — the sender emits an endless stream of random block
  combinations, so the receiver never has to catch a specific frame. Drop one and
  it repairs itself; no back-channel is needed.
- **Base45** (RFC 9285) packs bytes into the QR alphanumeric set efficiently.
- **CRC32** on the whole file, verified after reassembly.
- Built-in QR **encoder and decoder** — Safari has no `BarcodeDetector`, so the
  decoder is written from scratch and used on every iPhone.

## Credits

QR Code® is a registered trademark of DENSO WAVE. LT codes, M. Luby. Base45, RFC 9285.

Vibe coded by **Tejaswi** · Made with ❤️ and **Microsoft Scout**
