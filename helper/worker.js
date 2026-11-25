'use strict';

// Chrome disables any extension that overrides the new tab page when you use Change it back,
// and a disabled extension cannot turn itself on again: nothing of it is running. Only another
// extension holding "management" can. That is all this is.
//
// It does not re-enable immediately on purpose. You disable Sticky New Tab precisely to reach
// Chrome's own new tab page and change something there, so flipping it straight back would put
// our page in front of you before you could. It waits, and offers a button if you want it sooner.

const TARGET = 'Sticky New Tab'; // matched by name: an unpacked id changes if the folder moves
const DELAY_MINUTES = 5; // a safety net, not the main path: the notification button is
const PREFIX = 'reenable:';

chrome.management.onDisabled.addListener(info => {
  if (info.name !== TARGET) return;

  chrome.alarms.create(PREFIX + info.id, { delayInMinutes: DELAY_MINUTES });

  chrome.notifications.create(PREFIX + info.id, {
    type: 'basic',
    iconUrl: 'icon.png',
    title: 'Sticky New Tab is off',
    message: 'Open a new tab and customize it. Click Turn on now when you are done.',
    buttons: [{ title: 'Turn on now' }, { title: 'Keep off' }],
    requireInteraction: true, // stays put until you answer, however long customizing takes
  });
});

// If it comes back by any route, drop anything still pending for it.
chrome.management.onEnabled.addListener(info => {
  if (info.name === TARGET) cancel(info.id);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith(PREFIX)) enable(alarm.name.slice(PREFIX.length));
});

chrome.notifications.onButtonClicked.addListener((id, button) => {
  if (!id.startsWith(PREFIX)) return;
  const extId = id.slice(PREFIX.length);
  if (button === 0) enable(extId);
  else cancel(extId);
  chrome.notifications.clear(id);
});

function cancel(extId) {
  chrome.alarms.clear(PREFIX + extId);
  chrome.notifications.clear(PREFIX + extId);
}

async function enable(extId) {
  cancel(extId);
  try {
    await chrome.management.setEnabled(extId, true);
  } catch (e) {
    // Chrome can require a user gesture for this. The notification button is one, so say so
    // rather than failing silently.
    chrome.notifications.create(PREFIX + extId, {
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Could not turn Sticky New Tab on',
      message: 'Chrome refused it without a click. Use the button here, or chrome://extensions.',
      buttons: [{ title: 'Turn on now' }],
      requireInteraction: true,
    });
  }
}
