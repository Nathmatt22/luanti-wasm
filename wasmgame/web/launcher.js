// The page Luanti runs in.
//
// src/mainloop.cpp is the other half of this file: main() runs in a worker,
// calls emloop_ready() here, and then waits until this page has put the
// engine's files and a game in place and asked for main with
// emloop_invoke_main(). Everything the module calls back into is defined below,
// so that a missing one is not a JavaScript error in the middle of a world.
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

	var DEFAULT_PACKS = {
		base: { file: "base.zip", version: "" },
		game: { file: "games.zip", name: "minetest_game", version: "" }
	};

	// Written into minetest.conf where it does not have them yet, so that what
	// the player changed in game stays.
	var CONF_DEFAULTS = [
		"update_last_checked = disabled",
		"no_mtg_notification = true",
		"no_keycode_migration_warning = true",
		"console_alpha = 200"
	].join("\n");

	var canvas = document.getElementById("canvas");
	var overlay = document.getElementById("overlay");
	var status = document.getElementById("status");
	var bar = document.querySelector("#bar > div");
	var errorBox = document.getElementById("error");
	var restart = document.getElementById("restart");
	var fullscreenButton = document.getElementById("fullscreen");

	/////////////////////////////////////////////////////////////////////////
	// What the page shows while it works
	/////////////////////////////////////////////////////////////////////////

	function say(text) {
		status.textContent = text;
		console.log("[launcher] " + text);
	}

	function progress(fraction) {
		bar.style.width = Math.max(0, Math.min(100, fraction * 100)) + "%";
	}

	function fail(what) {
		console.error("[launcher]", what);
		overlay.classList.remove("hidden");
		status.textContent = "Le jeu n'a pas pu démarrer.";
		errorBox.textContent = what && what.stack ? String(what) : String(what);
		errorBox.classList.add("shown");
		restart.classList.add("shown");
	}

	restart.addEventListener("click", function () { location.reload(); });

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
	// What the module calls
	/////////////////////////////////////////////////////////////////////////

	var Module = window.Module = {
		canvas: canvas,
		locateFile: function (path) { return path; },
		print: function (line) { console.log(line); },
		printErr: function (line) { console.warn(line); },
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
	// installing and starts the game proper.
	function emloop_ready() {
		boot().then(function () {
			overlay.classList.add("hidden");
			document.body.classList.add("playing");
			fitCanvas();
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
		if (kind !== "game")
			return;
		say((phase === "delete" ? "Remplacement de " : "Installation de ") + name + "…");
		progress(fraction);
	}

	function emloop_exited(code) {
		overlay.classList.remove("hidden");
		document.body.classList.remove("playing");
		status.textContent = code === 0 ? "Le jeu est fermé." : "Le jeu s'est arrêté.";
		restart.classList.add("shown");
	}

	// The engine hands over the player's files when it saves. This page keeps
	// them where the engine wrote them — /luanti is the browser's own storage —
	// so it only takes the buffer back.
	function wg_files(ptr, len) {
		Module.ccall("emloop_free", null, ["number"], [ptr]);
	}

	// The rest of the module's answers, for the parts of the launcher this page
	// leaves to the engine: the terminal, the usage and delete reports, and the
	// zip of a world.
	function emloop_terminal_output(ptr, len) {
		var bytes = Module.HEAPU8.subarray(ptr, ptr + len);
		console.log(new TextDecoder().decode(bytes));
	}
	function emloop_pack_removed(name, ok) { answer("pack-removed:" + name, !!ok); }
	function emloop_pack_remove_progress(name, fraction) {}
	function emloop_zip_progress(name, fraction) {}
	function emloop_world_zipped(name, ptr, len) {}
	function emloop_world_deleted(name, ok) { answer("world-deleted:" + name, !!ok); }
	function emloop_world_delete_progress(name, fraction) {}
	function emloop_usage_result(kind, name, bytes) { answer("usage:" + kind + ":" + name, bytes); }

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

	// Copy `bytes` into the module's memory, which then owns them.
	function handOver(bytes) {
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

	function invokeMain(args) {
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

	function boot() {
		say("Préparation du stockage…");
		var fs = wait("fs", "Préparation du stockage");
		// Storage the page keeps between visits, where the engine writes
		// minetest.conf, the worlds and anything installed.
		call("emloop_init_fs", ["number"], [1]);

		return fs.then(function (persistent) {
			if (!persistent)
				say("Ce navigateur ne donne pas de stockage : rien ne sera gardé.");
			return loadPacks();
		}).then(function (packs) {
			return installBase(packs.base).then(function () {
				return installGame(packs.game);
			});
		}).then(function () {
			// Settings for this page; the game's own are in the base zip.
			call("emloop_set_conf", ["string", "string"], [CONF_DEFAULTS, ""]);
			say("Démarrage…");
			call("emsocket_init", [], []);
			fitCanvas();
			invokeMain(["luanti"]);
		});
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
		resizeTimer = setTimeout(fitCanvas, 120);
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
	script.src = "luanti.js";
	script.async = true;
	script.onerror = function () {
		fail("luanti.js n'a pas pu être chargé. Vérifiez qu'il est à côté de cette page.");
	};
	document.body.appendChild(script);
})();
