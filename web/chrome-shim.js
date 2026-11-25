/* The board on desktop.html is the extension's own newtab.js, copied in unchanged. This gives
   it the few chrome.* calls it makes, on top of localStorage and the storage event (which
   fires in the other open tabs, the way chrome.storage.onChanged does). */
(function () {
  'use strict';
  const PREFIX = 'ntp.';
  const parse = v => { try { return v === null || v === undefined ? undefined : JSON.parse(v); } catch { return undefined; } };
  const read = k => { try { return parse(localStorage.getItem(PREFIX + k)); } catch { return undefined; } };
  const listeners = [];

  window.chrome = {
    storage: {
      local: {
        get: async keys => {
          const out = {};
          for (const k of [].concat(keys)) {
            const v = read(k);
            if (v !== undefined) out[k] = v;
          }
          return out;
        },
        set: async obj => {
          for (const [k, v] of Object.entries(obj)) {
            try {
              localStorage.setItem(PREFIX + k, JSON.stringify(v));
            } catch {
              /* over quota, most likely an image still waiting to upload. The server keeps it. */
            }
          }
        },
      },
      onChanged: { addListener: fn => listeners.push(fn) },
    },
    runtime: { getURL: p => p },
    tabs: { create: ({ url }) => window.open(url, '_blank', 'noopener') },
  };

  addEventListener('storage', e => {
    if (!e.key || !e.key.startsWith(PREFIX)) return;
    const k = e.key.slice(PREFIX.length);
    const changes = { [k]: { oldValue: parse(e.oldValue), newValue: parse(e.newValue) } };
    for (const fn of listeners) fn(changes, 'local');
  });
})();
