## Lua 5.1.5 source

This copy has been patched with Minetest-specific changes (`lua_atccall`)
so it is *not* interchangeable with upstream PUC Lua.

A patch for CVE-2014-5461 has been applied.

`goto name` and `::name::` labels have been added, as Lua 5.2 has them, in
`llex.c`, `lparser.c`, `lcode.c` and `lvm.c`. A desktop Luanti links LuaJIT,
which accepts them, so games are written with them; without this a script that
uses `goto` stops at its first such line with `'=' expected near <name>`. The
rules are 5.2's: a label is visible in the block that holds it and in the
blocks inside it, a goto may jump forward or backward to one, jumping into the
scope of a local is an error, and a goto that leaves a block holding an upvalue
closes it on the way. `OP_JMP` carries the level to close in its unused `A`
field, so jumps made by anything else are unaffected.

A byte from 0x80 to 0xFF may start and continue a name, in `llex.c`. LuaJIT
hands non-ASCII source to its parser transparently, so a name may be a run of
such bytes, and an obfuscated script uses exactly that: `{ \226\144 = "i" }`
is a table key there. Upstream 5.1 accepts only `isalpha()` and `_`, which
stops on the first such byte with `unexpected symbol near '<byte>'`.

A C closure can carry a null function pointer, and `ldo.c` calls it through
the wrapper (`lua_atccall`) without looking.  On a desktop the two are the
same instruction and the game either works or takes a segmentation fault,
which a debugger explains; on the web port the call is an indirect one through
the function table, so null arrives as a wasm trap: `RuntimeError: null
function`, thrown in a worker, with no stack and with the engine left waiting
on it — the log simply stops.  The call now raises `attempt to call a null C
function`, which the error handler reports with the traceback that names the
mod and the line.

`\xXX` in a string is one byte, as LuaJIT and Lua 5.2 read it, in `llex.c`.
Upstream 5.1 does not fail on it: it throws the backslash away and keeps the
`x`, so `"\xAD"` is three characters there and one here. That is silent, and
it is what broke an obfuscated game's ChaCha20 nonce — twelve bytes expected,
`invalid IV size: 24B` obtained — long before any syntax error could name it.
