/* East End service worker: keeps the app's own files on the phone so it opens instantly and offline,
   and shows notifications. It never touches calls to GitHub: those always go straight to the network.
   Bump VERSION on every release (tools/release.sh does it) so phones pick up the new files. */
const VERSION = "2.0.0";
const CACHE = "ee-shell-" + VERSION;
const FILES = [
  "index.html", "app.css", "app.js", "config.js", "manifest.webmanifest",
  "fonts/instrument-serif.woff2", "fonts/instrument-serif-italic.woff2", "fonts/figtree.woff2", "fonts/ibm-plex-mono-400.woff2", "fonts/ibm-plex-mono-500.woff2",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png", "icons/favicon-32.png"
];
const SCOPE = self.registration.scope;
const KNOWN = new Set(FILES.map((f) => new URL(f, SCOPE).href));

self.addEventListener("install", (event) => {
  // Each file is fetched with ?v=VERSION so a stale copy held by a browser or CDN cache can never be stored as the new one.
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(FILES.map((f) => {
        const url = new URL(f, SCOPE).href;
        return fetch(url + "?v=" + encodeURIComponent(VERSION), { cache: "reload" }).then((res) => {
          if (!res.ok) throw new Error("could not fetch " + f);
          return cache.put(url, res);
        });
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ee-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // GitHub and listing sites: not ours to handle
  const bare = url.origin + url.pathname;
  const isPage = req.mode === "navigate" && bare.startsWith(SCOPE);
  if (!isPage && !KNOWN.has(bare)) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(isPage ? new URL("index.html", SCOPE).href : bare).then((hit) => hit || fetch(req))
    )
  );
});

/* Notifications. The message format is the declarative one newer iPhones show on their own:
   { "web_push": 8030, "notification": { "title", "body", "navigate", "tag", "app_badge" } } */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const n = (data && data.notification) || data || {};
  const jobs = [
    self.registration.showNotification(String(n.title || "East End"), {
      body: String(n.body || ""),
      tag: String(n.tag || "east-end"),
      icon: new URL("icons/icon-192.png", SCOPE).href,
      data: { url: String(n.navigate || "") }
    })
  ];
  const badge = parseInt(n.app_badge, 10);
  if (navigator.setAppBadge && badge >= 0) jobs.push(badge ? navigator.setAppBadge(badge) : navigator.clearAppBadge());
  event.waitUntil(Promise.all(jobs.map((j) => Promise.resolve(j).catch(() => {}))));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let target = SCOPE;
  try {
    const u = new URL((event.notification.data && event.notification.data.url) || SCOPE, SCOPE);
    if (u.href.startsWith(SCOPE)) target = u.href;                 // only ever open this app
  } catch (e) { target = SCOPE; }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(SCOPE) && "focus" in c) { c.postMessage({ type: "open", url: target }); return c.focus(); }
      }
      return self.clients.openWindow(target);
    })
  );
});
