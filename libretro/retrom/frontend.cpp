// Copyright (c) 2012- PPSSPP Project.
// This program is free software, licensed under the GNU GPL version 2 or later.
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <emscripten.h>
#include <emscripten/html5.h>
#include "libretro.h"
#include "Core/System.h"
#include "Core/SaveState.h"
#include "Common/Serialize/Serializer.h"
#include "libretro/LibretroGraphicsContext.h"

extern "C" bool retro_retrom_state_ready();

namespace {
EM_JS(void, InstallCanvas, (), {
	GL.offscreenCanvases['canvas'] = {canvas: Module.canvas};
});
std::map<std::string, std::string> options;
retro_hw_render_callback hardware{};
unsigned buttons = 0;
int16_t analogX = 0, analogY = 0;
bool loaded = false, stopped = false;
std::vector<u8> pendingState;
constexpr size_t MAX_STATE = 256 * 1024 * 1024;

void Log(enum retro_log_level level, const char *format, ...) {
	if (level < RETRO_LOG_WARN) return;
	va_list args;
	va_start(args, format);
	vfprintf(stderr, format, args);
	va_end(args);
}

uintptr_t Framebuffer() { return 0; }
retro_proc_address_t Proc(const char *name) {
	return reinterpret_cast<retro_proc_address_t>(emscripten_webgl_get_proc_address(name));
}

bool Environment(unsigned command, void *data) {
	switch (command) {
	case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: *static_cast<const char **>(data) = "/system"; return true;
	case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: *static_cast<const char **>(data) = "/save"; return true;
	case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: static_cast<retro_log_callback *>(data)->log = Log; return true;
	case RETRO_ENVIRONMENT_GET_LANGUAGE: *static_cast<unsigned *>(data) = RETRO_LANGUAGE_ENGLISH; return true;
	case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION: *static_cast<unsigned *>(data) = 2; return true;
	case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: {
		auto *intl = static_cast<retro_core_options_v2_intl *>(data);
		return Environment(RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2, intl->us);
	}
	case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: {
		auto *defs = static_cast<retro_core_options_v2 *>(data)->definitions;
		for (; defs && defs->key; ++defs) options.emplace(defs->key, defs->default_value ? defs->default_value : "");
		return true;
	}
	case RETRO_ENVIRONMENT_GET_VARIABLE: {
		auto *var = static_cast<retro_variable *>(data);
		auto found = options.find(var->key);
		var->value = found == options.end() ? nullptr : found->second.c_str();
		return var->value != nullptr;
	}
	case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: *static_cast<bool *>(data) = false; return true;
	case RETRO_ENVIRONMENT_GET_CAN_DUPE: *static_cast<bool *>(data) = true; return true;
	case RETRO_ENVIRONMENT_GET_FASTFORWARDING: *static_cast<bool *>(data) = false; return true;
	case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER: *static_cast<retro_hw_context_type *>(data) = RETRO_HW_CONTEXT_OPENGLES3; return true;
	case RETRO_ENVIRONMENT_SET_HW_RENDER: {
		auto *hw = static_cast<retro_hw_render_callback *>(data);
		if (hw->context_type != RETRO_HW_CONTEXT_OPENGLES3) return false;
		hw->get_current_framebuffer = Framebuffer;
		hw->get_proc_address = Proc;
		hardware = *hw;
		return true;
	}
	case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: return *static_cast<retro_pixel_format *>(data) == RETRO_PIXEL_FORMAT_XRGB8888;
	case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
	case RETRO_ENVIRONMENT_SET_GEOMETRY:
	case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
	case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
	case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY: return true;
	case RETRO_ENVIRONMENT_SHUTDOWN: stopped = true; return true;
	default: return false;
	}
}

EM_JS(void, Audio, (const int16_t *data, size_t frames), {
	const samples = HEAP16.slice(data >> 1, (data >> 1) + frames * 2);
	postMessage({kind: 'audio', samples}, [samples.buffer]);
});
size_t AudioBatch(const int16_t *data, size_t frames) { Audio(data, frames); return frames; }
void AudioSample(int16_t left, int16_t right) { const int16_t data[] = {left, right}; Audio(data, 1); }
void Video(const void *, unsigned, unsigned, size_t) {}
void Poll() {}
int16_t Input(unsigned port, unsigned device, unsigned index, unsigned id) {
	if (port != 0) return 0;
	if (device == RETRO_DEVICE_JOYPAD && id < 16) return (buttons >> id) & 1;
	if (device == RETRO_DEVICE_ANALOG && index == RETRO_DEVICE_INDEX_ANALOG_LEFT) return id == 0 ? analogX : analogY;
	return 0;
}
}

