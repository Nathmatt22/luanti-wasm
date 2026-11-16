# Luanti in the browser

This fork is the web build of [Luanti](https://github.com/luanti-org/luanti) (formerly Minetest) that runs on wasmga.me with [Minetest Game](https://github.com/luanti-org/minetest_game). Play it at **https://wasmga.me/games/luanti**.

It is built from [paradust7's web port](https://github.com/paradust7/minetest-wasm) of Luanti 5.18.0-dev, for single player: the main menu has no Join Game or Content tabs, no ContentDB buttons, no Host Server option and no update check, and the pause menu has no Exit to OS. The page owns full screen, so the game's own is off and its full screen key asks the page instead. The page keeps the player's settings and worlds as the game's save: `wg_request_files()` copies them on a thread of their own, between server steps, and hands them to the page.

It plays on phones and tablets too: the browser says whether its pointer is a finger, and a coarse one turns on the game's touchscreen controls and touch-friendly GUI, automatic jumping and the range-select key, just as on Android. A computer with a mouse keeps the desktop setup. Like the Android app, a phone gets landscape once the page is full screen (where the browser's Screen Orientation API allows it), and the touch controls, HUD and chat keep out of the display's safe area — `env(safe-area-inset-*)`, which the browser reports when the page uses `viewport-fit=cover` — so a notch or the home indicator does not hide them.

## What's here

- Branch `wasmgame` (this one) is paradust7's commit [`6f532b5`](https://github.com/paradust7/luanti/commit/6f532b5ed03a6aa70091412114b5dde3d33c6f87) (Luanti [`db44f2f`](https://github.com/luanti-org/luanti/commit/db44f2f58) plus the web port) with our changes on top as a commit, so `git log` and the diff against `6f532b5` show everything we changed.
- [`wasmgame/`](../wasmgame) holds the build script, the same changes as `luanti.diff` against that commit, and `webport.diff` for paradust7's build scripts ([minetest-wasm `5bfae52`](https://github.com/paradust7/minetest-wasm/tree/5bfae52b53605b39667dfc29cddd59c861e38111)). `build.sh` starts from fresh checkouts, applies both and builds, and its header comment lists each change.

## Building

Needs git, cmake, make, wget, zip, python3, gettext, tcl and Node.js 24; the build scripts fetch and patch emsdk 6.0.8 themselves.

```sh
bash wasmgame/build.sh /tmp/luanti-build
```

It builds zstd, libarchive, paradust7's webshims and libzip, then Luanti, with threads and JSPI, and writes `luanti.js` and `luanti.wasm` next to the script. Under `<work dir>/r2/luanti/` go two zips: the engine's files (builtin scripts, shaders, fonts, translations, textures) and Minetest Game at [`c42e4d0`](https://github.com/luanti-org/minetest_game/commit/c42e4d0c0ff9d27ff7b9b308c3cfc14098dd3a0f).

## Running it

The build uses shared memory, so its page must be cross-origin isolated (COOP `same-origin`, COEP `credentialless`), and it needs a browser with JSPI. The page sets `Module` (`canvas`, `print`, `printErr`, `locateFile`, `onAbort`) and loads `luanti.js`; once `main()` calls `emloop_ready()`, the page writes the engine's files to `/luanti`, the game to `/luanti/games` and the player's files to `/luanti`, calls `emsocket_init()` and then `emloop_invoke_main(argc, argv)`. `irrlicht_resize(w, h)` follows the page's size. `wg_request_files()` answers with `wg_files(ptr, len)` on the page (each file as a u32 path length, the path, a u32 size and the bytes; the page frees `ptr`), or not at all when nothing changed. The page must not use the file system itself while the game runs, as that can wait on the game's threads while they wait on the page.

## Importing your own games

The module installs a game from a zip itself. `emloop_install_game_zip(name, data, size)` — the memory from `emloop_alloc()`, which the module then owns — works out where the game starts inside the archive (a folder of its own holding `game.conf`, or `game.conf` at the top), unpacks everything below that into `/luanti/games/<name>`, reports progress through `emloop_zip_install_progress()` and answers with `emloop_zip_installed("game", name, ok)`. A build with OPFS keeps the game, and it is recorded in the pack database under the `local` version, the way the play page's own games are, so it can be deleted again. `name` is held to what `validPackName()` accepts: 1 to 64 of `A-Z a-z 0-9 _ - .`, not starting with a dot or a dash.

[`wasmgame/web/import-game.js`](../wasmgame/web/import-game.js) is the page side: load it after `luanti.js` and call `luantiImportGame.attach()` for a floating *Importer un jeu* button plus drag and drop anywhere on the page, or call `luantiImportGame.install(file)` from a control of your own. Zipping the game's folder and zipping from inside it both work. A page that already defines `emloop_zip_install_progress` and `emloop_zip_installed` keeps its own; one that does not gets a message at the bottom of the page instead.

The Local tab takes the list of games again each time it is shown, so an imported game appears without reloading.

## Licence

Same as upstream: the code is LGPL-2.1-or-later (see `LICENSE.txt` and `COPYING.LESSER`), and the textures, sounds and fonts are under the licences `LICENSE.txt` lists (CC BY-SA 3.0 and 4.0, CC BY 4.0, Apache 2.0, and others). Minetest Game is LGPL-2.1-or-later with its media under CC BY-SA 3.0, CC BY 3.0 and CC0. Our changes are under the same licence as the files they change.
