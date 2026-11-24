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

	// Le panneau de diagnostic montre ce que la page fait, dans l'ordre et en
	// direct ; ces deux-là en sont la mémoire.
	var T0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
	var debugEvents = [];
	var lastFraction = -1;

	function now() {
		return ((typeof performance !== "undefined" && performance.now ? performance.now() : 0) - T0) / 1000;
	}

	function debugEvent(text) {
		debugEvents.push({ t: now(), text: String(text == null ? "" : text) });
		if (debugEvents.length > 200)
			debugEvents.splice(0, debugEvents.length - 200);
	}

	/////////////////////////////////////////////////////////////////////////
	// What the page shows while it works
	/////////////////////////////////////////////////////////////////////////

	function say(text) {
		statusLine.textContent = text;
		console.log("[launcher] " + text);
		debugEvent(text);
	}

	function progress(fraction) {
		lastFraction = fraction;
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
		// A page that is waiting to hand a mod over should not wait for ever: it
		// gets its turn, and the calls it makes then are the ones that fail.
		if (readyResolve)
			readyResolve();
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
		debugEvent(line);
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

	/////////////////////////////////////////////////////////////////////////
	// Le diagnostic du chargement
	/////////////////////////////////////////////////////////////////////////

	// Un panneau qui se rafraîchit tant qu'il est ouvert : ce que la page fait,
	// ce qu'elle télécharge, où en est le module. C'est la console qu'un
	// téléphone n'a pas, et le seul endroit où voir un démarrage qui n'aboutit
	// pas sans ouvrir les outils du navigateur.
	var debugBox = document.getElementById("debug");
	var debugOut = document.getElementById("debug-out");
	var debugToggle = document.getElementById("debug-toggle");
	var debugTimer = 0;

	function size(count) {
		if (!count)
			return "0";
		if (count >= 1073741824)
			return (count / 1073741824).toFixed(1) + " Go";
		if (count >= 1048576)
			return (count / 1048576).toFixed(1) + " Mo";
		if (count >= 1024)
			return (count / 1024).toFixed(0) + " Ko";
		return count + " o";
	}

	// Ce que la page a demandé, regroupé par nom : les threads du moteur
	// demandent tous luanti.js, et c'est le genre de détail qui explique un
	// démarrage lent.
	function resourceLines() {
		var groups = {};
		var order = [];
		var entries;
		try {
			entries = performance.getEntriesByType("resource");
		} catch (err) {
			return ["  (indisponible dans ce navigateur)"];
		}
		entries.forEach(function (entry) {
			var name = String(entry.name || "").split("?")[0].split("/").pop();
			if (!name)
				return;
			var group = groups[name];
			if (!group) {
				group = groups[name] = { name: name, count: 0, bytes: 0, slowest: 0 };
				order.push(group);
			}
			group.count++;
			// decodedBodySize : la taille du fichier, pas ce qui a traversé le
			// réseau pour un 304 (transferSize y vaut quelques centaines d'octets).
			group.bytes += entry.decodedBodySize || entry.transferSize || 0;
			group.slowest = Math.max(group.slowest, entry.duration || 0);
		});
		if (!order.length)
			return ["  rien encore"];
		return order.map(function (group) {
			return "  " + group.name + (group.count > 1 ? " ×" + group.count : "")
					+ " — " + size(group.bytes)
					+ " — " + (group.slowest / 1000).toFixed(1) + " s";
		});
	}

	function debugText() {
		var m = window.Module || {};
		var l = window.Luanti;
		var lines = [
			"Luanti — " + now().toFixed(1) + " s depuis le début du chargement",
			"étape       : " + (statusLine ? statusLine.textContent : "?"),
			"progression : " + (lastFraction >= 0 ? Math.round(lastFraction * 100) + " %" : "—"),
			"isolé       : " + (window.crossOriginIsolated ? "oui" : "NON — COOP/COEP manquants"),
			"module      : " + (typeof m.ccall === "function" ? "chargé" : "pas encore")
				+ (m.HEAPU8 ? ", mémoire " + size(m.HEAPU8.byteLength) : "")
				+ (m.calledRun ? ", main lancé" : ""),
			"moteur      : " + (typeof m.ccall === "function" && l
				? (l.dead ? "terminé" : "vivant")
					+ (l.persistent ? ", stockage persistant" : ", stockage en mémoire")
				: "pas encore démarré"),
			"machine     : " + (navigator.hardwareConcurrency || "?") + " cœurs"
				+ (navigator.deviceMemory ? ", " + navigator.deviceMemory + " Go" : "")
				+ (window.isSecureContext ? ", contexte sûr" : ", PAS de contexte sûr"),
			"",
			"ressources :"
		];
		lines = lines.concat(resourceLines());
		lines.push("", "journal (" + debugEvents.length + ") :");
		debugEvents.slice(-40).forEach(function (event) {
			lines.push("  " + event.t.toFixed(1) + "s  " + event.text);
		});
		return lines.join("\n");
	}

	function paintDebug() {
		if (debugOut)
			debugOut.textContent = debugText();
	}

	function showDebug(show) {
		if (!debugBox)
			return;
		debugBox.hidden = !show;
		if (debugToggle)
			debugToggle.setAttribute("aria-expanded", show ? "true" : "false");
		if (debugTimer) {
			clearInterval(debugTimer);
			debugTimer = 0;
		}
		if (!show)
			return;
		paintDebug();
		debugTimer = setInterval(paintDebug, 500);
	}

	if (debugToggle)
		debugToggle.addEventListener("click", function () {
			showDebug(debugBox ? debugBox.hidden : false);
		});
	var debugClose = document.getElementById("debug-close");
	if (debugClose)
		debugClose.addEventListener("click", function () { showDebug(false); });
	var debugCopy = document.getElementById("debug-copy");
	if (debugCopy)
		debugCopy.addEventListener("click", function () {
			var text = debugText();
			var done = function () {
				debugCopy.textContent = "Copié";
				setTimeout(function () { debugCopy.textContent = "Copier"; }, 1500);
			};
			if (navigator.clipboard && navigator.clipboard.writeText)
				navigator.clipboard.writeText(text).then(done, function () {});
		});

	// Un appui sur « Debug » pendant le chargement : le panneau s'ouvre et se
	// met à jour tout seul, sans rien avoir à taper dans une console.
	debugEvent("page chargée");

	// A script error, or a promise nobody caught: both would otherwise only
	// ever reach the console.
	window.addEventListener("error", function (event) {
		var where = event && event.filename
				? " (" + event.filename + ":" + event.lineno + ")"
				: "";
		note("Page : " + ((event && event.message) || "erreur inconnue") + where, true);
		debugEvent("ERREUR " + ((event && event.error && event.error.stack) || (event && event.message) || "?"));
	});
	window.addEventListener("unhandledrejection", function (event) {
		var reason = event && event.reason;
		var what = reason && reason.message ? reason.message : String(reason);
		note("Page : promesse rejetée : " + what, true);
		// La pile dit d'où ça vient, ce que le message seul ne dit jamais.
		debugEvent("REJET " + (reason && reason.stack ? reason.stack : what));
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

	// Resolved once the engine's files and a game are in place, which is what
	// anything that works on the storage has to wait for. mod-handoff.js waits
	// on it before it installs anything a page sends.
	var readyResolve = null;
	var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

	var Luanti = window.Luanti = {
		// Whether what the engine writes outlives the tab.
		persistent: false,
		// Set when the engine has quit: the module cannot be started twice.
		dead: false,
		// The zips this page ships, as packs.json names them.
		packs: DEFAULT_PACKS,
		// Resolves when the launcher has finished installing, so that a page
		// cannot hand a mod over before there is anywhere to put it.
		ready: readyPromise,
		on: hooks,
		play: play,
		installGameZip: installGameZip,
		installModZip: installModZip,
		removeMod: removeMod,
		setWorldMod: setWorldMod,
		ensureWorld: ensureWorld,
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
			if (window.luantiMenu && typeof window.luantiMenu.show === "function") {
				// Whoever waits on `ready` waits for the launcher to have read
				// the storage as well: the page must not be reading it while
				// the game is writing, and a mod handed over by another page
				// goes in right after this.
				var shown = window.luantiMenu.show();
				if (shown && typeof shown.then === "function")
					shown.then(readyResolve, readyResolve);
				else
					readyResolve();
			} else {
				say("Prêt.");
				readyResolve();
			}
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

	// A mod the engine has put in /luanti/mods. `name` is what the mod calls
	// itself, which is what a world enables; empty when the archive was not a
	// mod after all.
	function emloop_mod_installed(dir, name, ok) {
		answer("mod:" + dir, ok ? name : null);
	}

	function emloop_mod_removed(dir, ok) {
		answer("mod-removed:" + dir, !!ok);
	}

	function emloop_world_ready(name, ok) {
		answer("world-ready:" + name, !!ok);
	}

	function emloop_world_mod_set(world, mod, ok) {
		answer("world-mod:" + world + ":" + mod, !!ok);
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
		emloop_mod_installed: emloop_mod_installed,
		emloop_mod_removed: emloop_mod_removed,
		emloop_world_ready: emloop_world_ready,
		emloop_world_mod_set: emloop_world_mod_set,
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
		var escapes_ok = supports("emloop_lua_hex_escapes_supported");
		if (goto_ok === true && names_ok === true && escapes_ok === true) {
			engineLine.textContent = "Moteur à jour : Lua 5.1 avec goto, noms "
					+ "non-ASCII et \\xNN.";
			engineLine.style.color = "";
			return;
		}
		var missing;
		if (goto_ok === false)
			missing = "il n'accepte pas goto";
		else if (names_ok === false)
			missing = "il n'accepte pas les noms en octets non-ASCII";
		else if (escapes_ok === false)
			missing = "il ne lit pas \\xNN comme un octet";
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

	// Install a mod the player picked, or a page handed over. The name says
	// where it lands; what the mod calls itself is what comes back, which is
	// what a world has to enable and is not always the folder's name.
	function installModZip(dir, bytes) {
		if (Luanti.dead)
			return Promise.reject(new Error("Le jeu est fermé : rechargez la page."));
		var waiting = wait("mod:" + dir, "Installation du mod « " + dir + " »");
		try {
			call("emloop_install_mod_zip", ["string", "number", "number"],
					[dir, handOver(bytes), bytes.length]);
		} catch (err) {
			return Promise.reject(err);
		}
		return waiting.then(function (name) {
			if (!name)
				throw new Error("L'archive n'est pas un mod : il manque un mod.conf "
						+ "ou un init.lua à sa racine, ou dans son seul dossier.");
			return name;
		});
	}

	// Delete an installed mod. The worlds that loaded it keep the key that
	// enables it, which Luanti reports as a missing mod rather than a broken
	// world.
	function removeMod(dir) {
		var waiting = wait("mod-removed:" + dir, "Suppression de « " + dir + " »");
		call("emloop_remove_mod", ["string"], [dir]);
		return waiting;
	}

	// Turn a mod on or off in a saved world, the way the game's own "Select
	// mods" dialog does. It applies to the next start of that world: the
	// server reads this file as it starts.
	function setWorldMod(world, mod, enabled) {
		var waiting = wait("world-mod:" + world + ":" + mod,
				"Réglage des mods de « " + world + " »");
		call("emloop_set_world_mod", ["string", "string", "number"],
				[world, mod, enabled ? 1 : 0]);
		return waiting;
	}

	// Make sure worlds/<name> exists, with `game` as its game; a world that is
	// already there is left as it is. This is what lets a page start a game with
	// a mod in one step, there being nowhere else to put the mod.
	function ensureWorld(name, game) {
		var waiting = wait("world-ready:" + name, "Création du monde « " + name + " »");
		call("emloop_ensure_world", ["string", "string"], [name, game]);
		return waiting;
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

	// The engine is built around shared memory, which a browser only gives to a
	// page it has made cross-origin isolated. Without that, the module's first
	// postMessage of its memory fails with "The object can not be cloned",
	// which says nothing about the cause, and the page stays on "Chargement…".
	// Safari does not implement COEP `credentialless`, so it lands here with the
	// headers _headers spells out; say what is missing instead.
	if (!window.crossOriginIsolated) {
		fail("Cette page n'est pas cross-origin isolated : le serveur doit envoyer "
				+ "Cross-Origin-Opener-Policy: same-origin et "
				+ "Cross-Origin-Embedder-Policy: require-corp.");
		return;
	}

	var script = document.createElement("script");
	script.src = "luanti.js" + BUILD;
	script.async = true;
	script.onerror = function () {
		fail("luanti.js n'a pas pu être chargé. Vérifiez qu'il est à côté de cette page.");
	};
	document.body.appendChild(script);
})();
