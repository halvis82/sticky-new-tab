#!/usr/bin/env python3
"""Copy Chrome's own new-tab settings into the extension.

The extension cannot read this itself: chrome://newtab is unreachable from extension code, and so
are Chrome's prefs. But Chrome writes what the new tab renders from into Preferences on disk, so
this reads that and writes theme.json next to the extension, pulling the background image and the
logo down as local files so the page needs no network at all.

Run it again whenever you change your background or shortcuts in Chrome.
Chrome flushes prefs lazily, so give it ~30s after a change (or quit Chrome) before syncing.
"""

import json, os, sys, urllib.request, datetime

FORCE = "--force" in sys.argv
QUIET = "--quiet" in sys.argv


def say(*a):
    if not QUIET:
        print(*a)

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
PROFILE = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default")
LOGO = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png"


def footer_visible(prefs):
    """Is Chrome drawing its own footer on the new tab page?

    Chrome stores this as NewTabPage.FooterVisible, and writes it only once you toggle the
    footer, so absent means shown. The fallback walk is there in case the key is renamed;
    it skips content_settings, which holds unrelated chrome://newtab-footer engagement rows.
    """
    ntp = prefs.get("NewTabPage")
    if isinstance(ntp, dict) and isinstance(ntp.get("FooterVisible"), bool):
        return ntp["FooterVisible"]

    def walk(o, path=""):
        if isinstance(o, dict):
            for k, v in o.items():
                yield from walk(v, f"{path}.{k}" if path else k)
        else:
            yield path, o

    for path, v in walk(prefs):
        if (
            isinstance(v, bool)
            and "footer" in path.lower()
            and not path.startswith("profile.content_settings")
        ):
            return v
    return True


def argb(v):
    """Chrome stores colors as a signed 32-bit ARGB int."""
    if not isinstance(v, int):
        return None
    return "#%06X" % (v & 0xFFFFFF)


def fetch(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
        f.write(r.read())
    return os.path.getsize(dest)


def write(theme):
    with open(os.path.join(HERE, "theme.json"), "w") as f:
        json.dump(theme, f, indent=2)


def main():
    prefs_path = os.path.join(PROFILE, "Preferences")
    if not os.path.exists(prefs_path):
        sys.exit("no Chrome profile at %s" % PROFILE)

    prefs = json.load(open(prefs_path))
    ntp = prefs.get("ntp", {})
    os.makedirs(ASSETS, exist_ok=True)

    bg = ntp.get("custom_background_dict2") or ntp.get("custom_background_dict") or {}
    theme = {
        "syncedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "background": None,
        "mainColor": argb(bg.get("background_main_color"))
        or argb(prefs.get("browser", {}).get("theme", {}).get("user_color")),
        "shortcutsVisible": bool(
            ntp.get("shortcust_visible", ntp.get("shortcuts_visible", True))
        ),
        "customLinksVisible": bool(ntp.get("custom_links_visible", False)),
        "shortcuts": [],
        "footerVisible": footer_visible(prefs),
    }

    # Pinned + most-visited shortcuts, in Chrome's own order.
    for link in (prefs.get("custom_links") or {}).get("list", []):
        theme["shortcuts"].append(
            {
                "title": link.get("title", ""),
                "url": link.get("url", ""),
                "isMostVisited": bool(link.get("isMostVisited")),
            }
        )

    url = bg.get("background_url")
    if url:
        dest = os.path.join(ASSETS, "background.jpg")

        # Chrome rewrites Preferences constantly. Only the photo URL changing means new work.
        prev = {}
        try:
            prev = json.load(open(os.path.join(HERE, "theme.json")))
        except Exception:
            pass
        unchanged = (
            not FORCE
            and (prev.get("background") or {}).get("sourceUrl") == url
            and os.path.exists(dest)
        )
        if unchanged:
            theme["background"] = prev["background"]
            say("  background  unchanged")
            write(theme)
            return

        try:
            size = fetch(url, dest)
            theme["background"] = {
                "file": "assets/background.jpg",
                "sourceUrl": url,
                "attribution1": bg.get("attribution_line_1", ""),
                "attribution2": bg.get("attribution_line_2", ""),
                "actionUrl": bg.get("attribution_action_url", ""),
                "collection": bg.get("collection_id", ""),
            }
            say("  background  %.1f MB  %s  %s" % (
                size / 1e6, bg.get("collection_id") or "", bg.get("attribution_line_1") or ""))
        except Exception as e:
            say("  background  FAILED: %s" % e)
    else:
        say("  background  none set in Chrome")

    if not os.path.exists(os.path.join(ASSETS, "logo.png")) or FORCE:
        try:
            fetch(LOGO, os.path.join(ASSETS, "logo.png"))
            say("  logo        ok")
        except Exception as e:
            say("  logo        FAILED: %s" % e)

    write(theme)
    say("  color       %s" % theme["mainColor"])
    say("  footer      visible=%s" % theme["footerVisible"])
    say("  shortcuts   %d found, visible=%s" % (len(theme["shortcuts"]), theme["shortcutsVisible"]))
    say("  wrote       theme.json\n\nOpen a new tab to see it.")


if __name__ == "__main__":
    main()
