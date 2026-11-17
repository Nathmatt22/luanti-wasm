// The launcher screen: what this page shows before the game starts.
//
// The engine's files live in the browser's own storage — /luanti, over OPFS —
// which this page can read as well, so the list of worlds and games is the real
// one rather than something kept on the side: a world made in the game shows up
// here on the next visit, and a game imported here shows up in the game's own
// menu. The engine does the writing (installing a zip, deleting a world,
// packing one), through window.Luanti from launcher.js; this file only decides
// what to ask it for.
(function (global) {
	"use strict";

	// The OPFS directory the module mounts at /luanti. See
	// emsdk_wasmfs_opfs_subdir.patch: paths in persistent storage are the paths
	// the program sees, below this one.
	var ROOT_DIR = "luanti";

	// Remembered between visits, so that "Nouvelle partie" proposes the game
	// the player used last.
	var GAME_KEY = "luanti.game";

	var els = {
		launcher: document.getElementById("launcher"),
		storage: document.getElementById("storage"),
		menu: document.getElementById("menu"),
		newGame: document.getElementById("new-game"),
		importButton: document.getElementById("import"),
		progress: document.getElementById("progress"),
		worlds: document.getElementById("worlds"),
		noWorlds: document.getElementById("no-worlds"),
		games: document.getElementById("games"),
		noGames: document.getElementById("no-games"),
		drop: document.getElementById("drop")
	};

	var state = {
		games: [],
		worlds: [],
		selected: null,
		busy: false
	};

	var shown = false;
	var dropAttached = false;

	/////////////////////////////////////////////////////////////////////////
	// Small helpers
	/////////////////////////////////////////////////////////////////////////

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className)
			node.className = className;
		if (text !== undefined && text !== null)
			node.textContent = text;
		return node;
	}

	function button(label, className, onClick) {
		var node = el("button", "button " + className, label);
		node.type = "button";
		node.addEventListener("click", onClick);
		return node;
	}

	function formatBytes(bytes) {
		if (!bytes || bytes < 1)
			return "0 o";
		var units = ["o", "Ko", "Mo", "Go"];
		var value = bytes;
		var unit = 0;
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024;
			unit++;
		}
		var text;
		try {
			text = value.toLocaleString("fr-FR", { maximumFractionDigits: unit === 0 ? 0 : 1 });
		} catch (err) {
			text = String(Math.round(value));
		}
		return text + " " + units[unit];
	}

	function formatDate(ms) {
		var date = new Date(ms);
		try {
			return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(date);
		} catch (err) {
			return date.toLocaleDateString("fr-FR");
		}
	}

	// A message under the buttons: what is going on, or what went wrong.
	function message(text, failed) {
		if (!text) {
			els.progress.hidden = true;
			els.progress.textContent = "";
			return;
		}
		els.progress.hidden = false;
		els.progress.textContent = text;
		els.progress.style.color = failed ? "var(--danger)" : "";
	}

	// What a directory name can hold, in the same terms as validPackName() in
	// src/mainloop.cpp: 1 to 64 of [A-Za-z0-9_.-], not starting with . or -.
	function packName(fileName) {
		var base = String(fileName || "").replace(/\.zip$/i, "");
		base = base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+/, "");
		base = base.slice(0, 64).replace(/[.-]+$/, "");
		return base || "imported-game";
	}

	// "title = Minetest Game" and friends, as game.conf and world.mt write them.
	function parseConf(text) {
		var values = {};
		text.split(/\r?\n/).forEach(function (line) {
			var match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
			if (!match)
				return;
			var value = match[2].trim();
			if (value.length > 1 && value[0] === "\"" && value[value.length - 1] === "\"")
				value = value.slice(1, -1);
			values[match[1].toLowerCase()] = value;
		});
		return values;
	}

	function gameById(id) {
		for (var i = 0; i < state.games.length; i++) {
			if (state.games[i].id === id)
				return state.games[i];
		}
		return null;
	}

	/////////////////////////////////////////////////////////////////////////
	// Reading the engine's storage
	/////////////////////////////////////////////////////////////////////////

	// The directory the module mounts, or null on a browser that gives no
	// persistent storage at all.
	function luantiDir() {
		if (!navigator.storage || !navigator.storage.getDirectory)
			return Promise.resolve(null);
		return navigator.storage.getDirectory().then(function (root) {
			return root.getDirectoryHandle(ROOT_DIR);
		}).catch(function () {
			return null;
		});
	}

	function readText(dir, name) {
		if (!dir)
			return Promise.resolve(null);
		return dir.getFileHandle(name).then(function (handle) {
			return handle.getFile();
		}).then(function (file) {
			return file.text();
		}).catch(function () {
			return null;
		});
	}

	function childDir(dir, name) {
		if (!dir)
			return Promise.resolve(null);
		return dir.getDirectoryHandle(name).catch(function () {
			return null;
		});
	}

	// Every file below `dir`, added up, and when the newest of them was written.
	function treeSize(dir, depth) {
		depth = depth || 0;
		var total = { bytes: 0, latest: 0 };
		if (depth > 8)
			return Promise.resolve(total);
		var pending = [];
		return iterate(dir, function (handle) {
			if (handle.kind === "file") {
				pending.push(handle.getFile().then(function (file) {
					total.bytes += file.size;
					if (file.lastModified > total.latest)
						total.latest = file.lastModified;
				}, function () {}));
			} else {
				pending.push(treeSize(handle, depth + 1).then(function (sub) {
					total.bytes += sub.bytes;
					if (sub.latest > total.latest)
						total.latest = sub.latest;
				}));
			}
		}).then(function () {
			return Promise.all(pending);
		}).then(function () {
			return total;
		});
	}

	// `entries()` is what an OPFS directory offers, and it is async; this walks
	// it without needing async functions in the file.
	function iterate(dir, visit) {
		var iterator = dir.entries();
		var pending = [];
		function step() {
			return iterator.next().then(function (result) {
				if (result.done)
					return;
				var visited = visit(result.value[1], result.value[0]);
				if (visited && typeof visited.then === "function")
					pending.push(visited);
				return step();
			});
		}
		return step().then(function () {
			return Promise.all(pending);
		});
	}

	function readGames(dir) {
		return childDir(dir, "games").then(function (gamesDir) {
			if (!gamesDir)
				return [];
			return childDir(dir, ".packs").then(function (packsDir) {
				var games = [];
				var pending = [];
				return iterate(gamesDir, function (handle, name) {
					if (handle.kind !== "directory")
						return null;
					pending.push(readText(handle, "game.conf").then(function (conf) {
						var meta = conf ? parseConf(conf) : {};
						return readText(packsDir, name + ".ver").then(function (version) {
							games.push({
								id: name,
								title: meta.title || name,
								description: meta.description || "",
								// "local" is what a game the player picked is
								// recorded as; anything else is a version this
								// page shipped and can put back.
								version: (version || "").trim()
							});
						});
					}));
					return null;
				}).then(function () {
					return Promise.all(pending);
				}).then(function () {
					games.sort(function (a, b) {
						if (a.id === defaultGameId())
							return -1;
						if (b.id === defaultGameId())
							return 1;
						return a.title.localeCompare(b.title, "fr");
					});
					return games;
				});
			});
		});
	}

	function readWorlds(dir) {
		return childDir(dir, "worlds").then(function (worldsDir) {
			if (!worldsDir)
				return [];
			var worlds = [];
			var pending = [];
			return iterate(worldsDir, function (handle, name) {
				if (handle.kind !== "directory")
					return null;
				pending.push(treeSize(handle).then(function (size) {
					return readText(handle, "world.mt").then(function (mt) {
						var meta = mt ? parseConf(mt) : {};
						worlds.push({
							name: name,
							game: meta.gameid || "",
							bytes: size.bytes,
							at: size.latest
						});
					});
				}));
				return null;
			}).then(function () {
				return Promise.all(pending);
			}).then(function () {
				worlds.sort(function (a, b) {
					return (b.at || 0) - (a.at || 0) || a.name.localeCompare(b.name, "fr");
				});
				return worlds;
			});
		});
	}

	function defaultGameId() {
		var pack = global.Luanti && global.Luanti.packs && global.Luanti.packs.game;
		return (pack && pack.name) || "minetest_game";
	}

	function updateStorage() {
		var parts = [];
		parts.push(global.Luanti && global.Luanti.persistent
				? "Stockage persistant" : "Pas de stockage : rien ne sera gardé");
		var games = state.games.length;
		var worlds = state.worlds.length;
		parts.push(games + (games > 1 ? " jeux" : " jeu"));
		parts.push(worlds + (worlds > 1 ? " mondes" : " monde"));
		els.storage.textContent = parts.join(" · ");
		if (!navigator.storage || !navigator.storage.estimate)
			return;
		navigator.storage.estimate().then(function (estimate) {
			if (!estimate || !estimate.usage)
				return;
			els.storage.textContent = parts.join(" · ") + " · "
					+ formatBytes(estimate.usage) + " utilisés";
		}, function () {});
	}

	/////////////////////////////////////////////////////////////////////////
	// Drawing the lists
	/////////////////////////////////////////////////////////////////////////

	function render() {
		renderGames();
		renderWorlds();
		updateStorage();
	}

	function renderGames() {
		els.games.textContent = "";
		els.noGames.hidden = state.games.length > 0;
		state.games.forEach(function (game) {
			var selected = game.id === state.selected;
			var card = el("article", "card game" + (selected ? " selected" : ""));
			card.tabIndex = 0;
			card.setAttribute("role", "button");
			card.setAttribute("aria-pressed", selected ? "true" : "false");
			card.title = game.description || game.title;
			card.appendChild(el("span", "card-title", game.title));
			card.appendChild(el("span", "card-meta",
					game.version === "local" ? "importé par vous" : "fourni avec cette page"));
			if (game.version === "local") {
				var actions = el("span", "card-actions");
				actions.appendChild(button("Supprimer", "danger small", function (event) {
					event.stopPropagation();
					askRemoveGame(game, card);
				}));
				card.appendChild(actions);
			}
			var choose = function () { select(game.id); };
			card.addEventListener("click", choose);
			card.addEventListener("keydown", function (event) {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					choose();
				}
			});
			els.games.appendChild(card);
		});
	}

	function renderWorlds() {
		els.worlds.textContent = "";
		els.noWorlds.hidden = state.worlds.length > 0;
		if (!state.worlds.length) {
			els.noWorlds.textContent = global.Luanti && global.Luanti.persistent
					? "Aucun monde enregistré. « Nouvelle partie » ouvre le menu du jeu, "
						+ "où vous pouvez en créer un."
					: "Ce navigateur ne donne pas de stockage : les mondes ne peuvent pas "
						+ "être conservés, et « Nouvelle partie » en crée un pour cette visite.";
		}
		state.worlds.forEach(function (world) {
			var card = el("article", "card");
			card.appendChild(el("span", "card-title", world.name));
			var game = gameById(world.game);
			var meta = [];
			if (world.game)
				meta.push(game ? game.title : world.game);
			meta.push(formatBytes(world.bytes));
			if (world.at)
				meta.push("joué le " + formatDate(world.at));
			card.appendChild(el("span", "card-meta", meta.join(" · ")));

			var actions = el("div", "card-actions");
			actions.appendChild(button("Jouer", "primary small", function () {
				playWorld(world);
			}));
			actions.appendChild(button("Enregistrer", "plain small", function () {
				saveWorld(world, card);
			}));
			actions.appendChild(button("Supprimer", "danger small", function () {
				askDeleteWorld(world, card);
			}));
			card.appendChild(actions);
			els.worlds.appendChild(card);
		});
	}

	function select(id) {
		state.selected = id;
		try {
			localStorage.setItem(GAME_KEY, id || "");
		} catch (err) {
			// Private browsing: the choice just is not remembered.
		}
		renderGames();
	}

	function pickDefaultGame() {
		var remembered = "";
		try {
			remembered = localStorage.getItem(GAME_KEY) || "";
		} catch (err) {
			remembered = "";
		}
		if (remembered && gameById(remembered)) {
			state.selected = remembered;
			return;
		}
		state.selected = gameById(defaultGameId())
				? defaultGameId()
				: (state.games[0] ? state.games[0].id : null);
	}

	/////////////////////////////////////////////////////////////////////////
	// The things the buttons do
	/////////////////////////////////////////////////////////////////////////

	function refresh() {
		return luantiDir().then(function (dir) {
			return Promise.all([readGames(dir), readWorlds(dir)]);
		}).then(function (lists) {
			state.games = lists[0];
			state.worlds = lists[1];
			pickDefaultGame();
			render();
		});
	}

	// The game's own menu, where a world is made: the game picked here is the
	// one it offers (menu_last_game is the setting that dialog reads).
	function newGame() {
		if (state.busy)
			return;
		var overrides = state.selected ? "menu_last_game = " + state.selected : "";
		global.Luanti.play(["luanti"], overrides);
	}

	function playWorld(world) {
		if (state.busy)
			return;
		global.Luanti.play(["luanti", "--world", "/luanti/worlds/" + world.name, "--go"]);
	}

	function saveWorld(world, card) {
		if (state.busy)
			return;
		card.classList.add("busy");
		message("Archivage de « " + world.name + " »…");
		global.Luanti.saveWorld(world.name).then(function (bytes) {
			card.classList.remove("busy");
			if (!bytes) {
				message("« " + world.name + " » n'a pas pu être archivé : "
						+ "il est peut-être trop gros.", true);
				return;
			}
			download(world.name + ".zip", bytes);
			message("« " + world.name + " » est dans vos téléchargements.");
		}, function (err) {
			card.classList.remove("busy");
			message(err.message, true);
		});
	}

	function download(filename, bytes) {
		var url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
		var link = document.createElement("a");
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		setTimeout(function () {
			if (link.parentNode)
				link.parentNode.removeChild(link);
			URL.revokeObjectURL(url);
		}, 4000);
	}

	function askDeleteWorld(world, card) {
		if (state.busy)
			return;
		if (!confirm("Supprimer « " + world.name + " » et tout ce qu'il contient ? "
				+ "Cette action est définitive."))
			return;
		card.classList.add("busy");
		message("Suppression de « " + world.name + " »…");
		global.Luanti.deleteWorld(world.name).then(function (ok) {
			if (!ok) {
				card.classList.remove("busy");
				message("« " + world.name + " » n'a pas pu être entièrement supprimé.", true);
				return;
			}
			message("« " + world.name + " » est supprimé.");
			return refresh();
		}, function (err) {
			card.classList.remove("busy");
			message(err.message, true);
		});
	}

	function askRemoveGame(game, card) {
		if (state.busy)
			return;
		if (!confirm("Supprimer le jeu « " + game.title + " » ? "
				+ "Ses mondes restent, mais ne pourront plus être ouverts sans lui."))
			return;
		card.classList.add("busy");
		message("Suppression de « " + game.title + " »…");
		global.Luanti.removeGame(game.id).then(function (ok) {
			if (!ok) {
				card.classList.remove("busy");
				message("« " + game.title + " » n'a pas pu être entièrement supprimé.", true);
				return;
			}
			message("« " + game.title + " » est supprimé.");
			return refresh();
		}, function (err) {
			card.classList.remove("busy");
			message(err.message, true);
		});
	}

	/////////////////////////////////////////////////////////////////////////
	// Importing a game
	/////////////////////////////////////////////////////////////////////////

	function importGame(file) {
		if (state.busy)
			return;
		var name = packName(file.name);
		if (!/\.zip$/i.test(file.name)) {
			message("« " + file.name + " » n'est pas une archive .zip.", true);
			return;
		}
		state.busy = true;
		els.newGame.disabled = true;
		els.importButton.disabled = true;
		message("Lecture de « " + file.name + " »…");
		new Promise(function (resolve) {
			resolve(file.arrayBuffer());
		}).then(function (buffer) {
			message("Installation de « " + name + " »…");
			return global.Luanti.installGameZip(name, new Uint8Array(buffer));
		}).then(function () {
			return refresh();
		}).then(function () {
			select(name);
			message("« " + name + " » est installé : « Nouvelle partie » le propose.");
		}, function (err) {
			message("« " + name + " » n'a pas pu être installé : " + (err && err.message), true);
		}).then(function () {
			state.busy = false;
			els.newGame.disabled = false;
			els.importButton.disabled = false;
		});
	}

	function pickFile() {
		var input = document.createElement("input");
		input.type = "file";
		input.accept = ".zip,application/zip,application/x-zip-compressed";
		input.style.display = "none";
		// A file input only opens on a click the player made, which is why the
		// button's own click is what calls this.
		input.addEventListener("change", function () {
			var file = input.files && input.files[0];
			if (input.parentNode)
				input.parentNode.removeChild(input);
			if (file)
				importGame(file);
		});
		document.body.appendChild(input);
		input.click();
	}

	function hasFiles(event) {
		var types = event.dataTransfer && event.dataTransfer.types;
		return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
	}

	function attachDrop() {
		if (dropAttached)
			return;
		dropAttached = true;
		var depth = 0;
		global.addEventListener("dragenter", function (event) {
			if (!hasFiles(event))
				return;
			event.preventDefault();
			depth++;
			els.drop.hidden = false;
		});
		global.addEventListener("dragover", function (event) {
			if (!hasFiles(event))
				return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			els.drop.hidden = false;
		});
		// dragleave fires for every element the pointer passes over, and its
		// dataTransfer holds no types to tell a file drag by, so this counts
		// depth and hides the message when the drag has left the page.
		global.addEventListener("dragleave", function () {
			depth = Math.max(0, depth - 1);
			if (!depth)
				els.drop.hidden = true;
		});
		global.addEventListener("drop", function (event) {
			if (!hasFiles(event))
				return;
			event.preventDefault();
			depth = 0;
			els.drop.hidden = true;
			var files = event.dataTransfer.files;
			if (!files.length)
				return;
			if (files.length > 1)
				message("Une archive à la fois : « " + files[0].name + " » est installé.");
			importGame(files[0]);
		});
	}

	/////////////////////////////////////////////////////////////////////////
	// What the engine reports while it works
	/////////////////////////////////////////////////////////////////////////

	function percent(fraction) {
		return Math.max(0, Math.min(100, Math.round((fraction || 0) * 100)));
	}

	function attachHooks() {
		var hooks = global.Luanti && global.Luanti.on;
		if (!hooks)
			return;
		hooks.install = function (kind, name, phase, fraction) {
			if (kind !== "game")
				return;
			message((phase === "delete" ? "Remplacement de « " : "Installation de « ")
					+ name + " » : " + percent(fraction) + " %");
		};
		hooks.zip = function (name, fraction) {
			message("Archivage de « " + name + " » : " + percent(fraction) + " %");
		};
		hooks.worldDelete = function (name, fraction) {
			message("Suppression de « " + name + " » : " + percent(fraction) + " %");
		};
		hooks.gameRemove = function (name, fraction) {
			message("Suppression de « " + name + " » : " + percent(fraction) + " %");
		};
	}

	/////////////////////////////////////////////////////////////////////////
	// Entry point
	/////////////////////////////////////////////////////////////////////////

	function show() {
		if (shown)
			return;
		shown = true;
		attachHooks();
		attachDrop();
		els.newGame.addEventListener("click", newGame);
		els.importButton.addEventListener("click", pickFile);
		message("");
		if (global.Luanti && global.Luanti.persistent)
			els.storage.textContent = "Lecture du stockage…";
		refresh().then(function () {
			els.menu.hidden = false;
		}, function (err) {
			// A launcher that cannot list anything is still a launcher: the
			// game can be started, and the lists are the only thing missing.
			els.storage.textContent = "Le stockage n'a pas pu être lu.";
			console.error("[launcher]", err);
		});
	}

	global.luantiMenu = {
		show: show,
		refresh: refresh
	};
})(window);
