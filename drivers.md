# Drivers

[← Index](README.md)

Checked **2026-11-23**: from a home connection, and the 🖥 column from the XFeeder VPS (a datacenter IP).

- No GPU vendor publishes an official driver RSS. Mesa is the only real feed.
- The NVIDIA endpoint is NVIDIA's own backend for its driver pages. It is not publicly documented.
- AMD and Intel are server-rendered official pages, so expect occasional breakage. Keep the selectors in one place and test them against saved copies.

## Summary

| Driver | Official source | Format | Stable id | User-Agent | Home | 🖥 VPS |
|---|---|---|---|---|---|---|
| NVIDIA GeForce Game Ready | [DriverManualLookup, Game Ready](https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=120&pfid=929&osID=57&languageCode=1033&isWHQL=1&dch=1&sort1=0&numberOfResults=3) | JSON | `downloadInfo.ID` | any | ✅ | ✅ |
| NVIDIA Studio | same, with `upCRD=1` and **without** `isWHQL` | JSON | `ID` | any | ✅ | not tested (same host) |
| NVIDIA Linux x64 | [DriverManualLookup, Linux](https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php?func=DriverManualLookup&psid=120&pfid=985&osID=12&languageCode=1033&isWHQL=0&numberOfResults=6&sort1=1) | JSON | `ID`, `DisplayVersion` | any | ✅ | not tested (same host) |
| AMD Radeon (Adrenalin) | https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/radeon-rx-9000-series/amd-radeon-rx-9070-xt.html | HTML | version, e.g. `26.11.2` | home: browser only; VPS: any | ✅ | ✅ |
| AMD Chipset | https://www.amd.com/en/support/downloads/drivers.html/chipsets/am5/x870e.html | HTML | revision, e.g. `8.09.28.1124` | same as above | ✅ | not tested (same host) |
| Intel Arc | https://www.intel.com/content/www/us/en/download/785597/intel-arc-iris-xe-graphics-windows.html | HTML | version + mirror id | home: **bot UA only** (a browser UA gets 403) | ✅ | ❌ **403 with any UA** |
| Intel Arc Pro | https://www.intel.com/content/www/us/en/download/741626/intel-arc-pro-graphics-windows.html | HTML (older layout) | version | same as Arc | ✅ | ❌ probably the same |
| Mesa | https://mesa3d.org/news/index.xml | **RSS**: XFeeder reads it today | `guid` | any | ✅ | ✅ (the old `www.` address answers 308) |
| Intel compute-runtime (Linux) | https://github.com/intel/compute-runtime/releases.atom | **Atom** | — | any | ✅ | — |

## NVIDIA

Parameters:

| Parameter | Value |
|---|---|
| `psid` / `pfid` | product series / GPU. `120/929` = RTX 30 / RTX 3080. Every current GPU gets the same Game Ready driver, so one model per family is enough. |
| `osID` | 57 = Windows 10/11 64-bit, 135 = Windows 11, 12 = Linux 64-bit |
| Game Ready | `isWHQL=1` |
| Studio | `upCRD=1` **without** `isWHQL`. Studio entries are stored with `IsWHQL=0`, so `isWHQL=1&upCRD=1` returns nothing. |
| `isWHQL=0` | Game Ready and Studio mixed |

- Lookup tables:
  - operating systems: `https://www.nvidia.com/Download/API/lookupValueSearch.aspx?TypeID=4`
  - GPUs in a series: `…?TypeID=3&ParentID=120`
- Fields are in `IDS[0].downloadInfo`: `ID`, `Name`, `Version`, `DisplayVersion` (Linux), `ReleaseDateTime` ("Thu Nov 12, 2026"), `DetailsURL`, `DownloadURL`, `DownloadURLFileSize`, `IsBeta`, `IsWHQL`, `IsCRD`, `IsRecommended`, `IsFeaturePreview`, `ReleaseNotes`, `BannerURL`.
- **Every text field is percent-encoded.** `ReleaseNotes` is HTML after decoding, with the headline and "Fixed Gaming / General Bugs" lists: ready-made highlights.
- When nothing is found, the API still answers HTTP 200, with `Success:"0"`. That means "no data", not an error.
- Linux branches: `IsRecommended=1` = production, `IsFeaturePreview=1` = new feature branch, `IsBeta=1` = beta. Use `DisplayVersion`, because `Version` is mangled ("595.1120").
- **Do not use:**
  - `download.nvidia.com/XFree86/Linux-x86_64/latest.txt`: stale; it showed 580.126.09 while 620.73.04 was out.
  - The NVIDIA forum "Announcements" category: last post in Feb 2024.
  - The GeForce news RSS: returned 504.

## AMD

- No API and no RSS. On the product page, find the "AMD Software: Adrenalin Edition" block, then the values after the labels "Revision Number", "File Size" and "Release Date".
- Release notes: `https://www.amd.com/en/resources/support-articles/release-notes/RN-RAD-WIN-<maj>-<min>-<patch>.html` (dots replaced by dashes). It has sections Highlights / New Game Support / Fixed Issues / Known Issues as lists. Use the link's `href`; its `title` is wrong.
- Chipset release notes: `RN-RYZEN-CHIPSET-<version with dashes>.html`. One package covers every Ryzen chipset.
- In 1 of 4 fetches from home the driver block was missing. **A missing block means "no data", never "the driver was removed".**
- The release-notes index page needs JavaScript (Coveo), so it can't be used.

## Intel

- New layout (Arc): "Version 32.0.101.9175 WHQL Certified / November 4, 2026".
- Old layout (Arc Pro): "Date 9/25/2026 / Version 32.0.101.8976 - Q3.26 (Latest)". A parser must handle both.
- Links:
  - `https://downloadmirror.intel.com/<mirrorId>/gfx_win_101.<build>.exe`
  - `…/ReleaseNotes_<build>_WHQL.pdf`: highlights are **only in this PDF**
  - `…/readme.txt`: version + build date, a cheap second check
- **From the VPS both pages return 403** with a browser UA and with the XFeeder UA. Options: XFeeder's Scrapling browser fallback, or a different official source (not found yet).
- Not usable: the DSA data feed (a ZIP containing a DLL) and the old community RSS (migrated).

## Linux

- Mesa release notes: `https://docs.mesa3d.org/relnotes/<version>.html`. Tarballs: https://archive.mesa3d.org/.
- **Avoid** `gitlab.freedesktop.org`: it serves an anti-bot (Anubis) page.
- AMD's Linux software release notes are not researched yet.
