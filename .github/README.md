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

It builds zstd, libarchive, paradust7's webshims and libzip, then Luanti, with threads and JSPI, and writes `luanti.js` and `luanti.wasm` next to the script. The workflow takes webshims at [`91c3fe8`](https://github.com/paradust7/webshims/commit/91c3fe85d2cb7f85cc8e19d3f53dc8f252a69ff7) rather than the revision the port pins: that is the protocol the public gateways answer (see *Multiplayer*). Under `<work dir>/r2/luanti/` go two zips: the engine's files (builtin scripts, shaders, fonts, translations, textures) and Minetest Game at [`c42e4d0`](https://github.com/luanti-org/minetest_game/commit/c42e4d0c0ff9d27ff7b9b308c3cfc14098dd3a0f).

## Running it

The build uses shared memory, so its page must be cross-origin isolated (COOP `same-origin`, COEP `credentialless`), and it needs a browser with JSPI. The page sets `Module` (`canvas`, `print`, `printErr`, `locateFile`, `onAbort`) and loads `luanti.js`; once `main()` calls `emloop_ready()`, the page writes the engine's files to `/luanti`, the game to `/luanti/games` and the player's files to `/luanti`, calls `emsocket_init()` and then `emloop_invoke_main(argc, argv)`. `irrlicht_resize(w, h)` follows the page's size. `wg_request_files()` answers with `wg_files(ptr, len)` on the page (each file as a u32 path length, the path, a u32 size and the bytes; the page frees `ptr`), or not at all when nothing changed. The page must not use the file system itself while the game runs, as that can wait on the game's threads while they wait on the page.

## The launcher

What a visit shows first is `menu.js`, once `launcher.js` has put the engine's files in place and before anything is started:

* **Vos mondes** — every world in persistent storage, with the game it uses, its size and when it was last played. *Jouer* starts the engine on that world (`luanti --world /luanti/worlds/<name> --go`); *Enregistrer* asks the engine to pack it into a zip and hands it to the browser's downloads; *Supprimer* deletes it through the engine, so that what the mount sees and what the storage holds stay the same.
* **Jeux** — the installed games, by the `title` in their `game.conf`, with the one this page ships (Minetest Game) marked as such and the ones imported marked as yours. The selected game is the one *Nouvelle partie* proposes: that opens the game's own menu with `menu_last_game` set to it, which is the setting the new-world dialog reads, so the world is created and named there rather than here.
* **Multijoueur** — the address, port, player name and password to join a server with, the gateway to reach it through (see below), and the public server list. *Rejoindre* starts the engine straight into the server; the last address and name are remembered.
* **Importer un jeu (.zip)** — a file picker, and a drop target over the whole page, both going through `emloop_install_game_zip()`. Progress and the outcome are shown where the button is.
* **Réglages du jeu** — the contents of `/luanti/minetest.conf` in a text box, read from the storage by the page and written back to it by *Enregistrer*. The engine is what writes that file (its defaults, and whatever is changed in its own menu), and it reads it at startup, so a saved change applies to the next run. Saving is only offered before the engine holds the mount, which is when the launcher is on screen.

The engine is started with `--logfile ''`, so it writes no `debug.txt`: a page's log is its browser console, which is where everything it prints already goes, and opening a file at the top of a freshly mounted storage was the one thing that failed (`Failed to open "/luanti/bin/./debug.txt": Permission denied`, which Luanti treats as fatal and aborts on). `launcher.js` also creates `bin/` and an empty `minetest.conf` through OPFS before starting, so that the paths the engine builds from `path_user` resolve, and so that it rewrites a settings file that already exists rather than creating one.

The lists are read straight out of the browser's storage from the page: the module mounts its OPFS backend on the directory named `luanti` (see `emsdk_wasmfs_opfs_subdir.patch`), so `/luanti/games/<name>/game.conf` and `/luanti/worlds/<name>/world.mt` are `luanti/games/<name>/game.conf` and `luanti/worlds/<name>/world.mt` to `navigator.storage.getDirectory()`. Nothing is kept on the side, so a world made in the game, or a game installed from ContentDB inside it, is in the launcher on the next visit. A browser without persistent storage still gets the launcher, with *Nouvelle partie* and the import.

Once the engine has quit, `main()` has returned and the wasm instance is spent: *Revenir au launcher* reloads the page, which reads the same storage and is quick, as the packs are already installed.

## Multiplayer

A page cannot open a UDP or TCP connection, so the engine's sockets are relayed by a WebSocket gateway. The page starts the relay with `emsocket_init()` and names the gateway with `emsocket_set_proxy(url)` before `emloop_invoke_main()`; `Luanti.play(args, conf, proxy)` in `launcher.js` is that, and only a join passes a gateway. The public ones the port lists are `wss://eu1.dustlabs.io/mtproxy` (Frankfurt), `wss://luanti.dustlabs.io/proxy` (California, the port's own default), `wss://na1.dustlabs.io/mtproxy` (Dallas), `wss://sa1.dustlabs.io/mtproxy` (São Paulo), `wss://ap1.dustlabs.io/mtproxy` (Singapore) and `wss://ap2.dustlabs.io/mtproxy` (Melbourne). The launcher's *Multijoueur* section offers them, Europe by default, and remembers the choice; running your own gateway is a matter of hosting [`proxy.js`](https://github.com/paradust7/webshims/blob/main/src/emsocket/proxy.js). Whatever the gateway relays it can read, and it is told which server the player is joining.

