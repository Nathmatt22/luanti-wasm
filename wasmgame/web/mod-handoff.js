// Starting this page with a mod somebody made somewhere else.
//
// mtc-creator (https://mtc-creator.vercel.app/) builds a Luanti mod in the
// browser — blocks, items, tools, recipes, formspecs, textures — and exports it
// as a zip holding mod.conf, init.lua and textures/, which is what this page
// installs. Its "Lancer le jeu" button should end with the player in the game,
// with that mod on, and nothing uploaded anywhere: the zip comes to this page
// as a message.
//
// Load this after launcher.js. What it adds is two ways in, both landing in the
// same place: the mod in /luanti/mods, a world that has it on, and the game
// started on that world.
//
// 1. From another page, with the zip in memory, which is the way mtc-creator
//    has it:
//
//      var frame = document.querySelector("iframe#game").contentWindow;
//      frame.postMessage({
//        type: "luanti:mod", version: 1,
//        mods: [{ name: "mymod", zip: blob }],  // Blob, ArrayBuffer or Uint8Array
//        game: "mtc_gameme",                    // optional
//        world: "mymod",                        // optional
//        player: "invité",                      // optional
//        play: true                             // optional; false installs only
//      }, "*");
//
//    Answers go back to the sending window as luanti:status messages, and
//    luanti:ready says when this page can take one:
//
//      { type: "luanti:ready", version: 1, url: "…" }
//      { type: "luanti:status", version: 1, phase: "installing", mod: "mymod" }
//      { type: "luanti:status", version: 1, phase: "preparing", world: "mymod" }
//      { type: "luanti:status", version: 1, phase: "installed",
//        mods: ["mymod"], world: "mymod" }
//      { type: "luanti:status", version: 1, phase: "playing", world: "mymod" }
//      { type: "luanti:status", version: 1, phase: "error", message: "…" }
//
//    A frame is what works, not a popup: this page is served with
//    `Cross-Origin-Opener-Policy: same-origin`, which severs `window.opener` for
//    a popup opened from another origin, while a frame can always reach its
//    parent and the parent can always reach the frame.
//
// 2. From the address, for a zip that is already on a server:
//
//      ?mod=https://exemple.fr/mymod.zip&as=mymod&game=mtc_gameme
//        &world=mymod&player=invité
//
//    `mods=` takes a comma-separated list instead, and `play=0` installs
//    without starting anything. The zip has to be served with CORS
//    (`Access-Control-Allow-Origin`), since it is this page that fetches it.
//    This is the way in from a link or a popup, where no window can hold the
//    bytes for this one.
//
// A mod runs Lua with the game's privileges on this origin and is kept in the
// player's own storage, so a page that can post to this one can put one there.
// ORIGINS below is how to restrict that; empty accepts any page, which is what
// makes a button on somebody else's site work without this page knowing it.
(function (global) {
	"use strict";

	var VERSION = 1;

	var TYPE_IN = "luanti:mod";
	var TYPE_READY = "luanti:ready";
	var TYPE_STATUS = "luanti:status";

	// The origins that may hand a mod over, as "https://exemple.fr". Empty
	// accepts any page: the player chose to press a button on it.
	var ORIGINS = [];

	// Set once the address above has started a game, so that reloading the page
	// after the game is closed comes back to the launcher with the mod in place
	// rather than installing it again and starting over.
	var LAUNCHED_KEY = "luanti.handoff";

	// The key menu.js remembers the game the player picked under.
	var GAME_KEY = "luanti.game";

	function allowed(origin) {
		if (!ORIGINS.length)
			return true;
		for (var i = 0; i < ORIGINS.length; i++) {
			if (ORIGINS[i] === origin)
				return true;
		}
		return false;
	}

	function reply(target, message) {
		if (!target || typeof target.postMessage !== "function")
			return;
		try {
			target.postMessage(message, "*");
		} catch (err) {
			// A window that is gone: there is nobody to tell.
		}
	}

	function report(target, phase, text, extra) {
		var message = { type: TYPE_STATUS, version: VERSION, phase: phase };
		if (text)
			message.message = text;
		if (extra) {
			for (var key in extra) {
				if (Object.prototype.hasOwnProperty.call(extra, key))
					message[key] = extra[key];
			}
		}
		reply(target, message);
		if (phase === "error")
			console.error("[handoff] " + text);
		else
			console.log("[handoff] " + (text || phase));
	}

	/////////////////////////////////////////////////////////////////////////
	// Reading what a page sent
	/////////////////////////////////////////////////////////////////////////

	// What a folder in mods/ can be called, in the same terms as validPackName()
	// in src/mainloop.cpp: 1 to 64 of [A-Za-z0-9_.-], not starting with . or -.
	function dirName(name, fallback) {
		var base = String(name || "").replace(/[^A-Za-z0-9_.-]+/g, "-")
			.replace(/^[.-]+/, "");
		base = base.slice(0, 64).replace(/[.-]+$/, "");
		return base || fallback;
	}

	// What a world can be called: any name that stays a child of worlds/.
	function worldName(name) {
		var base = String(name || "").replace(/[\/\\]+/g, "-").replace(/^\.+/, "");
		return base.trim().slice(0, 200);
	}

	// The mods a request asks for. `mods` is the list; a single `name` and `zip`
	// is accepted too, which is what a page holding one mod sends.
	function wanted(request) {
		var list = [];
		if (Array.isArray(request.mods)) {
			request.mods.forEach(function (mod) {
				if (mod && (mod.zip || mod.url || mod.bytes))
					list.push(mod);
			});
		} else if (request.zip || request.url) {
			list.push({ name: request.name, zip: request.zip, url: request.url });
		}
		return list;
	}

	// One mod's archive, however the sending page could hold it.
	function bytesOf(mod) {
		if (mod.bytes)
			return Promise.resolve(new Uint8Array(mod.bytes));
		if (mod.url) {
			return fetch(mod.url, { cache: "no-store" }).then(function (response) {
				if (!response.ok)
					throw new Error(mod.url + " : " + response.status + " "
							+ response.statusText);
				return response.arrayBuffer();
			}).then(function (buffer) {
				return new Uint8Array(buffer);
			});
		}
		if (mod.zip && typeof mod.zip.arrayBuffer === "function") {
			return mod.zip.arrayBuffer().then(function (buffer) {
				return new Uint8Array(buffer);
			});
		}
		if (mod.zip)
			return Promise.resolve(new Uint8Array(mod.zip));
		return Promise.reject(new Error("aucune archive pour « "
				+ (mod.name || "ce mod") + " »"));
	}

	// The game a new world is made with when the request does not name one: the
	// one the player picked in the launcher, or the one this page ships.
	function rememberedGame() {
		var chosen = null;
		try {
			chosen = localStorage.getItem(GAME_KEY);
		} catch (err) {
			chosen = null;
		}
		if (chosen)
			return chosen;
		var packs = global.Luanti && global.Luanti.packs;
		return (packs && packs.game && packs.game.name) || "minetest_game";
	}

	/////////////////////////////////////////////////////////////////////////
	// The one thing both ways in do
	/////////////////////////////////////////////////////////////////////////

	// Install what the request brought, turn each mod on in a world, and start
	// the game there. Every step is one the launcher already offers: this file
	// only decides what to ask it for, and in which order.
	function run(request, target) {
		var L = global.Luanti;
		if (!L) {
			report(target, "error", "cette page n'a pas de launcher");
			return Promise.reject(new Error("no launcher"));
		}
		var mods = wanted(request);
		var play = request.play === undefined ? true : !!request.play;

		return L.ready.then(function () {
			var names = [];
			var installed = Promise.resolve();
			mods.forEach(function (mod, index) {
				installed = installed.then(function () {
					var dir = dirName(mod.name, "mod-" + (index + 1));
					report(target, "installing", "Installation de « " + dir + " »…",
							{ mod: dir });
					return bytesOf(mod).then(function (bytes) {
						return L.installModZip(dir, bytes);
					}).then(function (name) {
						names.push(name);
					});
				});
			});
			return installed.then(function () {
				if (!names.length && !worldName(request.world))
					return null;
				var world = worldName(request.world) || worldName(names[0]);
				var game = request.game || rememberedGame();
				report(target, "preparing", "Préparation de « " + world + " »…",
						{ world: world });
				return L.ensureWorld(world, game).then(function (ok) {
					if (!ok) {
						throw new Error("le monde « " + world + " » n'a pas pu être "
								+ "créé : le jeu « " + game + " » est-il installé ?");
					}
					return names.reduce(function (chain, name) {
						return chain.then(function () {
							return L.setWorldMod(world, name, true);
						});
					}, Promise.resolve()).then(function () {
						return world;
					});
				});
			}).then(function (world) {
				if (!world) {
					report(target, "installed", "rien à lancer", { mods: names });
					return;
				}
				report(target, "installed", names.length
						? names.join(", ") + " — monde « " + world + " »"
						: "monde « " + world + " »",
						{ mods: names, world: world });
				if (!play)
					return;
				// --go skips the game's own menu, which is where a player
				// would otherwise have to pick the world again.
				var args = ["luanti", "--world", "/luanti/worlds/" + world, "--go"];
				if (request.player)
					args.push("--name", String(request.player).slice(0, 20));
				report(target, "playing", "Lancement de « " + world + " »…",
						{ world: world });
				L.play(args);
			});
		}).catch(function (err) {
			report(target, "error", (err && err.message) || String(err));
			throw err;
		});
	}

	/////////////////////////////////////////////////////////////////////////
	// A page that has the zip in memory
	/////////////////////////////////////////////////////////////////////////

	function onMessage(event) {
		var data = event.data;
		if (!data || typeof data !== "object" || data.type !== TYPE_IN)
			return;
		if (!allowed(event.origin)) {
			console.warn("[handoff] refusé : " + event.origin);
			return;
		}
		run(data, event.source).catch(function () {
			// Already reported, and nothing else can be done about it here.
		});
	}

	global.addEventListener("message", onMessage, false);

	// Tell whoever opened this page that it can take a mod. Twice: once as soon
	// as this file runs, so that a page waiting to hear from us is not left
	// waiting for a slow install, and once when the launcher has its files in
	// place.
	function announce() {
		var message = { type: TYPE_READY, version: VERSION, url: location.href };
		if (global.parent && global.parent !== global)
			reply(global.parent, message);
		if (global.opener)
			reply(global.opener, message);
	}

	setTimeout(announce, 0);
	if (global.Luanti && global.Luanti.ready)
		global.Luanti.ready.then(announce, announce);

	/////////////////////////////////////////////////////////////////////////
	// A link that names the zip
	/////////////////////////////////////////////////////////////////////////

	function param(name) {
		var match = new RegExp("[?&]" + name + "=([^&#]*)")
			.exec(String(location.search || ""));
		if (!match)
			return "";
		try {
			return decodeURIComponent(match[1].replace(/\+/g, " "));
		} catch (err) {
			return match[1];
		}
	}

	// What the address asks for, or null when it asks for nothing.
	function addressRequest() {
		var urls = [];
		var single = param("mod");
		if (single)
			urls.push(single);
		param("mods").split(",").forEach(function (url) {
			if (url.trim())
				urls.push(url.trim());
		});
		if (!urls.length)
			return null;
		// `as=` names a single mod; a list is named after its files.
		var as = param("as");
		var mods = urls.map(function (url, index) {
			var file = url.split("?")[0].split("/").pop() || "";
			var name = (as && urls.length === 1) ? as : file.replace(/\.zip$/i, "");
			return { name: name, url: url };
		});
		return {
			mods: mods,
			game: param("game") || undefined,
			world: param("world") || undefined,
			player: param("player") || undefined,
			play: param("play") !== "0"
		};
	}

	(function fromAddress() {
		var request = addressRequest();
		if (!request)
			return;
		var launched = false;
		try {
			launched = sessionStorage.getItem(LAUNCHED_KEY) === "1";
		} catch (err) {
			launched = false;
		}
		if (launched) {
			console.log("[handoff] déjà lancé depuis l'adresse : au launcher");
			return;
		}
		try {
			sessionStorage.setItem(LAUNCHED_KEY, "1");
		} catch (err) {
			// Private browsing: it will start again on a reload, which is
			// still a game with the mod in it.
		}
		var target = (global.parent && global.parent !== global) ? global.parent : null;
		target = target || global.opener || null;
		run(request, target).catch(function () {});
	})();

	// For a page of this origin that would rather call than post.
	global.luantiHandoff = {
		version: VERSION,
		install: function (request) { return run(request, null); },
		addressRequest: addressRequest
	};
})(window);
