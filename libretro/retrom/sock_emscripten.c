// Copyright (c) 2012- PPSSPP Project.
// This program is free software, licensed under the GNU GPL version 2 or later.
// Emscripten's socket shim supports MSG_NOSIGNAL, not BSD SO_NOSIGPIPE.
// Limit this platform selection to the unmodified postoffice implementation.
#define __linux__ 1
#include "ext/aemu_postoffice/client/sock_impl_linux.c"
