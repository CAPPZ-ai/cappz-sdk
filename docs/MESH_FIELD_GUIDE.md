# CAPPZ Mesh field guide

A replacement network for when the internet and the cell network are down. Phones, laptops and small computers pass messages to each other directly, over Wi-Fi or Bluetooth range, and carry them on when people move. Every device checks every message: who sent it, whether that person is a member, and whether they may send at that priority. A captured phone can be cut off, and a forged evacuation order is dropped at the first hop.

This guide has two parts:

- **Part A: before.** Do this while the internet still works. It takes about an hour for a coordinator and ten minutes per member.
- **Part B: during.** None of it needs any network connection beyond the devices themselves.

> **Status.** The protocol, its security checks and the laptop/Android program have been tested in simulation and with real programs on one machine. The phone web app has been tested in Chrome. It has **not** yet been field-tested across many physical phones, on iPhone Safari, or under real jamming. Run a drill (step A7) before you rely on it. Use it alongside your other emergency communications (radio, runners, agreed meeting points), never instead of them.

---

## Who does what

| Role | Who | May send |
|---|---|---|
| **Authority** | One or two trusted organisers. They hold the charter key. | Founds the mesh, grants and revokes roles |
| **Coordinator** | Shelter or block leaders | FLASH, IMMEDIATE, PRIORITY, ROUTINE; broadcasts |
| **Responder** | Medics, firefighters, wardens | Up to IMMEDIATE; broadcasts |
| **Member** | Residents who were given a grant | Up to PRIORITY; broadcasts |
| **Guest** | Anyone with the app but no grant | ROUTINE direct messages only (no broadcasts) |

Precedence, from highest to lowest:

- **FLASH**: life-threatening, act now.
- **IMMEDIATE**: urgent.
- **PRIORITY**: important.
- **ROUTINE**: everything else.

When a device's storage is full, higher precedence pushes lower out. Each sender may send only a limited number of messages per minute, and every device enforces that limit for every sender.

## Which devices can join, and how

| Device | How it joins | Links it can make |
|---|---|---|
| Linux laptop, Raspberry Pi | The `cappz-mesh` program (Node.js) | Wi-Fi/Ethernet (TCP), and it serves the phone web app |
| Mac | The `cappz-mesh` program (Node.js) | Wi-Fi/Ethernet (TCP), and it serves the phone web app |
| Windows PC | The `cappz-mesh` program (Node.js) | Wi-Fi/Ethernet (TCP), and it serves the phone web app |
| Android phone | The `cappz-mesh` program in **Termux**, or the web app in Chrome | Wi-Fi/hotspot (TCP); web app as for iPhone |
| iPhone, iPad | The **web app in Safari**, opened from a nearby node | To that node (WebSocket); directly to another phone on the same Wi-Fi (pairing code) |
| iPhone, iPad, Mac, Android: **native app** | Build from `packages/cappz-mesh-native` (**not yet compiled or tested**) | Phone to phone with **no Wi-Fi network at all**: Apple MultipeerConnectivity, or Android Nearby Connections (Bluetooth / Wi-Fi Direct) |
| Any node + a **LoRa board** (RNode firmware) on USB | `--lora /dev/ttyUSB0 --lora-region …` (B9) | Kilometres between sites, at a few kbit/s: text and alerts, not voice |

An iPhone cannot run the program itself. It needs one laptop, Pi or Android phone running `cappz-mesh` on the same Wi-Fi, and that device serves the app. After that, the iPhone is a full member: it holds its own keys, and the node that serves it cannot read its direct messages.

---

# Part A: before (internet still available)

Order for the authority: A2 (wallet), then A3 (charter), then A1 (go-kit, which carries the charter), then A4. Members do A2, A5 and A6.

## A1. Make the go-kit (the authority, once)

The **go-kit** is one folder that contains everything needed to run a node. It has no install step and no downloads, so a device that has never seen it can run it during an outage:

- `cappz-mesh.mjs`: the whole program, with every dependency bundled in one file.
- Node.js runtimes for Linux, Raspberry Pi, Mac and Windows.
- The phone app.
- Launchers you can double-click.
- Your mesh's charter.
- This guide.
- A manifest signed by the authority, so anyone can check that their copy was not altered.

