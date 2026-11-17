#pragma once

#include <functional>
#include <pthread.h>

#include <mutex>

// wasmga.me: held while the server writes its world, so the play page's copy
// of the player's files (wg_request_files) never catches a world half written.
extern std::mutex wg_files_mutex;

// Runs the work the page queued (installing a game, deleting a world, adding
// up what something takes). Only the thread that runs main may touch the
// filesystem, so this is called from the game loop, and from the wait for
// main() before there is one.
void emloop_drain_queue();
