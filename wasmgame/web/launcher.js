// The page Luanti runs in.
//
// src/mainloop.cpp is the other half of this file: main() runs in a worker,
// calls emloop_ready() here, and then waits until this page has put the
// engine's files and a game in place and asked for main with
// emloop_invoke_main(). Everything the module calls back into is defined below,
// so that a missing one is not a JavaScript error in the middle of a world.
//
// Once the engine's files are in place this file hands over to menu.js, which
// is the launcher: it lists the worlds and the games in the browser's storage,
// imports a game from a zip, and starts the game the player picked through
// window.Luanti below. Nothing starts until the player asks for it.
//
// What it installs, from packs.json next to this page:
//
//   base  the engine's files (builtin, client, fonts, locale, textures), a zip
//         holding them relative to /luanti
//   game  a game's zip, here Minetest Game, installed into /luanti/games
//
// Both are versioned by the hash of their contents: the module unpacks one only
// when its version changed since the last visit, out of the browser's own
// storage, so a reload does not write tens of thousands of files again.
(function () {
	"use strict";

	var PACKS_FILE = "packs.json";

	// The OPFS directory the module mounts at /luanti. See
	// emsdk_wasmfs_opfs_subdir.patch: paths in persistent storage are the paths
	// the program sees, below this one.
	var ROOT_DIR = "luanti";

	// A query on this page (`?b=anything`) is passed on to luanti.js and
	// luanti.wasm, so that a browser or a proxy holding on to them can be made
	// to fetch them again without renaming the files. Empty otherwise.
	var BUILD = (function () {
		var match = /[?&]b=([^&#]*)/.exec(location.search || "");
		return match ? "?b=" + match[1] : "";
	})();

	var DEFAULT_PACKS = {
		base: { file: "base.zip", version: "" },
		game: { file: "games.zip", name: "minetest_game", version: "" }
	};

	// Written into minetest.conf where it does not have them yet, so that what
	// the player changed in game stays. IPv6 is off because the WebSocket
	// gateway relays IPv4 only, and a socket is only made for it: the engine
	// would bind an IPv6 one and fail.
	var CONF_DEFAULTS = [
		"update_last_checked = disabled",
		"no_mtg_notification = true",
		"no_keycode_migration_warning = true",
		"console_alpha = 200",
		"enable_ipv6 = false"
	].join("\n");

	var canvas = document.getElementById("canvas");
	var launcher = document.getElementById("launcher");
	var bootPanel = document.getElementById("boot");
	var menuPanel = document.getElementById("menu");
	var statusLine = document.getElementById("status");
	var engineLine = document.getElementById("engine");
	var bar = document.querySelector("#bar > div");
	var errorBox = document.getElementById("error");
	var restartButton = document.getElementById("restart");
	var fullscreenButton = document.getElementById("fullscreen");

	/////////////////////////////////////////////////////////////////////////
	// What the page shows while it works
	/////////////////////////////////////////////////////////////////////////

	function say(text) {
		statusLine.textContent = text;
		console.log("[launcher] " + text);
	}

	function progress(fraction) {
		bar.style.width = Math.max(0, Math.min(100, fraction * 100)) + "%";
	}

	function stop() {
		launcher.classList.remove("hidden");
		document.body.classList.remove("playing");
		// Back at the launcher, where the game is not on screen any more: what
		// goes wrong from here on is worth putting in front of the player
		// again, even if they had put the panel away during a game.
		logPutAway = false;
	}

	function fail(what) {
		console.error("[launcher]", what);
		note("Launcher : " + (what && what.message ? what.message : String(what)), true);
		stop();
		bootPanel.hidden = false;
		menuPanel.hidden = true;
		statusLine.textContent = "Le jeu n'a pas pu démarrer.";
		errorBox.textContent = what && what.stack ? String(what) : String(what);
		errorBox.classList.add("shown");
		restartButton.textContent = "Recharger la page";
		restartButton.hidden = false;
	}

	restartButton.addEventListener("click", function () { location.reload(); });

	/////////////////////////////////////////////////////////////////////////
	// What went wrong, on the page
	/////////////////////////////////////////////////////////////////////////

	// The engine reports its errors and warnings on stderr, which a page by
	// default only ever shows in the browser's console — and a phone has no
	// console to open. They are kept here and put on the page as they arrive.
	// The last few hundred lines are kept and older ones go, so that a long
	// session cannot grow without bound.
	var LOG_MAX = 300;
	var logLines = [];
	var logBox = document.getElementById("log-box");
	var logText = document.getElementById("log");
	var logTitle = document.getElementById("log-title");
	// Set once the player has put the panel away: a screen of game should not
	// be covered again by an error of the kind it has already seen. A crash
	// still opens it.
	var logPutAway = false;

	function paintLog() {
		if (!logText)
			return;
		logText.textContent = logLines.join("\n");
		logText.scrollTop = logText.scrollHeight;
	}

	function showLog(why, force) {
		if (!logBox || (logPutAway && !force))
			return;
		if (logTitle && why)
			logTitle.textContent = why;
		logBox.hidden = false;
		paintLog();
	}

	function hideLog() {
		if (logBox)
			logBox.hidden = true;
		logPutAway = true;
	}

	// A line from the engine, or from the page itself. It is kept whatever it
	// says; `serious` is what decides whether it is also put in front of the
	// player.
	function note(line, serious) {
		line = String(line == null ? "" : line);
		if (!line)
			return;
		logLines.push(line);
		if (logLines.length > LOG_MAX)
			logLines.splice(0, logLines.length - LOG_MAX);
		if (serious)
			showLog("Erreur");
		else if (logBox && !logBox.hidden)
			paintLog();
	}

	// Luanti prefixes a real problem with ERROR (WARNING is not one), and an
	// aborted wasm instance says so in its own words.
	function isError(line) {
		return /^(ERROR|ALERT|EMERG|CRIT)\b|Assertion|unreachable|Aborted/.test(line);
	}

	function engineSaid(line) {
		note(line, isError(String(line)));
	}

	function copyLog() {
		var text = logLines.join("\n");
		if (!text)
			return;
		var button = document.getElementById("log-copy");
		var done = function () {
			if (!button)
				return;
			button.textContent = "Copié";
			setTimeout(function () { button.textContent = "Copier"; }, 1500);
		};
		if (navigator.clipboard && navigator.clipboard.writeText)
			navigator.clipboard.writeText(text).then(done, selectLog);
		else
			selectLog();
	}

	// Without the clipboard API (an unencrypted origin, an older browser):
	// leave the text selected, which is what Ctrl-C and the share sheet copy.
	function selectLog() {
		if (!logText || !document.createRange || !window.getSelection)
			return;
		var range = document.createRange();
		range.selectNodeContents(logText);
		var selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
	}

	if (logBox) {
		logBox.hidden = true;
		var logCloseButton = document.getElementById("log-close");
		var logCopyButton = document.getElementById("log-copy");
		if (logCloseButton)
			logCloseButton.addEventListener("click", hideLog);
		if (logCopyButton)
			logCopyButton.addEventListener("click", copyLog);
	}

	// A script error, or a promise nobody caught: both would otherwise only
	// ever reach the console.
	window.addEventListener("error", function (event) {
		var where = event && event.filename
				? " (" + event.filename + ":" + event.lineno + ")"
				: "";
		note("Page : " + ((event && event.message) || "erreur inconnue") + where, true);
	});
	window.addEventListener("unhandledrejection", function (event) {
		var reason = event && event.reason;
		var what = reason && reason.message ? reason.message : String(reason);
		note("Page : promesse rejetée : " + what, true);
	});

	/////////////////////////////////////////////////////////////////////////
	// Waiting on the module's answers
	/////////////////////////////////////////////////////////////////////////

	// One slot per kind of answer the module gives. A waiter is called once and
	// forgotten; the module answers on the browser thread, which is the one this
	// file runs on.
	var waiters = {};

	function wait(kind, what) {
		return new Promise(function (resolve, reject) {
			waiters[kind] = { resolve: resolve, reject: reject };
			setTimeout(function () {
				if (waiters[kind] && waiters[kind].reject === reject) {
					delete waiters[kind];
					reject(new Error(what + " : pas de réponse du moteur."));
				}
			}, 180000);
		});
	}

	function answer(kind, value) {
		var waiter = waiters[kind];
		if (!waiter)
			return;
		delete waiters[kind];
		waiter.resolve(value);
	}

	/////////////////////////////////////////////////////////////////////////
	// What menu.js drives the engine with
	/////////////////////////////////////////////////////////////////////////

	// Menu handlers for what the engine reports as it works, filled in by
	// menu.js: on.install(kind, name, phase, fraction), on.zip(name, fraction),
	// on.worldDelete(name, fraction), on.gameRemove(name, fraction). A page
	// without a launcher leaves them empty.
	var hooks = {};

	var Luanti = window.Luanti = {
		// Whether what the engine writes outlives the tab.
		persistent: false,
		// Set when the engine has quit: the module cannot be started twice.
		dead: false,
		// The zips this page ships, as packs.json names them.
		packs: DEFAULT_PACKS,
		on: hooks,
		play: play,
		installGameZip: installGameZip,
		removeGame: removeGame,
		deleteWorld: deleteWorld,
		saveWorld: saveWorld,
		readConf: readConf,
		writeConf: writeConf,
		say: say,
		progress: progress
	};

	/////////////////////////////////////////////////////////////////////////
	// What the module calls
	/////////////////////////////////////////////////////////////////////////

	var Module = window.Module = {
		canvas: canvas,
		locateFile: function (path) { return path + BUILD; },
		print: function (line) { console.log(line); },
		printErr: function (line) { console.warn(line); engineSaid(line); },
		setStatus: function (text) { if (text) say(text); },
		onAbort: function (what) { fail("Le moteur s'est arrêté : " + what); },
		onFullScreen: function (want) {
			if (want && document.documentElement.requestFullscreen)
				document.documentElement.requestFullscreen().catch(function () {});
			else if (!want && document.exitFullscreen)
				document.exitFullscreen().catch(function () {});
		}
	};

	// Main is called in a worker and asks for this; the page then does the
	// installing and hands over to the launcher.
	function emloop_ready() {
		start().then(function () {
			bootPanel.hidden = true;
			menuPanel.hidden = false;
			if (window.luantiMenu && typeof window.luantiMenu.show === "function")
				window.luantiMenu.show();
			else
				say("Prêt.");
		}).catch(fail);
	}

	function emloop_fs_ready(persistent) {
		answer("fs", !!persistent);
	}

	function emloop_pack_installed(name) {
		answer("pack:" + name, true);
	}

	function emloop_pack_progress(name, fraction) {
		if (name === "base") {
			say("Installation des fichiers du jeu…");
			progress(fraction);
		}
	}

	function emloop_zip_installed(kind, name, ok) {
		answer("zip:" + kind + ":" + name, !!ok);
	}

	function emloop_zip_install_progress(kind, name, phase, fraction) {
		if (typeof hooks.install === "function")
			hooks.install(kind, name, phase, fraction);
		else if (kind === "game")
			progress(fraction);
	}

	function emloop_exited(code) {
		// main() has returned, so the wasm instance is spent: coming back to
		// the launcher means loading the page again, which reads the same
		// storage and takes a moment.
		Luanti.dead = true;
		stop();
		bootPanel.hidden = false;
		menuPanel.hidden = true;
		statusLine.textContent = code === 0 ? "Le jeu est fermé." : "Le jeu s'est arrêté.";
		progress(1);
		if (code !== 0) {
			errorBox.textContent = "Le jeu s'est arrêté (code " + code + "). Les "
					+ "derniers messages du moteur sont affichés en bas de la page.";
			errorBox.classList.add("shown");
			showLog("Le jeu s'est arrêté", true);
		}
		restartButton.textContent = "Revenir au launcher";
		restartButton.hidden = false;
	}

	// The engine hands over the player's files when it saves. This page keeps
	// them where the engine wrote them — /luanti is the browser's own storage —
	// so it only takes the buffer back.
	function wg_files(ptr, len) {
		Module.ccall("emloop_free", null, ["number"], [ptr]);
	}

	// A world the engine has packed for the player to keep. The engine waits
	// for this call to return before going on, so the bytes are copied out
	// here rather than held on to.
	function emloop_world_zipped(name, ptr, len) {
		var bytes = (ptr && len) ? Module.HEAPU8.slice(ptr, ptr + len) : null;
		answer("world-zipped:" + name, bytes);
	}

	function emloop_world_deleted(name, ok) {
		answer("world-deleted:" + name, !!ok);
	}

	function emloop_world_delete_progress(name, fraction) {
		if (typeof hooks.worldDelete === "function")
			hooks.worldDelete(name, fraction);
	}

	function emloop_pack_removed(name, ok) {
		answer("pack-removed:" + name, !!ok);
	}

	function emloop_pack_remove_progress(name, fraction) {
		if (typeof hooks.gameRemove === "function")
			hooks.gameRemove(name, fraction);
	}

	function emloop_zip_progress(name, fraction) {
		if (typeof hooks.zip === "function")
			hooks.zip(name, fraction);
	}

	function emloop_usage_result(kind, name, bytes) {
		answer("usage:" + kind + ":" + name, bytes);
	}

	function emloop_conf_read(text) {
		answer("conf:read", text);
	}

	function emloop_conf_written(ok) {
		answer("conf:write", !!ok);
	}

	// The terminal is not part of this page: it only shows what the engine
	// writes to it in the console.
	function emloop_terminal_output(ptr, len) {
		var bytes = Module.HEAPU8.subarray(ptr, ptr + len);
		console.log(new TextDecoder().decode(bytes));
	}

	// The module's EM_ASM blocks look these up as plain globals, so every one of
	// them has to be on window under its own name.
	Object.assign(window, {
		emloop_ready: emloop_ready,
		emloop_fs_ready: emloop_fs_ready,
		emloop_pack_installed: emloop_pack_installed,
		emloop_pack_progress: emloop_pack_progress,
		emloop_pack_removed: emloop_pack_removed,
		emloop_pack_remove_progress: emloop_pack_remove_progress,
		emloop_zip_installed: emloop_zip_installed,
		emloop_zip_install_progress: emloop_zip_install_progress,
		emloop_zip_progress: emloop_zip_progress,
		emloop_world_zipped: emloop_world_zipped,
		emloop_world_deleted: emloop_world_deleted,
		emloop_world_delete_progress: emloop_world_delete_progress,
		emloop_usage_result: emloop_usage_result,
		emloop_conf_read: emloop_conf_read,
		emloop_conf_written: emloop_conf_written,
		emloop_terminal_output: emloop_terminal_output,
		emloop_exited: emloop_exited,
		wg_files: wg_files
	});

	/////////////////////////////////////////////////////////////////////////
	// Starting the game
	/////////////////////////////////////////////////////////////////////////

	function call(name, signature, args) {
		return Module.ccall(name, null, signature, args);
	}

	function number(name, signature, args) {
		return Module.ccall(name, "number", signature, args);
	}

	function requireHeap() {
		if (!Module.HEAPU8 || !Module.HEAPU32)
			throw new Error("Ce build n'expose pas la mémoire du module "
					+ "(HEAPU8, HEAPU32) : il a été lié sans "
					+ "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8,HEAPU32.");
	}

	// Copy `bytes` into the module's memory, which then owns them.
	function handOver(bytes) {
		requireHeap();
		var ptr = number("emloop_alloc", ["number"], [bytes.length]);
		if (!ptr)
			throw new Error("Le moteur n'a plus de mémoire pour " + bytes.length + " octets.");
		Module.HEAPU8.set(bytes, ptr);
		return ptr;
	}

	function fetchBytes(url) {
		return fetch(url).then(function (response) {
			if (!response.ok)
				throw new Error(url + " : " + response.status + " " + response.statusText);
			return response.arrayBuffer();
		}).then(function (buffer) {
			return new Uint8Array(buffer);
		});
	}

	function loadPacks() {
		return fetch(PACKS_FILE, { cache: "no-store" }).then(function (response) {
			if (!response.ok)
				throw new Error(response.status);
			return response.json();
		}).then(function (packs) {
			return {
				base: packs.base && packs.base.file ? packs.base : DEFAULT_PACKS.base,
				game: packs.game && packs.game.file ? packs.game : DEFAULT_PACKS.game
			};
		}).catch(function () {
			// No manifest: a site that copied the zips by hand still works, at
			// the cost of unpacking them on every visit, as there is nothing to
			// say whether they changed.
			say("packs.json est absent, installation à chaque visite.");
			return DEFAULT_PACKS;
		});
	}

	function installBase(pack) {
		var waiting = wait("pack:base", "Installation des fichiers du jeu");
		return fetchBytes(pack.file).then(function (bytes) {
			say("Installation des fichiers du jeu…");
			call("emloop_install_base_zip", ["string", "number", "number"],
					[pack.version || "", handOver(bytes), bytes.length]);
			return waiting;
		});
	}

	function installGame(pack) {
		var name = pack.name || "minetest_game";
		var waiting = wait("zip:game:" + name, "Installation du jeu");
		return fetchBytes(pack.file).then(function (bytes) {
			say("Installation du jeu…");
			call("emloop_install_game_zip", ["string", "string", "number", "number"],
					[name, pack.version || "", handOver(bytes), bytes.length]);
			return waiting.then(function (ok) {
				if (!ok)
					throw new Error("Le jeu « " + name + " » n'a pas pu être installé : "
							+ pack.file + " n'est pas une archive de jeu.");
			});
		});
	}

	// The engine opens two things at the top of its tree as it starts, through a
	// path that goes by a folder it expects to exist: the log file it writes to
	// (see --logfile in play(), which turns that off) and minetest.conf, which it
	// rewrites whenever a setting changes. Making them here, where the page can,
	// means the engine finds an existing file rather than having to create one at
	// the root of the mount.
	function prepareStorage() {
		if (!navigator.storage || !navigator.storage.getDirectory)
			return Promise.resolve();
		return navigator.storage.getDirectory().then(function (root) {
			return root.getDirectoryHandle(ROOT_DIR, { create: true });
		}).then(function (dir) {
			return dir.getDirectoryHandle("bin", { create: true }).then(function () {
				return dir.getFileHandle("minetest.conf", { create: true });
			});
		}).catch(function (err) {
			console.warn("[launcher] préparation du stockage :", err);
		});
	}

	// What the engine this page loaded can do. A luanti.wasm kept in the
	// browser's cache, or an older artifact copied over the files, is not the
	// build the page was written against; saying which one is running turns a
	// game that stops at its first `goto` into a message that names the real
	// problem.
	function supports(name) {
		try {
			return number(name, [], []) === 1;
		} catch (err) {
			return null;  /* a build from before this check existed */
		}
	}

	function showEngine() {
		if (!engineLine)
			return;
		var goto_ok = supports("emloop_lua_goto_supported");
		var names_ok = supports("emloop_lua_raw_names_supported");
		if (goto_ok === true && names_ok === true) {
			engineLine.textContent = "Moteur à jour : Lua 5.1 avec goto et noms "
					+ "non-ASCII.";
			engineLine.style.color = "";
			return;
		}
		var missing;
		if (goto_ok === false)
			missing = "il n'accepte pas goto";
		else if (names_ok === false)
			missing = "il n'accepte pas les noms en octets non-ASCII";
		else
			missing = "il ne connaît pas cette vérification";
		engineLine.textContent = "Ce n'est pas le dernier moteur (" + missing
				+ ") : remplacez luanti.js et luanti.wasm par ceux de la dernière "
				+ "archive, puis rechargez la page — avec ?b=1 au bout de l'adresse "
				+ "si le navigateur garde les anciens.";
		engineLine.style.color = "var(--danger)";
	}

	function start() {
		showEngine();
		say("Préparation du stockage…");
		var fs = wait("fs", "Préparation du stockage");
		// Storage the page keeps between visits, where the engine writes
		// minetest.conf, the worlds and anything installed.
		call("emloop_init_fs", ["number"], [1]);

		return fs.then(function (persistent) {
			Luanti.persistent = persistent;
			if (!persistent)
				say("Ce navigateur ne donne pas de stockage : rien ne sera gardé.");
			return prepareStorage();
		}).then(function () {
			return loadPacks();
		}).then(function (packs) {
			Luanti.packs = packs;
			return installBase(packs.base).then(function () {
				return installGame(packs.game);
			});
		}).then(function () {
			// Settings for this page; the game's own are in the base zip.
			call("emloop_set_conf", ["string", "string"], [CONF_DEFAULTS, ""]);
			say("Prêt.");
		});
	}

	// Starts the engine with `args`, as if it had been run from a shell. Keys in
	// `overrides` replace what minetest.conf holds, which is how the launcher
	// picks the game the menu offers to start a new world with.
	//
	// `proxy` names the WebSocket gateway to join a server through, and is only
	// needed for that: a page cannot open a TCP connection, so the engine's
	// sockets are relayed by one. Playing alone uses no gateway at all.
	function play(args, overrides, proxy) {
		if (Luanti.dead)
			return;
		try {
			requireHeap();
			if (overrides)
				call("emloop_set_conf", ["string", "string"], ["", overrides]);
			launcher.classList.add("hidden");
			document.body.classList.add("playing");
			call("emsocket_init", [], []);
			if (proxy)
				setProxy(proxy);
			fitCanvas();
			// No debug.txt. A page's log belongs in its console, which is where
			// everything the engine prints already goes, and the file was the one
			// thing a fresh mount would not let it create.
			invokeMain(args.concat(["--logfile", ""]));
		} catch (err) {
			fail(err);
		}
	}

	// The gateway the engine's sockets go through. It takes a C string and keeps
	// its own copy, so the memory here goes back as soon as it has it.
	function setProxy(url) {
		var bytes = new TextEncoder().encode(url);
		var ptr = number("emloop_alloc", ["number"], [bytes.length + 1]);
		if (!ptr)
			throw new Error("Le moteur n'a plus de mémoire pour l'adresse de la passerelle.");
		Module.HEAPU8.set(bytes, ptr);
		Module.HEAPU8[ptr + bytes.length] = 0;
		call("emsocket_set_proxy", ["number"], [ptr]);
		call("emloop_free", ["number"], [ptr]);
	}

	function invokeMain(args) {
		requireHeap();
		var argc = args.length;
		var argv = number("emloop_alloc", ["number"], [(argc + 1) * 4]);
		if (!argv)
			throw new Error("Le moteur n'a plus de mémoire pour ses arguments.");
		var encoder = new TextEncoder();
		for (var i = 0; i < argc; i++) {
			var bytes = encoder.encode(args[i]);
			// A C string, so one byte more than the text for the terminator.
			var ptr = number("emloop_alloc", ["number"], [bytes.length + 1]);
			if (!ptr)
				throw new Error("Le moteur n'a plus de mémoire pour ses arguments.");
			Module.HEAPU8.set(bytes, ptr);
			Module.HEAPU8[ptr + bytes.length] = 0;
			Module.HEAPU32[(argv >> 2) + i] = ptr;
		}
		Module.HEAPU32[(argv >> 2) + argc] = 0;
		call("emloop_invoke_main", ["number", "number"], [argc, argv]);
	}

	/////////////////////////////////////////////////////////////////////////
	// What the launcher does with the engine
	/////////////////////////////////////////////////////////////////////////

	// Install a game the player picked. No version is passed: no page can know
	// whether a chosen zip changed, so it is installed every time.
	function installGameZip(name, bytes) {
		if (Luanti.dead)
			return Promise.reject(new Error("Le jeu est fermé : rechargez la page."));
		var waiting = wait("zip:game:" + name, "Installation de « " + name + " »");
		try {
			call("emloop_install_game_zip", ["string", "string", "number", "number"],
					[name, "", handOver(bytes), bytes.length]);
		} catch (err) {
			return Promise.reject(err);
		}
		return waiting.then(function (ok) {
			if (!ok)
				throw new Error("L'archive n'est pas un jeu : il manque un game.conf "
						+ "à sa racine ou dans son seul dossier.");
			return true;
		});
	}

	// Delete a game and the files it installed. Its worlds stay.
	function removeGame(name) {
		var waiting = wait("pack-removed:" + name, "Suppression de « " + name + " »");
		call("emloop_remove_pack", ["string"], [name]);
		return waiting;
	}

	// minetest.conf, through the engine. The engine is the one that opens the
	// file when it starts, so reading and writing it here, on the worker
	// thread that owns the mount, is what makes the launcher show and save
	// exactly the settings the next launch will load.
	function readConf() {
		if (Luanti.dead)
			return Promise.reject(new Error("Le jeu est fermé : rechargez la page."));
		var waiting = wait("conf:read", "Lecture des réglages");
		call("emloop_read_conf", [], []);
		return waiting;
	}

	function writeConf(text) {
		if (Luanti.dead)
			return Promise.reject(new Error("Le jeu est fermé : rechargez la page."));
		var waiting = wait("conf:write", "Enregistrement des réglages");
		call("emloop_write_conf", ["string"], [String(text)]);
		return waiting.then(function (ok) {
			if (!ok)
				throw new Error("le moteur n'a pas pu écrire minetest.conf");
			return true;
		});
	}

	function deleteWorld(name) {
		var waiting = wait("world-deleted:" + name, "Suppression de « " + name + " »");
		call("emloop_delete_world", ["string"], [name]);
		return waiting;
	}

	// Packs a world into a zip and resolves with its bytes, or null.
	function saveWorld(name) {
		var waiting = wait("world-zipped:" + name, "Archivage de « " + name + " »");
		call("emloop_zip_world", ["string"], [name]);
		return waiting;
	}

	/////////////////////////////////////////////////////////////////////////
	// The canvas, full screen, and the module's script
	/////////////////////////////////////////////////////////////////////////

	// The engine draws in device pixels: what the canvas covers in CSS pixels,
	// times the ratio the browser uses for the display.
	function fitCanvas() {
		var ratio = window.devicePixelRatio || 1;
		var width = Math.max(1, Math.round(canvas.clientWidth * ratio));
		var height = Math.max(1, Math.round(canvas.clientHeight * ratio));
		if (Module.ccall)
			call("irrlicht_resize", ["number", "number"], [width, height]);
	}

	var resizeTimer = 0;
	function onResize() {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () {
			if (document.body.classList.contains("playing"))
				fitCanvas();
		}, 120);
	}
	window.addEventListener("resize", onResize);
	window.addEventListener("orientationchange", onResize);

	fullscreenButton.addEventListener("click", function () {
		if (document.fullscreenElement) {
			document.exitFullscreen().catch(function () {});
		} else if (document.documentElement.requestFullscreen) {
			document.documentElement.requestFullscreen().catch(function () {});
		}
	});

	var script = document.createElement("script");
	script.src = "luanti.js" + BUILD;
	script.async = true;
	script.onerror = function () {
		fail("luanti.js n'a pas pu être chargé. Vérifiez qu'il est à côté de cette page.");
	};
	document.body.appendChild(script);
})();
