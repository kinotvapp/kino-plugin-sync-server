# Sync Servidor: sync your Kino devices through your own server

[Leer en español](README.es.md)

This repository is **Sync Servidor** (plugin id `sync-server`), a complete, working example of a **Kino sync provider**: a tiny server you run yourself
(`server.mjs`) and the Kino plugin that talks to it (`plugin/`). With it, your phone and your TV keep
the same history, library and settings through **your** computer, instead of through the local
network or someone else's service.

It is an example to learn from and to copy. It is not part of Kino, and nobody runs it for you: the
server is yours, started by you, for your own devices. It is not a recommended plugin and Kino does not
list it: you install it only by typing its address (step 3). It needs Kino 0.9.74 or newer.

The plugin's **Open the guide** button opens this repository.

```
your phone ─┐                                             ┌─ data/blob.bin   (the encrypted snapshot)
            ├─ https ─▶ Cloudflare tunnel ─▶ server.mjs ──┼─ data/meta.json  (its version)
your TV  ───┘                                             └─ data/token      (your access token)
```

## What you need

- A computer that stays on while you want to sync (Mac, Linux or Windows).
- **Node.js 18 or newer**: `node --version` must print `v18` or higher. Get it from <https://nodejs.org>.
  Nothing else to install: `server.mjs` has no dependencies.
- **cloudflared**, Cloudflare's tunnel program (free; a quick tunnel needs no account):
  - macOS: `brew install cloudflared`
  - Windows: `winget install --id Cloudflare.cloudflared`
  - Linux: see <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>
- Kino 0.9.74 or newer on your devices.

**Why a tunnel?** A Kino plugin may only reach **public https** addresses on port 443. It can never
reach your local network, and never plain http. The tunnel gives the server on your computer a
public https address.

## 1. Start the server

Clone or download this repository anywhere. You need `server.mjs` and the `plugin/` folder next to it. Open a terminal
in that folder and run:

```sh
node server.mjs
```

The first time, it prints something like this:

```
Kino sync demo listening on http://127.0.0.1:8787  (data in /…/sync-server/data)

Your new access token (shown only this once; it is also saved in /…/data/token):

  q3J0dX…(43 characters)…Xk

Paste it into the plugin's Token field. Anyone who has it can read your synced data.

Next: cloudflared tunnel --url http://127.0.0.1:8787
```

- **The token** is a long random string, made on the first start and saved in `data/token`.
  - Later starts reuse it and do not print it again. Open `data/token` to see it.
  - To choose your own, start with `DEMO_TOKEN=<at least 32 random characters> node server.mjs`. On
    Windows PowerShell: `$env:DEMO_TOKEN="…"; node server.mjs`.
  - Never use a password you made up. Kino derives the encryption key from this token, so it must
    be long and random.
- **Your data** lives in `data/`, next to `server.mjs`. `DATA_DIR=/some/folder` puts it elsewhere. It
  holds `blob.bin` (the encrypted snapshot), `meta.json` (its version) and `token`.
- The server listens only on `127.0.0.1`, your own computer. `PORT=9000` changes the port.
- Run only one server per data folder: two would each keep their own idea of the current version.
- Leave this terminal open. `Ctrl+C` stops the server.

Check that it works. In another terminal, `curl http://127.0.0.1:8787/healthz` prints `ok`.

## 2. Create the tunnel

### Option A: quick tunnel (fastest; the address changes every time)

In a second terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:8787
```

After a few seconds it prints a box with an address like
`https://random-words-here.trycloudflare.com`. That is your server's public address **for as long
as this command runs**. Leave the terminal open.

