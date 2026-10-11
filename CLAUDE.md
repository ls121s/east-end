# East End app

This repository is the phone app's code. It is **public**. GitHub Pages serves it from `main`.

## Rules

1. **No data here, ever.** No listings, addresses, names, notes, stars, criteria, prices, access codes or anything else from the private notebook. Not in code, comments, tests, screenshots or commit messages. Before every commit, read `git diff --cached`. The notebook's `CLAUDE.md` holds a grep that checks this folder for private words. Run it before every push.
2. **The app talks to GitHub and nothing else.** Keep the Content-Security-Policy in `index.html` strict. No outside scripts, fonts, images, analytics or links to other services, apart from listing links and map links the owner taps.
3. **Everything shown is escaped.** All notebook text goes through `esc()` and links through `safeUrl()`.
4. **The access code never leaves the phone** except as the Authorization header on calls to `api.github.com`. Never log it or put it in a URL.

## How it fits together

- `index.html`, `app.css`, `app.js`: the whole app. No build step, no packages.
- `config.js`: version, the notebook's repository name and the public half of the notification key. The owner's GitHub name is read from the page address (`<owner>.github.io`).
- `sw.js`: keeps the files on the phone so the app opens instantly and offline, and shows notifications. It never touches calls to GitHub.
- The app reads one file, `app.json`, from the private notebook, and reads and writes `me/stars.json`, `me/notes.json`, `me/prefs.json` and `me/push.json` there. The notebook's `CLAUDE.md` documents those files.
- Photos and map images are files in the notebook too: `app.json` names them under each listing's `photo` and under `map`, with their blob shas. The app fetches them as bytes through the same contents API and keeps them in the phone's Cache storage `ee-images-1`. Settings can clear it.

## Changing the app

1. Make the change.
2. Test it: in the notebook repository run `node tools/dev/server.mjs --app <path to this folder>`, then `node tools/dev/test.mjs`. All checks must pass. `node tools/dev/shots.mjs <folder>` takes phone-size screenshots of every screen. Look at them.
3. `bash tools/release.sh <new version>` sets the version in `config.js` and `sw.js`. Phones only pick up new files when the version in `sw.js` changes.
4. Commit and push to `main`.

## Design

Light theme only, by the owner's choice: a cream page, paper cards with a 1 px line and no shadow (the map card, the This morning card and the toast are the exceptions), deep forest green as the only strong colour. Colors are the tokens at the top of `app.css`. Type is Instrument Serif (weight 400 only, never bold) for headings and big numbers, Figtree for text and IBM Plex Mono for figures. Phone first: one column, a tab bar at the bottom (Home, Map, Board, Starred, Ask), cards that slide up as sheets. Only `transform` and `opacity` animate, and `prefers-reduced-motion` is respected everywhere. Writing is direct, numbers first, short sentences, no em dashes.
