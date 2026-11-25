#!/usr/bin/env python3
"""Snapshot the notes out of Chrome's storage onto disk.

chrome.storage.local lives in a LevelDB inside the Chrome profile. If the extension is removed,
or the profile is lost or corrupted, that goes with it, and nothing in an extension can write a
file outside itself. So this reads the LevelDB from outside and keeps timestamped copies here.

A snapshot is written only when the notes actually changed, so this is cheap to run often.
Restore with ./restore-notes.sh <file>.
"""

import base64, datetime, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKUPS = os.path.join(HERE, "backups")
PROFILE = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default")
KEEP_RECENT = 40      # most recent snapshots, whatever their age
KEEP_DAILY_DAYS = 180 # plus the first snapshot of each day this far back


def extension_id():
    """Derive the id from the manifest key, the same way Chrome does."""
    key = json.load(open(os.path.join(HERE, "manifest.json")))["key"]
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def read_notes(store_dir):
    """Pull the last complete notes array out of the LevelDB files.

    Not a LevelDB parser: the values are plain JSON, and the log is append-only, so the last
    array that decodes cleanly is the current one. raw_decode does the validating.
    """
    blob = b""
    for name in sorted(os.listdir(store_dir)):
        if name.endswith((".log", ".ldb", ".sst")):
            blob += open(os.path.join(store_dir, name), "rb").read()

    text = blob.decode("utf-8", "replace")
    decoder = json.JSONDecoder()
    best = None
    for m in re.finditer(r'\[\{"', text):
        try:
            value, _ = decoder.raw_decode(text[m.start():])
        except ValueError:
            continue
        if isinstance(value, list) and value and isinstance(value[0], dict):
            if {"id", "color"} <= set(value[0]):
                best = value
    return best


def prune():
    files = sorted(f for f in os.listdir(BACKUPS) if f.startswith("notes-"))
    keep = set(files[-KEEP_RECENT:])
    cutoff = datetime.date.today() - datetime.timedelta(days=KEEP_DAILY_DAYS)
    seen_days = {}
    for f in files:
        day = f[6:14]
        seen_days.setdefault(day, f)
    for day, f in seen_days.items():
        try:
            if datetime.datetime.strptime(day, "%Y%m%d").date() >= cutoff:
                keep.add(f)
        except ValueError:
            keep.add(f)
    for f in files:
        if f not in keep:
            os.remove(os.path.join(BACKUPS, f))


def main():
    quiet = "--quiet" in sys.argv
    say = (lambda *a: None) if quiet else print

    store = os.path.join(PROFILE, "Local Extension Settings", extension_id())
    if not os.path.isdir(store):
        say("  no storage yet for", extension_id())
        return

    notes = read_notes(store)
    if notes is None:
        say("  could not read notes (extension may never have saved)")
        return

    os.makedirs(BACKUPS, exist_ok=True)
    latest = os.path.join(BACKUPS, "latest.json")
    current = json.dumps(notes, sort_keys=True)

    if os.path.exists(latest) and json.dumps(json.load(open(latest)), sort_keys=True) == current:
        say("  unchanged (%d notes)" % len(notes))
        return

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(BACKUPS, f"notes-{stamp}.json"), "w") as f:
        json.dump(notes, f, indent=2)
    with open(latest, "w") as f:
        json.dump(notes, f, indent=2)

    prune()
    say("  saved %d note(s) -> backups/notes-%s.json" % (len(notes), stamp))


if __name__ == "__main__":
    main()
