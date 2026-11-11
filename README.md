# Boostport

Arc stops working on December 22, 2026. Dia and Zen import your tabs and Spaces, but not your Boosts.

Boostport reads your Arc boosts folder and turns every Boost into:

- one Chrome extension for Dia, Chrome, Edge and Brave
- userscripts for Zen, Firefox and Safari
- UserCSS styles for Stylus

**Site:** https://matbcontrol.github.io/boostport/

The page lists every Boost it finds and what will happen to it, and converts up to two Boosts for free. For more, the full converter is a single offline file, available for $5 on [Ko-fi](https://ko-fi.com/s/627b7ebda8).

## Privacy

Everything happens in your browser tab. The page's Content Security Policy blocks all network requests (`connect-src 'none'`), so your Boosts cannot be sent anywhere.

## Where Arc keeps Boosts

macOS: `~/Library/Application Support/Arc/boosts`. Each Boost is a folder named by an id, holding `boost.config.json`, `manifest.json`, `styles.css` and, when it has a script, `content.js`.

---

Boostport is an independent tool, not affiliated with The Browser Company. Arc and Dia are trademarks of their owners.

Copyright 2026 matbcontrol. All rights reserved.
