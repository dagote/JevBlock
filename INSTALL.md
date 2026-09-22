# Install notes

The unpacked extension version in this repo is `extension/manifest.json` (currently **0.0.8**). The 0.3.3 notes below describe an older Chrome-vs-disk mismatch; they are not the current package version. Server **0.2.4** is the matching adgate build. Reload the unpacked extension before a live Extreme retest.

# Why you still see 0.1.0

Chrome **does not load** the extension from:

`http://192.168.0.119:8080/files/experiments/adblock-systemone/extension/`

That URL is only File Browser. Updating files on the server does **not** update an unpacked extension already installed in Chrome (especially on another PC). Your install ID `kokejojpcncgfkneioekeaeblfegjdio` is still the **0.1.0** copy Chrome loaded the first time.

Disk / LAN already serve **0.3.3**. Chrome is the stale part.

## Install 0.3.3 on the machine that runs Chrome

### Option A — zip (recommended)

1. On the PC where Chrome runs, download:

   **http://192.168.0.119:8080/adgate-extension/adgate-extension-v0.3.3.zip**

2. Extract to a local folder, e.g. `Downloads/adgate-extension`
3. `chrome://extensions` → **Remove** the old System One Adgate (0.1.0)
4. Developer mode → **Load unpacked** → select the extracted folder that **contains `manifest.json`**
5. Confirm the card says **Version 0.3.3**

### Option B — if Chrome runs on ruined-server itself

Remove old extension, Load unpacked:

`/home/ruin/projects/experiments/adblock-systemone/extension`

## Verify

Popup title: **v0.3.3**  
Description mentions `v0.3.3`  
After a scan, logs show `client: "extension-bg-0.3.3"`
