// Installs a game in a Luanti web build from a .zip the player picks.
//
// The module already knows how to unpack one (emloop_install_game_zip in
// src/mainloop.cpp, which lands it in /luanti/games/<name>); what it needs from
// the page is the bytes and a name, and what the player needs is a way to
// choose a file. That is all this file is: a button, drag and drop, and the
// hand-over.
//
// Load it after luanti.js, then either
//
//   <script src="import-game.js"></script>
//   <script>luantiImportGame.attach();</script>
//
// for a floating "Importer un jeu" button and a drop target over the page, or
// call luantiImportGame.install(file) from a control of your own.
//
// If the page already answers emloop_zip_install_progress and
// emloop_zip_installed (the play page does), those are left alone: this only
// fills them in for a page that has no way to show the install.
(function (global) {
	"use strict";

	var labels = {
		button: "Importer un jeu…",
		picking: "Choisissez une archive .zip du jeu.",
		installing: "Installation de « {name} » : {pct} %",
		done: "« {name} » est installé. Revenez à l'onglet Jouer pour le voir.",
		failed: "« {name} » n'a pas pu être installé : l'archive n'est pas un jeu.",
		notReady: "Le jeu n'est pas encore prêt, réessayez dans un instant."
	};

	// What a directory name can hold, in the same terms as validPackName() in
	// src/mainloop.cpp: 1 to 64 of [A-Za-z0-9_.-], not starting with . or -.
	function packName(fileName) {
		var base = String(fileName || "").replace(/\.zip$/i, "");
		base = base.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+/, "");
		base = base.slice(0, 64).replace(/[.-]+$/, "");
		return base || "imported-game";
	}

	function format(text, values) {
		return text.replace(/\{(\w+)\}/g, function (all, key) {
			return values[key] === undefined ? all : values[key];
		});
	}

	/////////////////////////////////////////////////////////////////////////
	// A message at the bottom of the page, so that an install from a page
	// that knows nothing about this one still says how it went.
	/////////////////////////////////////////////////////////////////////////

	var toast = null;
	var toast_timer = 0;

	function say(text, sticky) {
		if (!document.body)
			return;
		if (!toast) {
			toast = document.createElement("div");
			toast.style.cssText = [
				"position:fixed", "left:50%", "bottom:1.5rem",
				"transform:translateX(-50%)", "max-width:min(90vw,32rem)",
				"padding:.7rem 1rem", "border-radius:.6rem",
				"background:#000c", "color:#fff", "font:500 0.95rem/1.35 system-ui,sans-serif",
				"text-align:center", "z-index:2147483000", "pointer-events:none",
				"transition:opacity .25s ease", "opacity:0"
			].join(";");
			document.body.appendChild(toast);
		}
		toast.textContent = text;
		toast.style.opacity = "1";
		clearTimeout(toast_timer);
		if (!sticky) {
			toast_timer = setTimeout(function () { toast.style.opacity = "0"; }, 4000);
		}
	}

	/////////////////////////////////////////////////////////////////////////
	// The install itself
	/////////////////////////////////////////////////////////////////////////

	function module_() {
		var m = global.Module;
		return (m && typeof m.ccall === "function") ? m : null;
	}

	// Hands `bytes` over to the module, which takes the memory from there and
	// answers on emloop_zip_installed().
	function installBytes(name, bytes) {
		var M = module_();
		if (!M) {
			say(labels.notReady);
			return false;
		}
		var ptr = M.ccall("emloop_alloc", "number", ["number"], [bytes.length]);
		if (!ptr) {
			say(labels.notReady);
			return false;
		}
		M.HEAPU8.set(bytes, ptr);
		say(format(labels.installing, { name: name, pct: 0 }), true);
		// No version: the page cannot know whether a chosen zip changed, so it
		// is installed every time.
		M.ccall("emloop_install_game_zip", null,
				["string", "string", "number", "number"], [name, "", ptr, bytes.length]);
		return true;
	}

	function install(file) {
		if (!file)
			return false;
		var name = packName(file.name);
		if (typeof file.arrayBuffer === "function") {
			file.arrayBuffer().then(function (buffer) {
				installBytes(name, new Uint8Array(buffer));
			}, function () {
				say(format(labels.failed, { name: name }));
			});
			return true;
		}
		var reader = new FileReader();
		reader.onload = function () {
			installBytes(name, new Uint8Array(reader.result));
		};
		reader.onerror = function () {
			say(format(labels.failed, { name: name }));
		};
		reader.readAsArrayBuffer(file);
		return true;
	}

	// The module reports an install of any kind through these two. A page that
	// has its own keeps it; one that has none gets these, which say how it
	// went and nothing else.
	function ensureCallbacks() {
		if (typeof global.emloop_zip_install_progress !== "function") {
			global.emloop_zip_install_progress = function (kind, name, phase, fraction) {
				if (kind !== "game")
					return;
				var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
				say(format(labels.installing, { name: name, pct: pct }), true);
			};
		}
		if (typeof global.emloop_zip_installed !== "function") {
			global.emloop_zip_installed = function (kind, name, ok) {
				if (kind !== "game")
					return;
				say(ok ? format(labels.done, { name: name })
						: format(labels.failed, { name: name }), !ok);
			};
		}
	}

	/////////////////////////////////////////////////////////////////////////
	// The button
	/////////////////////////////////////////////////////////////////////////

	var have_button = false;

	function pick() {
		var input = document.createElement("input");
		input.type = "file";
		input.accept = ".zip,application/zip,application/x-zip-compressed";
		input.style.display = "none";
		// A file input only opens on a click the player made, which is why the
		// button's own click is what calls this.
		input.addEventListener("change", function () {
			var file = input.files && input.files[0];
			document.body.removeChild(input);
			if (file)
				install(file);
		});
		document.body.appendChild(input);
		input.click();
	}

	function attach(options) {
		options = options || {};
		if (options.labels) {
			for (var key in options.labels) {
				if (Object.prototype.hasOwnProperty.call(options.labels, key))
					labels[key] = options.labels[key];
			}
		}
		ensureCallbacks();
		if (have_button || !document.body)
			return;
		have_button = true;

		var button = document.createElement("button");
		button.type = "button";
		button.textContent = options.label || labels.button;
		button.style.cssText = [
			"position:fixed", "top:.75rem", "right:.75rem",
			"padding:.55rem .9rem", "border:0", "border-radius:.5rem",
			"background:#16181de6", "color:#fff",
			"font:500 0.9rem/1.2 system-ui,sans-serif",
			"cursor:pointer", "z-index:2147483000", "box-shadow:0 2px 8px #0006"
		].join(";");
		button.addEventListener("click", pick);
		document.body.appendChild(button);

		// Dropping an archive anywhere on the page installs it too, which is
		// how a file is handed over on a computer.
		global.addEventListener("dragover", function (event) {
			if (event.dataTransfer && event.dataTransfer.types &&
					Array.prototype.indexOf.call(event.dataTransfer.types, "Files") !== -1) {
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}
		});
		global.addEventListener("drop", function (event) {
			var files = event.dataTransfer && event.dataTransfer.files;
			if (!files || !files.length)
				return;
			event.preventDefault();
			for (var i = 0; i < files.length; i++)
				install(files[i]);
		});
	}

	global.luantiImportGame = {
		attach: attach,
		install: install,
		installBytes: installBytes,
		labels: labels
	};
})(window);