extern "C" {
EMSCRIPTEN_KEEPALIVE int psp_start(const char *path) {
	if (loaded) return 0;
	InstallCanvas();
	EmscriptenWebGLContextAttributes attrs;
	emscripten_webgl_init_context_attributes(&attrs);
	attrs.majorVersion = 2;
	attrs.alpha = false;
	attrs.depth = true;
	attrs.stencil = true;
	attrs.antialias = false;
	attrs.preserveDrawingBuffer = true;
	int context = emscripten_webgl_create_context("#canvas", &attrs);
	if (context <= 0 || emscripten_webgl_make_context_current(context) != EMSCRIPTEN_RESULT_SUCCESS) return 0;
	retro_set_environment(Environment);
	options["ppsspp_cpu_core"] = "IR JIT";
	options["ppsspp_backend"] = "opengl";
	options["ppsspp_internal_resolution"] = "480x272";
	options["ppsspp_enable_wlan"] = "disabled";
	retro_set_video_refresh(Video);
	retro_set_audio_sample(AudioSample);
	retro_set_audio_sample_batch(AudioBatch);
	retro_set_input_poll(Poll);
	retro_set_input_state(Input);
	retro_init();
	retro_game_info game{path, nullptr, 0, nullptr};
	loaded = retro_load_game(&game);
	if (!loaded || !hardware.context_reset) return 0;
	hardware.context_reset();
	return 1;
}
EMSCRIPTEN_KEEPALIVE int psp_step() {
	if (!loaded || stopped) return 0;
	if (Libretro::emuThreadState == Libretro::EmuThreadState::PAUSED) Libretro::EmuThreadStart();
	retro_run();
	return stopped ? 0 : retro_retrom_state_ready() ? 2 : 1;
}
EMSCRIPTEN_KEEPALIVE void psp_input(unsigned mask, int x, int y) { buttons = mask; analogX = x; analogY = y; }
EMSCRIPTEN_KEEPALIVE void psp_pause() {
	buttons = 0; analogX = analogY = 0;
	if (loaded && Libretro::useEmuThread) Libretro::EmuThreadPause();
}
EMSCRIPTEN_KEEPALIVE size_t psp_state_size() {
	if (!loaded || !retro_retrom_state_ready()) return 0;
	psp_pause();
	pendingState.clear();
	if (SaveState::SaveToRam(pendingState) != CChunkFileReader::ERROR_NONE || pendingState.size() > MAX_STATE) {
		pendingState.clear();
		return 0;
	}
	return pendingState.size();
}
EMSCRIPTEN_KEEPALIVE int psp_save(uint8_t *data, size_t size) {
	if (!data || !size || size != pendingState.size()) {
		return 0;
	}
	memcpy(data, pendingState.data(), size);
	std::vector<u8>().swap(pendingState);
	return 1;
}
EMSCRIPTEN_KEEPALIVE int psp_load(uint8_t *data, size_t size) {
	if (!data || !size || size > MAX_STATE || !loaded || !retro_retrom_state_ready()) {
		return 0;
	}
	psp_pause();
	std::vector<u8> state(data, data + size);
	std::string error;
	return SaveState::LoadFromRam(state, &error) == CChunkFileReader::ERROR_NONE;
}
EMSCRIPTEN_KEEPALIVE void psp_stop() {
	if (!loaded) return;
	if (Libretro::emuThreadState == Libretro::EmuThreadState::PAUSED) Libretro::EmuThreadStart();
	if (hardware.context_destroy) hardware.context_destroy();
	retro_unload_game();
	retro_deinit();
	loaded = false;
	std::vector<u8>().swap(pendingState);
}
}
