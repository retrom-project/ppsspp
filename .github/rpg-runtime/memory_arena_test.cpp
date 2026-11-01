#include <cassert>
#include <cstdlib>
#include <malloc.h>
#include <initializer_list>
#include "Common/Log.h"
#include "Common/MemArena.h"

static bool enabled = false;
bool *g_bLogEnabledSetting = &enabled;
LogChannel g_log[(size_t)Log::NUMBER_OF_LOGS];
void GenericLog(Log, LogLevel, const char *, int, const char *, ...) {}

int main() {
	MemArena arena;
	// Address spans for RAM views larger than the ordinary 32 MiB model.
	// Check the real allocator before touching a range that used to corrupt the heap.
	for (size_t size : {0x0A000000U, 0x0C000000U, 0x0E000000U}) {
		assert(arena.GrabMemSpace(size));
		u8 *base = arena.Find4GBBase();
		assert(base && malloc_usable_size(base) >= size);
		auto *view = static_cast<u8 *>(arena.CreateView(0, size - 0x08000000, base + 0x08000000));
		assert(view);
		view[size - 0x08000000 - 1] = 0x5A;
		assert(base[size - 1] == 0x5A);
		arena.ReleaseSpace();
	}
}