- A quick tunnel gets a **new random address every time you start it**. When the address changes,
  you have to type the new one into the plugin on every device (see
  [Troubleshooting](#troubleshooting)).
- Cloudflare offers quick tunnels for testing, with no uptime guarantee.
- Fine for trying it out. For daily use, take option B.

If you already use cloudflared for something else and have a `~/.cloudflared/config.yml`, the quick
tunnel reads that file's rules and answers **404** to everything. Start it with an empty config file
instead:

```sh
touch empty.yml                     # Windows: type nul > empty.yml
cloudflared tunnel --config empty.yml --url http://127.0.0.1:8787
```

### Option B: named tunnel (stable address; needs a free Cloudflare account with a domain on it)

```sh
cloudflared tunnel login                                   # opens the browser once
cloudflared tunnel create kino-sync                        # creates the tunnel and its credentials file
cloudflared tunnel route dns kino-sync sync.example.com    # a name on your domain
cloudflared tunnel run --url http://127.0.0.1:8787 kino-sync
```

Your address is then always `https://sync.example.com`. To start the tunnel together with your
computer, see Cloudflare's guide "Run as a service".

**Check the tunnel:** open `https://<your address>/healthz` in a browser. It says `ok`. A brand-new
quick-tunnel name can take a minute before your own computer finds it ("could not resolve host"); the
phone usually finds it at once.

## 3. Install the plugin in Kino

The server also hands out the plugin's files, so you install the plugin from your own address.

1. On the phone, open **Menu ▸ Plugins** and tap **+** (Add plugin). On the TV, open **Plugins** and
   choose **Add plugin**.
2. Leave the type on **Kino**. In **Plugin address**, type
   `https://<your address>/plugin/kino-plugin.json`, then tap **Add**. (Or type
   `kinotvapp/kino-plugin-sync-server/plugin` to install the same plugin from this repository, signed by
   its author: then the sheet shows "Firmado".)
3. Kino shows **Install Sync Servidor**. It says *This is a community plugin: install it if you
   trust whoever created it.* There is no "signed" mark: the plugin comes from an address, not from a
   signed GitHub repository.
4. Tap **See details** and read the lines in red:
   - *Will sync your data through its service: the plugin and its service can read it.*
     This is true; see [What the server can and cannot see](#what-the-server-can-and-cannot-see).
   - *Can connect to any public server on the internet (https only, never your home network).*
5. Tap **Install**. You can ignore the "watch its content on Home" message: this plugin shows nothing
   on Home, it only syncs.

The plugin's address keeps the tunnel's name in it. With a quick tunnel, install the plugin on each
device while that same tunnel is running. Kino also copies the plugin to your other paired devices by
that address, and each one downloads it itself.

## 4. Turn the provider on

1. Open **Settings ▸ Settings for all profiles ▸ Sync ▸ Provider**. *Sync Servidor* is listed
   below **Local network**.
2. Turn on the switch next to **Sync Servidor**.
3. Kino asks **"Sync with Sync Servidor?"**:
   - Local network sync turns off while you use this provider.
   - If the provider already holds data from another device, it is combined with this device's
     data: nothing that only one of them has is lost.
   - In red: the plugin and its service will be able to read the data.

   Tap **Combine with this device**.
4. The row now says *The token is missing: set it in Connect*, with a **Connect** button.

## 5. Connect: the server address and the token

1. Tap **Connect**. The plugin's form opens. At the top, **Help** says in a few lines what you need
   (the server's https address and its token) and **Open the guide** opens this guide's repository.
   - **Server address**: `https://<your address>`. Type only that: no `/plugin`, no port, no
     `http://`, no `192.168.…`.
   - **Token**: paste the token from step 1.
2. Tap **Save**. The **Status** line says *Connected. The server stores nothing yet.* **Test the
   connection** asks the server again at any time.
3. Go back. The first sync runs at once:
   - The row says *Synced a moment ago*. If it still says *Waiting for the first sync*, leave the
     screen and come back.
   - The server's terminal shows `GET /blob 204` and then `PUT /blob 200`.

From then on, Kino pulls when it comes to the front and every 5 minutes. It pushes about a minute
after something changes. **Sync now** syncs right away.

## 6. Add your second device

The second device needs only the same two settings. Kino derives the same key from the same token,
so no key ever travels between your devices.

With both devices on the same Wi-Fi:

1. Install the plugin on the second device too (step 3), if it is not there yet.
2. On the **second** device (say, the TV), open **Settings for all profiles ▸ Sync ▸ Provider** and
   tap **Receive from another device** under *Sync Servidor*. The provider does not have to be on.
   It shows, for 3 minutes:
   - a QR code;
   - an address such as `192.168.1.`**`23`**`:38917`;
   - a 6-digit code.
3. On the **first** device (the phone that already syncs), open the same screen and tap **Send to
   another device**.
   - Point the camera at the QR.
   - No camera, or you refused it? Kino goes to **Type address**. Type the last number of the address
     and the 6-digit code that the other device shows, then tap **Send**.
   - The phone says *Sent. Confirm it on the other device.*
4. The second device asks **"Received for Sync Servidor: apply?"**. It lists *Server address* and
   *Token*, never their values. Tap **Apply**.
5. It then asks "Sync with Sync Servidor?" as in step 4. Tap **Combine with this device**.

On different networks? On the phone's send screen choose **Other network** and type the words and the
code the TV shows. On a TV the plugin's page shows only its status, **Test the connection** and Kino's
**Sync ▸ Provider** button: the address and the token are drawn on the phone only
(`"devices": ["phone"]`), so a TV gets them with **Receive from another device**.

## 7. Check that it works

1. On the phone, add a title to your library, or watch a minute of something.
2. Tap **Sync now** on the Provider screen, or wait a minute.
3. On the TV, open Kino or tap **Sync now** there. The title is in its library too.
4. The server's terminal shows the `GET /blob` and `PUT /blob` lines of both devices.

## Troubleshooting

| What you see | What it means and what to do |
| --- | --- |
| *The token is missing: set it in Connect* | This device has no token. Tap **Connect** and paste it. |
| *The token does not match, or the saved data is not Kino's*, with **Fix the token** and **Reset sync** | The copy on the server was saved with another token. This happens if you changed `DEMO_TOKEN`, deleted `data/token`, or a device still has an old token. It also happens if something other than Kino wrote to the server. **If one device still has the right token:** copy it to this device (**Fix the token**). **If the old token is gone for good:** on one device tap **Reset sync** and confirm. The server's copy is replaced by this device's copy, made with the token you have now. Then give that same token to your other devices (step 6). |
| Status: *The server does not accept the token. Copy the one in data/token again.* | The token in the plugin is not the one the server uses. Copy `data/token` again, all 43 characters. |
| *The last sync failed: another device was saving at the same time, it will try again* | The server answered `409`: another device wrote first. Kino pulls, merges and pushes again on its own. If you see it all the time, two devices with different tokens are fighting: check the tokens. |
| Status: *The tunnel does not answer: its address may have changed or server.mjs is off* | With a quick tunnel, every restart of `cloudflared` gives a new address. Type the new `https://….trycloudflare.com` in **Server address** on every device, or switch to a named tunnel. Also check that both terminals are still running. |
| Status: *Could not reach the server. Is server.mjs running and the tunnel open?* | The computer is asleep or offline, or `server.mjs` or `cloudflared` stopped. Start them again. Your data is kept. |
| Under the field: *The server address must start with https://…* or *That address is on your local network…* | Kino plugins only speak https on port 443 to public addresses. Use the tunnel's address, never `http://`, `localhost` or `192.168.…`. |
| The tunnel answers 404 to everything | You have a `~/.cloudflared/config.yml`. Start the quick tunnel with `--config empty.yml` (step 2). |
| `429` lines in the server's terminal, or *…is limiting requests* | Too many requests from one address: more than 120 a minute, or more than 10 wrong tokens a minute. Wait a minute. Kino also limits how many requests a plugin makes to an address it did not declare. The limit tells your devices apart by Cloudflare's `CF-Connecting-IP` header only when `cloudflared` runs on the same computer as the server; otherwise all of them share one budget (still limited, never unlimited). |
| *The last sync failed: your data is larger than the provider accepts* | This demo declares snapshots up to 4 MiB (4,194,304 bytes), the most Kino lets a sync provider move. The server itself accepts up to 8 MiB. |
| Installing says Kino only installs plugins from https addresses | Type the tunnel's `https://` address, with `/plugin/kino-plugin.json` at the end. |

## What the server can and cannot see

- **The data is encrypted.** Kino encrypts the snapshot (AES-256-GCM) before handing it to the
  plugin. `data/blob.bin` is ciphertext; the server only stores it and returns it byte for byte.
- **But the key comes from the token.** That is what lets a second device join with just the server
  address and the token. So **anyone who has the token can decrypt the data**:
  - you;
  - the plugin, which reads the token to send it;
  - whoever can read `data/token` on your computer;
  - anyone who copies the token from one of your devices.
- **Cloudflare** carries the traffic through its tunnel over https. It sees the encrypted blob, and
  also the token in the request header.
- **What is in the snapshot:** everything Kino syncs between your devices. That is your library,
  history, progress and settings, plus your plugins and their settings. Passwords are included,
  sealed again inside the snapshot.
- **Keep `data/token` private.** Treat it like a password to all of the above.
- **To change the token:**
  1. Stop the server.
  2. Delete `data/token` (or set a new `DEMO_TOKEN`).
  3. Start the server.
  4. Put the new token on one device and tap **Reset sync** there.
  5. Send the settings to your other devices again (step 6).

## Backing up, stopping and cleaning up

- **Back up:** copy the `data/` folder while the server is stopped.
- **Stop:** press `Ctrl+C` in the `cloudflared` terminal and in the `server.mjs` terminal. Your
  devices keep their data; they just cannot sync until you start both again.
- **Stop using it:** in Kino, on each device, switch **Local network** back on (or turn the provider
  off). Then uninstall the plugin in **Plugins ▸ Installed ▸ Manage ▸ Uninstall**.
- **Remove everything:** stop both programs and delete the folder. Its `data/` folder holds the only
  copy on the server. A named tunnel is removed with `cloudflared tunnel delete kino-sync`.

## For plugin authors

- **`server.mjs`:**
  - `GET /blob` answers 200 with an `X-Version` header, or 204 when empty.
  - `PUT /blob` takes `If-Match: <version>` (`0` for empty). It answers 200 with the new `X-Version`,
    or 409 with the current one, atomically.
  - `Authorization: Bearer <token>` is required, compared in constant time.
  - A body over 8 MiB gets 413. There is a per-address rate limit.
  - Writes are atomic: a temp file, then a rename.
  - `GET /healthz`, and the plugin's files under `/plugin/`.
  - It never logs a token or a body.
- **`plugin/`:**
  - `syncPull`, `syncPush` (a 409 becomes `throw kino.error("conflict")`) and `syncStatus`.
  - A settings form with a status line and a test button, plus `validateSettings`, and the apiVersion 12
    configuration aids: a short `help` (what the person needs, not how to build the server) and a `link`
    to the guide.
  - The manifest declares `"capabilities": ["syncProvider"]` alone (a sync provider plays nothing)
    and `"fetchHosts": "any"`. It also declares
    `"sync": { "keySecret": "token", "provision": ["serverUrl", "token"], "maxBlobBytes": 4194304 }`.
  - `hosts` holds the placeholder `example.invalid`, because a plugin without a `url` setting must
    declare at least one host.
- **`maxBlobBytes` is 4 MiB:** inside `syncPull` and `syncPush` only, Kino lets `kino.fetch` carry
  ceil(`maxBlobBytes` × 4/3) + 64 KB (the base64 blob and the rest of the request); every other call keeps
  the 1 MB request cap. Declare what your server really takes: it also caps those calls.
- **Tests:** `node --test test/*.test.mjs` runs the server's tests, and the plugin under Kino's Node
  kit (the `sdk/` folder of this repository).
- **The contract:** Kino's plugin guide (<https://kinotvapp.github.io/kino-plugins/en/sync-providers/>),
  `contract.json` and `kino.d.ts` in this repository.