Do this after A3, so that the kit carries the charter.

1. Install Node.js 22 (https://nodejs.org) and get the SDK:

   ```sh
   git clone https://github.com/CAPPZ-ai/cappz-sdk cappz-sdk
   cd cappz-sdk
   npm install
   npx vitest run src/test/mesh.test.ts      # should end with all tests passing
   ```

2. Build and sign the kit. The `--sign` option uses the authority's wallet, and the build downloads each Node.js runtime and checks it against nodejs.org's published SHA-256:

   ```sh
   npm run mesh:kit -- --charter charter.json --sign --with-node all
   ```

   This writes `dist/cappz-mesh-kit/` and `dist/cappz-mesh-kit.zip`, and prints the kit's **fingerprint**, for example `3cd0 7df3 71b0 97c5`.
   - **Write the fingerprint down and announce it.** People check it before they run a copy.
   - With `--with-node all`, the zip is roughly 150 to 250 MB.
   - Use `--with-node linux-arm64,win-x64` for only the platforms you need. One platform is about 45 MB.
   - Without `--with-node`, the kit is under 1 MB, but each computer then needs its own Node.js 20 or newer.

3. Copy `dist/cappz-mesh-kit.zip` to several USB sticks and SD cards, and to every member's laptop. Unzipped, it is ready to run.

4. **Android phones** cannot use the bundled runtimes. Before the outage:
   1. Install **Termux from F-Droid** (the Google Play version is outdated).
   2. In Termux, run:

      ```sh
      pkg install nodejs-lts
      termux-setup-storage
      ```

   3. Keep the Termux APK file on the stick too, so other Android phones can install it offline. They will need "install unknown apps" allowed.
   4. Copy the kit folder into Termux's home folder (`cp -r ~/storage/shared/cappz-mesh-kit ~/`). Shared storage does not allow running programs.

5. **iPhones and iPads** need nothing from the kit: they use the phone app that any running node serves (A6).

In the commands below, `npm run mesh -- <command>` (in an SDK checkout) and `node cappz-mesh.mjs <command>` (in a kit) do the same thing. In a kit, use the launcher: `sh start.sh <command>` on Linux, Mac and Termux, or `start.bat <command>` on Windows.

## A2. Each person creates a wallet

On each laptop, Pi or Termux phone:

```sh
npm run mesh -- wallet
```

This prints a **wallet address** (66 hex characters) and saves a 24-word phrase in `~/.cappz-mesh/wallet.json`.

- **Write the 24 words on paper** and keep the paper apart from the device. They are the only way to cut off this device if it is lost or seized.
- Give your wallet address (not the words) to the coordinator, as text, a file or a QR code.

iPhone or iPad users do this in step A6.

## A3. The authority founds the mesh

On the authority's laptop:

```sh
npm run mesh -- wallet                                   # if not done yet
npm run mesh -- charter --name "Riverside block"          # add --authority <address> for a second authority
```

This writes `charter.json` and prints the **mesh id**. Every member checks this id. Copy `charter.json` onto the go-kit stick.

A second authority (`--authority <their address>`) can revoke grants if the first authority's laptop is lost.

## A4. The authority grants roles

For each person, using the wallet address they gave you:

```sh
npm run mesh -- grant <their address> --role member        # or responder, coordinator
```

This writes `grant-<address>.json`. Give that file to the person, by USB stick, AirDrop or message. A grant names one wallet and is useless to anyone else, so it is not secret. Grants last 180 days by default (`--days N` to change).

## A5. Each laptop, Pi and Termux phone joins

```sh
npm run mesh -- join --charter charter.json --grant grant-<your address>.json
```

Leave out `--grant` to join as a guest. This creates the device's own keys. They are declared by your wallet and kept in `~/.cappz-mesh/device.json`. Keep that file private. Copy `~/.cappz-mesh/device-declaration.json`, which is public, onto the go-kit stick next to your name. You need it to revoke this device if it is lost (B6).

## A6. iPhones and iPads join (via a nearby node)

1. Start a node on a laptop, Pi or Android phone (step B2). Put the phone on the same Wi-Fi network or hotspot.
2. The node prints a line such as `phones: open https://192.168.43.17:41480/`. Open that address in **Safari**. If the node's computer has a name (Macs, and most Linux machines), `https://<computer-name>.local:41480/` also works, and it keeps working when the IP address changes.
3. Safari warns that the connection is not private. This is expected: the node made its own certificate, because no certificate authority is reachable during an outage.
   - The node prints its certificate fingerprint (`certificate SHA-256 …`). Careful users can compare it on the warning page.
   - Tap **Show Details**, then **visit this website**, and confirm.
4. In the app, follow the three numbered steps:
   1. **Create wallet.** Write the 24 words on paper. Tap **Share my address with the coordinator**.
   2. **Use this node's charter.** Check that the mesh id shown matches the coordinator's.
   3. **Open the grant file** the coordinator sent you (AirDrop it to Files, then pick it), or tap **Paste grant**.
5. Tap **Set up this phone**.
6. In Safari, tap **Share**, then **Add to Home Screen**.
7. Tap **Download backup** and keep the file in Files. It contains your 24 words and your keys, so treat it like the paper copy. It also lets someone revoke this phone (B6) by extracting `device.credentials.decl` into a file.

**Important.** Safari keeps the app's data per address. If you later open the app from a different node, or the same node gets a new IP address, it will look empty. Open **Backup, restore** and restore your backup file. Using the `.local` name avoids most of these cases.

Android phones without Termux can use the same web app in Chrome.

## A7. Run a drill (do not skip)

With everyone together:

1. Turn **off** mobile data and any internet link: airplane mode, then Wi-Fi back on.
2. Start one hotspot (step B1) and have everyone join it and start their node or app.
3. The coordinator sends a FLASH broadcast. Everyone should see it.
4. Send direct messages between people. The sender sees `✓ delivered` when the recipient's receipt comes back.
5. Split into two groups out of Wi-Fi range of each other. Send messages from each group, then have one person walk between the groups. The messages should arrive after that person joins the other group.
6. Practise revocation (step B6) on a test device.
7. Practise the USB carry (step B7).

Write down what did not work and fix it now.

---

# Part B: during (no internet needed)

## B1. Make a local network

Devices need to share a network, but that network does not have to reach the internet. Use whichever is available:

- **An Android phone's hotspot:** Settings → Hotspot & tethering → Wi-Fi hotspot. On most phones this works with no SIM signal.
- **A Linux laptop or Raspberry Pi as an access point:**

  ```sh
  nmcli dev wifi hotspot ifname wlan0 ssid MESH password 'choose-a-passphrase'
  ```

- **A battery-powered travel router.** It does not need an internet uplink.
- **Wi-Fi Direct groups** (Android), or a plain Ethernet switch.
- **iPhone Personal Hotspot.** This often requires a working mobile data connection, so do not count on it.
- **Recent macOS** no longer offers "Create Network". A Mac can join a network but usually cannot make one.

Several networks are fine. People who walk between them carry messages across, as in step A7.5.

## B2. Start a node

```sh
npm run mesh -- run
```

It prints:

- the phone address (`phones: open https://…:41480/`), and
- `link up …` each time another node is found.

Nodes on the same network find each other automatically. If a network blocks this, name a peer directly:

```sh
npm run mesh -- run --peer 192.168.43.17:41460
```

Useful options:

| Option | Effect |
|---|---|
| `--no-relay` | Battery saver: send and receive only, do not carry for others |
| `--channel alerts --channel water` | Channels to show |
| `--store-mb 256` | Space for carrying others' messages (default 64 MB) |
| `--no-web` | Do not serve the phone app |

Platform notes:

- **Android (Termux):** run `termux-wake-lock` first so the phone does not stop the node. Keep Termux in the foreground or pinned.
- **Mac:** allow incoming connections when the firewall asks.
- **Windows:** allow Node.js through Windows Defender Firewall on **private** networks.

## B3. Messaging: names, everyone, voice, blocking

**Your name.**
- In the program: `/alias Ana`, or start it with `--alias Ana`.
- On a phone: **Me → Name → Save**.

Names travel with your contact announcement and are signed by your device, so nobody can publish a name *for* you. Names are not unique, though: two people can both be "Sam". Every name is therefore shown with the start of the person's address, for example `Sam (02ab12…cd34)`, and a ⚠ means several people use that name. Give someone your own label with `/nick @Sam Sam from the clinic` (or **People → nickname**); a nickname exists only on your device and replaces their chosen name there.

**Program commands:**

| Command | What it does |
|---|---|
| `text …` | Message to `#general`, for everyone who reads it |
| `/all text …` | Message to **everyone**: every device shows it. Raise `/prec` for what is important (FLASH only for life-threatening news). |
| `/dm @Sam text …` | Direct message, encrypted so only Sam can read it. Use a name, a nickname or the address. If a name matches several people, the program lists them and asks for the address. It never guesses. |
| `/voice @Sam memo.webm`, `/voice all memo.webm` | Send an audio file as a voice message. Received voice messages are saved under `~/.cappz-mesh/voice/`. |
| `/who` | Everyone known, with names and addresses |
| `/block @Sam`, `/unblock @Sam`, `/blocked` | Block or unblock someone, or list who is blocked (see below) |
| `/prec flash` | Precedence of what you send next. You cannot go above your role; the program says when it sent a lower one. |
| `/bc water Tap on Elm St works` | Message to channel `water` |
| `/peers`, `/contacts`, `/stats` | Links, who is reachable, and what the node carried and refused |
| `/quit` | Saves what the node is carrying, then exits |

**On a phone:**
- Choose **To**: **Everyone (important)**, **#general**, or a person.
- Choose the precedence, type, and tap **Send**.
- **Voice:** tap 🎤, speak (up to 30 s), then tap **■ send**. Received voice messages play in the feed.

**Voice messages** are recorded clips, about 1.5 KB per second, and are delivered like text, hop by hop. They are not live calls, because a mesh during an outage rarely has a live path from end to end. Send voice over Wi-Fi links only: over LoRa, one 30-second clip would use about 13 minutes of the legal airtime.

**Blocking** is personal. A blocked person's messages are not shown, direct or to everyone, and your device stops carrying their messages for others; messages it was already carrying are dropped. Their revocations and receipts still count, so blocking never switches off security. To remove someone from the whole mesh, an authority revokes their membership (B6).

**Direct messages need the recipient's key.** Every node announces its key and name when it starts, so you can write to anyone once their announcement has reached you. Until then, `/dm` says there is no key. Messages to everyone always work.

## B4. Link two phones directly (no node in between)

Both phones must be on the same Wi-Fi network or hotspot. Open **Link directly to another phone** on both.

1. Phone 1 taps **Make offer**, then **Share my code** (AirDrop, message, or read it aloud).
2. Phone 2 pastes the code into **Their code** and taps **Answer / Finish**, then shares its own code back.
3. Phone 1 pastes that code and taps **Answer / Finish**.

The status line shows one more link.

## B5. Moving between groups (carrying)

You do not need to do anything. Your device keeps messages for others and hands them on when it meets the next device. It drops each copy once that message's delivery receipt reaches it. Keep the node or app running while you walk. On an iPhone, keep Safari open on the app. iOS pauses web pages in the background.

## B6. A device is lost or seized

Revoke the lost device's key. You need the owner's 24 words and the device's `device-declaration.json`. That file is public: `join` writes it into `~/.cappz-mesh/`, so copy it onto the go-kit stick and keep it with the paper phrase. On any laptop:

```sh
CAPPZ_MESH_PHRASE="the 24 words" npm run mesh -- revoke-device --declaration device-declaration.json --home /tmp/revoker
```

This writes `revocation.json`. Use a separate `--home` such as `/tmp/revoker`, so that you do not mix the lost device's identity into your own.

If the words are not available, an **authority** cuts the person off instead, using the grant file it issued:

```sh
npm run mesh -- revoke-member grant-<their address>.json --charter charter.json
```

This writes `membership-revocation.json`.

Then load the revocation into any running node:

```
/revoke revocation.json          (or membership-revocation.json)
```

The revocation spreads to every device at FLASH. Once a device has received it, that device refuses everything the lost device signs, including its attempts to connect.

Messages the lost device signed **before** a node learned of the revocation may still be passed on. The simulator measures that exposure window.

## B7. Carrying messages on a USB stick or SD card

On the sending side's node:

```
/export /media/usb/mesh-2026-10-28.cpz
```

Walk or drive the stick to the other site. On their node:

```
/import /media/usb/mesh-2026-10-28.cpz
```

Every message in the file is checked like any other, so a tampered or planted file does no harm. Forged messages are refused one by one.

## B8. Bring in a device that was never set up

Anyone with a laptop or an Android phone can join during the outage. They need the kit and the charter, and the kit contains the charter.

**Step 1: get the kit onto the device.** Use whichever of these is available. None of them needs internet.

| From → to | How |
|---|---|
| A USB stick or SD card → any computer | Copy `cappz-mesh-kit.zip` and unzip it. Android needs a USB-OTG adapter. |
| A running node → a computer on the same Wi-Fi or hotspot | Open `https://<node address>:41480/kit/` in a browser (the node prints this address). Accept the certificate warning, download `cappz-mesh-kit.zip`, and unzip it. |
| An Android phone → a laptop, **by USB cable** | Plug in. On the phone, choose **File transfer** and copy the kit folder or zip. Alternatively, turn on **USB tethering** (Settings → Hotspot & tethering). That creates a private cable network with no internet, and the laptop downloads from `https://<phone address>:41480/kit/` if the phone runs a node. |
| A laptop → a laptop, **by Ethernet cable** | Connect the two directly. Both get automatic link-local addresses (169.254.x.x) within a minute. Run a node on the one with the kit; the other opens `https://169.254.x.x:41480/kit/`. Node discovery also works over the cable. |
| A phone or laptop → another, **by Bluetooth** | Use "Share → Bluetooth" (Android) or Bluetooth file exchange (Windows, Linux). This is slow (about 100 KB/s): fine for a kit without runtimes, but it takes several minutes for a 45 MB one. |
| A Mac or iPhone → a Mac | Use **AirDrop**. It works without any network. |
| An Android phone → Android or Windows | Use **Quick Share** (Nearby Share). It works without any network. |

**Step 2: check the copy.**

```sh
sh start.sh verify-kit .        # Windows: start.bat verify-kit .
```

The result should be `"state": "verified-by-authority"`, with the same fingerprint the authority announced.

- `tampered` means the files were changed. **Do not run that copy.**
- On a device's very first kit, nothing on the device is trusted yet, so the program checks itself. The fingerprint comparison with a coordinator is the real check.

**Step 3: start.**

| Device | Command |
|---|---|
| Linux, Raspberry Pi, Termux | `sh start.sh` |
| Mac | Double-click `start.command`. The first time, right-click it and choose **Open**, because it is not from the App Store. |
| Windows | Double-click `start.bat`. |

With no arguments, the launcher runs **quickstart**, which:
1. creates a wallet and prints its 24 words (**write them on paper**);
2. joins the kit's mesh as a **guest**;
3. starts the node, which finds others on the local network by itself.

A guest can send ROUTINE direct messages at once.

**Step 4: get a role.** The newcomer reads their address to a coordinator, and an authority who is on the mesh types into their own node:

```
/grant <newcomer address> member
```

The grant travels over the mesh. On the newcomer's node, `grant received: member` appears; they type `/accept-grant` and are now a member. If the grant came as a file instead (USB stick, AirDrop), use:

```sh
sh start.sh apply-grant grant-<address>.json
```

**Phones without Termux** (iPhone, iPad, any Android) skip all of this: they join the Wi-Fi of a running node and open its phone app (A6). A guest phone receives a `/grant` as a direct message containing the grant's text. To apply it, copy that text, open the setup page again (back up first) and use **Paste grant**, then **Set up this phone**.

## B9. LoRa: kilometres, slowly

A LoRa board running **RNode firmware** (the open firmware used by Reticulum; common boards are LilyGO T-Beam and Heltec LoRa32) turns a laptop or Raspberry Pi into a long-range node. Any KISS TNC also works, but on amateur bands: see the legal note below.

1. **Before the outage:** flash RNode firmware onto the board (`rnodeconf`, from the Reticulum project), and check your country's licence-free band rules.
2. Plug the board in and add these options to `run`:

   ```sh
   npm run mesh -- run --lora /dev/ttyUSB0 --lora-region eu868
   ```

   Pick the region that matches where you are:
   - `eu868`: 869.525 MHz, 10% duty cycle
   - `eu868_1pct`: 868.1 MHz, 1% duty cycle
   - `us915`: 915 MHz, 500 kHz bandwidth

   Optional: `--lora-sf 7…12` (higher reaches further but is slower; default 9), `--lora-txp 14` (dBm), `--lora-freq`, `--duty`.

3. On a Mac the device is `/dev/cu.usbserial-…` or `/dev/cu.usbmodem…`. On Linux, add yourself to the `dialout` group if the device cannot be opened. Windows COM ports and Android USB-OTG are not supported yet.

The node prints the bit rate and the time one packet spends on air. Every node within radio range becomes a neighbour automatically.

**How much fits:** at SF7 (about 5.5 kbit/s), a text message is roughly 1.5–2 KB, which is 6–10 packets and 2–4 seconds of airtime.
- Under the 10% duty cycle, that is a few messages a minute.
- At SF12 or a 1% duty cycle, it is a few an hour.

The node waits rather than break the duty cycle. Use LoRa for alerts and short messages between sites; never use it for voice.

**Legal:** licence-free LoRa bands allow encrypted traffic within their power and duty-cycle limits. **Amateur radio bands generally forbid encryption.** Do not send sealed direct messages through a KISS TNC on amateur frequencies.

## B10. Bluetooth with no Wi-Fi network

- **Android → laptop:** turn on **Bluetooth tethering** on an Android phone (Settings → Hotspot & tethering) and pair a laptop with it. This makes a small IP network over Bluetooth with no internet, and nodes on it find each other as on Wi-Fi. It reaches about 10 m, at roughly 1 Mbit/s.
- **Phone to phone:** for phones with no Wi-Fi network at all, the native apps (`packages/cappz-mesh-native`) use the phones' own Bluetooth and peer-to-peer Wi-Fi. They are written but **not yet compiled or tested**.

## B11. Staying safe

- **Radio gives away location.** Any device that transmits (Wi-Fi, hotspot, Bluetooth) can be located by an adversary with direction-finding equipment. Transmit only when needed. Stop the node or hotspot and use `--no-relay` when you do not need to carry for others.
- **What relays can see:** the sender's wallet address, a tag for the recipient (not the address, but it is linkable), the time and the precedence. They cannot read direct messages. **Broadcasts are readable by anyone in the mesh**, and by anyone holding a member's device.
- **Seized devices:** a seized device holds its keys and whatever it was carrying. Revoke it (B6). Do not keep the 24 words on the device.
- **Do not trust the name of a mesh. Trust its id.** Someone could start a mesh called "Riverside block". Your device accepts only the charter it was set up with.

## Troubleshooting

| Symptom | Check |
|---|---|
| No `link up` | Are you on the same network? Try `--peer <ip>:41460`. Is the firewall allowing Node.js? Some hotspots isolate clients ("AP isolation"): turn that off, or use another hotspot. |
| `not sent: precedence-denied` | Your role cannot send that precedence. |
| `/dm` says no declared encryption key | The recipient's announcement has not reached you yet. Wait for more contacts, or broadcast. |
| iPhone app is empty | You opened it from a different address. Restore your backup (A6). |
| `verify-kit` says `tampered` | Do not run it. Get another copy, from a stick that the authority made or from a node whose kit verifies. |
| Mac says the launcher "cannot be opened" | Right-click `start.command` → **Open** → **Open**. |
| iPhone app cannot connect | Accept the certificate again (A6.3). Make sure the node is still running and on the same network. |
| `--lora` says it cannot open the device | Check the device name (`ls /dev/tty*`). On Linux, run `sudo usermod -aG dialout $USER`, then log in again. |
| Messages over LoRa are slow | Expected. Use a lower SF (7) if the sites are close; keep LoRa for short messages and alerts. |
| Two phones will not pair | Both must be on the same Wi-Fi network. Some hotspots block device-to-device traffic. Pair through a node instead. |

For how it works, the threat model and benchmark results, see [MESH_RESILIENCE.md](MESH_RESILIENCE.md).
