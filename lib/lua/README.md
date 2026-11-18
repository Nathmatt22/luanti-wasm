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
