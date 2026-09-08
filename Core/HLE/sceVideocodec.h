// Copyright (c) 2026- PPSSPP Project.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 2.0 or later versions.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License 2.0 for more details.

// A copy of the GPL 2.0 should have been included with the program.
// If not, see http://www.gnu.org/licenses/

// Official git repository and contact information can be found at
// https://github.com/hrydgard/ppsspp and http://www.ppsspp.org/.

#pragma once

#include "Common/CommonTypes.h"

class PointerWrap;

void __VideocodecInit();
void __VideocodecShutdown();
void __VideocodecDoState(PointerWrap &p);

void Register_sceVideocodec();

// The state of the one open decoder, for the debugger. Unlike sceAudiocodec there is never more
// than one - mpeg.prx opens a single context per movie.
struct VideocodecCtxInfo {
	u32 ctxAddr;
	int type;
	bool hasDecoder;
	int frameCount;
	u32 edramAddr;
	u32 frameBuffers;
	u32 frameBuffersSize;
	int width;
	int height;
};
// Returns false when no context is open.
bool VideocodecGetCtxInfo(VideocodecCtxInfo *info);

// mpeg.prx copies only the four luma buffers into the descriptor it hands sceMpegBaseCscAvc.
// Both ends of that are ours, so the conversion can recover the other four from the allocation
// they came from. Returns false if `firstBuffer` isn't one we handed out.
bool VideocodecGetFrameBuffers(u32 firstBuffer, u32 buffers[8]);
