# Sticky New Tab Helper

One job: turn **Sticky New Tab** back on after Chrome switches it off.

## Why it has to be a separate extension

Chrome disables any extension that overrides the new tab page when you use **Change it back** in the
Customize Chrome panel. That is deliberate anti-hijacking behavior and cannot be opted out of.

A disabled extension cannot fix this itself, because nothing of it is running. `launchd` cannot
either: the enabled/disabled state lives in `Secure Preferences`, which is HMAC-signed, so Chrome
rejects outside edits. The only thing that can re-enable an extension is another extension holding
the `management` permission. Hence this.

## Why it waits a minute

You disable Sticky New Tab precisely to reach Chrome's own new tab page and change something there.
Turning it straight back on would put our page in front of you before you could. So it waits one
minute, and posts a notification with **Turn on now** if you finish sooner, or **Keep off** if you
meant to leave it off.

`chrome.alarms` is used rather than `setTimeout` because an MV3 service worker can be killed at any
point; an alarm wakes it back up.

If Chrome refuses `setEnabled` without a user gesture, the notification button is one, and the
fallback notification says so instead of failing quietly.

## Install

`chrome://extensions` > Developer mode > Load unpacked > this folder.

Nothing to configure. It matches the other extension by name, not id, so moving that folder (which
changes its id) does not break this.
