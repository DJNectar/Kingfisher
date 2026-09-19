# Packaging Kingfisher as a Mac app

    ./packaging/make-app.sh          # writes dist/Kingfisher.app

A `.app` is a folder with a prescribed layout, not a compiled binary, so this
builds anywhere — including the Linux machine the app is developed on. No
Xcode, no Mac required.

```
Kingfisher.app/
  Contents/
    Info.plist              name, version, icon, minimum macOS
    PkgInfo                 bundle marker for older Finders
    MacOS/Kingfisher        the launcher (launcher.sh)
    Resources/
      Kingfisher.icns       the icon (generated, see below)
      app/                  index.html + src/ — the web app itself
```

## What the launcher does

Kingfisher has to be **served**, not opened from disk: a browser gives a
`file://` page an opaque origin, which disables both ES module loading and the
file access the app depends on. So the launcher starts a server on the loopback
interface, opens a browser at it, and stays in the foreground — which is what
puts Kingfisher in the Dock and makes Quit take the server down with it.

It assumes nobody is watching a terminal, because in a `.app` nobody is.
Anything that goes wrong says so in a dialog. The one failure worth knowing
about: macOS ships `python3`, but on a machine that has never had the developer
tools installed it is a stub that prompts instead of running, so the launcher
tests it rather than trusting it.

## The icon

The artwork is `packaging/icon-source.png`. `make-icon.py` resizes it to every
size macOS asks for and packs the results into `Kingfisher.icns`, plus a 128px
copy at `src/ui/assets/kingfisher-128.png` for the web app's favicon and header
mark — so the Mac app and the browser app are plainly the same thing.

Both ends are written by hand because the usual route (`sips` and `iconutil`)
needs macOS. Neither format is difficult: PNG is a zlib stream of filtered
scanlines, an `.icns` is a magic word, a length, then one chunk per size.

Resizing box-filters over **premultiplied alpha**. Averaging straight RGBA pulls
the colour of fully transparent pixels into the edges of the art, which shows
up as a dark fringe around the rounded corners — the one place a scaled icon
usually goes wrong.

To change the icon, replace `icon-source.png` (a square RGBA PNG, 1024px or
larger) and re-run the script.

## What this does NOT fix

**Gatekeeper.** An unsigned `.app` gets the same "Apple could not verify…"
dialog an unsigned `.command` does. macOS cares whether it is signed, not what
kind of thing it is. Clearing it needs an Apple Developer account ($99/year),
then signing and notarising:

    codesign --deep --force --options runtime \
      --sign "Developer ID Application: YOUR NAME (TEAMID)" dist/Kingfisher.app
    ditto -c -k --keepParent dist/Kingfisher.app dist/Kingfisher.zip
    xcrun notarytool submit dist/Kingfisher.zip \
      --apple-id you@example.com --team-id TEAMID --wait
    xcrun stapler staple dist/Kingfisher.app

Those four commands must run on a Mac. Until then, the one-time `xattr -cr`
described in `START HERE.txt` clears it per machine.