These gateways answer the protocol webshims had in 2022, not the rewrite of September 2026 that the port now pins, which is why the workflow builds the older revision. A UDP socket is then relayed with `PROXY IPV4 UDP <address> <port>` and the datagrams pass through as they are; there is no address assigned to the client and no named bind. A server's name is resolved by the gateway too, at `10.0.0.1:53`, with the name itself as the request and four bytes of IPv4 address as the answer — so `francium-pvp.fr` never reaches a DNS resolver from the browser. Only IPv4 comes back: `Address::Resolve()` asks for nothing else under Emscripten, `launcher.js` turns `enable_ipv6` off so that no socket is made for a family the gateway cannot carry, and the public list leaves out the servers listed by an IPv6 address.

Joining is the engine's own command line: `luanti --go --address <host> --port <port> --name <player> [--password ...]`, which is what the form builds (`host:port` typed into the address field is split). *Serveurs publics* reads `https://servers.minetest.net/list` from the page, since the game's own *Join Game* tab needs HTTP support and this build is made without curl (`-DENABLE_CURL=FALSE` in the workflow); that list sends `Access-Control-Allow-Origin: *`, so a page can read it, and the launcher keeps the servers that are not full and do not ask for a password.

What a build without curl loses is HTTP: ContentDB, the update check and the in-game server list. Connecting to a server is ordinary UDP and is not affected.

## Importing your own games

The module installs a game from a zip itself. `emloop_install_game_zip(name, data, size)` — the memory from `emloop_alloc()`, which the module then owns — works out where the game starts inside the archive (a folder of its own holding `game.conf`, or `game.conf` at the top), unpacks everything below that into `/luanti/games/<name>`, reports progress through `emloop_zip_install_progress()` and answers with `emloop_zip_installed("game", name, ok)`. A build with OPFS keeps the game, and it is recorded in the pack database under the `local` version, the way the play page's own games are, so it can be deleted again. `name` is held to what `validPackName()` accepts: 1 to 64 of `A-Z a-z 0-9 _ - .`, not starting with a dot or a dash.

[`wasmgame/web/import-game.js`](../wasmgame/web/import-game.js) is the page side: load it after `luanti.js` and call `luantiImportGame.attach()` for a floating *Importer un jeu* button plus drag and drop anywhere on the page, or call `luantiImportGame.install(file)` from a control of your own. Zipping the game's folder and zipping from inside it both work. A page that already defines `emloop_zip_install_progress` and `emloop_zip_installed` keeps its own; one that does not gets a message at the bottom of the page instead.

The Local tab takes the list of games again each time it is shown, so an imported game appears without reloading.

## Hosting it

A build is a handful of files side by side: `index.html`, `menu.js`, `launcher.js`, `luanti.js`, `luanti.wasm` and the two zips with `packs.json` naming them (the `luanti-wasm` artifact of the wasm workflow already has them all). Serve them as static files with two headers, without which the browser will not start the build:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

`wasmgame/web/_headers` is what Cloudflare Pages and Netlify read. For Caddy:

```
:8080 {
	header {
		Cross-Origin-Opener-Policy same-origin
		Cross-Origin-Embedder-Policy credentialless
	}
	root * /srv/luanti
	file_server
}
```

and `tailscale serve --bg 8080` (or `tailscale funnel 8080`) puts it on the tailnet. Over nginx, the same two `add_header` lines inside `location /`. The browser must support JSPI; Chrome and Edge do.

`launcher.js` fetches `packs.json`, installs the engine's files and the game into the browser's own storage (`/luanti`, over OPFS), and then hands over to the launcher, which starts the engine only once the player has picked something. `minetest.conf` and the worlds live in that same storage, so they are kept between visits without the page doing anything; on a browser that gives no persistent storage the game still runs, but nothing is saved. `wasmgame/web/import-game.js` can be loaded alongside for the import button on a page of your own.

The whole launcher is `index.html`, `menu.js` and `launcher.js`: it is page code, so a change to it needs no rebuild of `luanti.js` or `luanti.wasm`, only a new build for the zips and files to be staged again (or a copy of the three files onto the server).

## Licence

Same as upstream: the code is LGPL-2.1-or-later (see `LICENSE.txt` and `COPYING.LESSER`), and the textures, sounds and fonts are under the licences `LICENSE.txt` lists (CC BY-SA 3.0 and 4.0, CC BY 4.0, Apache 2.0, and others). Minetest Game is LGPL-2.1-or-later with its media under CC BY-SA 3.0, CC BY 3.0 and CC0. Our changes are under the same licence as the files they change.
