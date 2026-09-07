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

// sceVideocodec - the H.264 decoding interface the Media Engine exposes.
//
// This exists so that flash0:/kd/mpeg.prx can be run in place of our sceMpeg HLE: mpeg.prx needs
// only sceVideocodec, sceMpegbase and sceAudiocodec from us, and the other two we already have.
// The point is to have a reference to compare the HLE against, so it aims to behave like the
// hardware rather than to be the fastest way to get pixels on screen.
//
// Behaviour cross-checked against JPCSP, whose description of the buffer layout was established
// by looking at sceMpegBaseYCrCbCopy output on a real PSP.

#include <algorithm>
#include <vector>

#include "Common/Serialize/Serializer.h"
#include "Common/Serialize/SerializeFuncs.h"
#include "Core/HLE/HLE.h"
#include "Core/HLE/FunctionWrappers.h"
#include "Core/HLE/sceVideocodec.h"
#include "Core/HLE/sceKernelMemory.h"
#include "Core/HW/AvcDecoder.h"
#include "Core/MemMap.h"
#include "Core/MIPS/MIPS.h"

// The context the caller hands us is 96 bytes. The offsets below are what mpeg.prx actually
// reads and writes; anything not listed here it doesn't look at.
enum {
	CTX_MAGIC = 0,          // 0x05100601, same marker sceAudiocodec's context carries
	CTX_VERSION = 4,        // GetVersion writes 0x78 here
	CTX_STATUS = 8,
	CTX_MEM = 12,
	CTX_OUT_INFO = 16,      // pointer to the 108-byte result descriptor
	CTX_EDRAM = 20,
	CTX_EDRAM_SIZE = 24,
	CTX_AU_DATA = 36,       // the access unit to decode
	CTX_AU_SIZE = 40,
	CTX_YUV_STRUCT = 44,    // type 0: pointer to the eight output buffers
	CTX_EDRAM_RAW = 92,
};

// Fields of the descriptor at CTX_OUT_INFO that mpeg.prx reads back.
enum {
	OUT_DATA = 0,
	OUT_SIZE = 4,
	OUT_UNK8 = 8,
	OUT_UNK12 = 12,
	OUT_CONSUMED = 44,
	OUT_WIDTH = 48,
	OUT_HEIGHT = 52,
	OUT_FRAME_READY = 60,   // 2 when a frame came out, 1 when it didn't
	OUT_UNK64 = 64,
	OUT_UNK72 = 72,
	OUT_TIMESTAMP = 76,
	OUT_FPS = 80,
	OUT_BUFFER_Y = 84,
	OUT_BUFFER_CR = 88,
	OUT_BUFFER_CB = 92,
	OUT_WIDTH_Y = 96,
	OUT_WIDTH_CR = 100,
	OUT_WIDTH_CB = 104,
};

static AvcDecoder *g_avcDecoder;
static u32 g_edramAddr;
static int g_frameCount;

// The frame buffers the ME would have allocated in its own memory and reported back. mpeg.prx
// hands us an empty descriptor and reads the addresses out of it afterwards, so they have to be
// ours - see PublishFrameBuffers.
static u32 g_frameBuffers;
static u32 g_frameBuffersSize;
static int g_frameBufferWidth;
static int g_frameBufferHeight;

void __VideocodecInit() {
	g_avcDecoder = nullptr;
	g_edramAddr = 0;
	g_frameCount = 0;
	g_frameBuffers = 0;
	g_frameBuffersSize = 0;
	g_frameBufferWidth = 0;
	g_frameBufferHeight = 0;
}

void __VideocodecShutdown() {
	delete g_avcDecoder;
	g_avcDecoder = nullptr;
	if (g_edramAddr) {
		userMemory.Free(g_edramAddr);
		g_edramAddr = 0;
	}
	if (g_frameBuffers) {
		kernelMemory.Free(g_frameBuffers);
		g_frameBuffers = 0;
	}
}

void __VideocodecDoState(PointerWrap &p) {
	auto s = p.Section("sceVideocodec", 0, 1);
	if (!s) {
		return;
	}
	Do(p, g_edramAddr);
	Do(p, g_frameCount);
	// The decoder itself isn't serializable - a savestate resumes with a fresh one, which costs
	// at most the frames up to the next keyframe.
	if (p.mode == p.MODE_READ) {
		delete g_avcDecoder;
		g_avcDecoder = nullptr;
	}
}

// The descriptor mpeg.prx passes in is empty: on hardware the ME owns the frame buffers, and
// reports where it put them. So allocate them here and fill the descriptor in the shape
// sceMpegBaseCscAvc expects - dimensions in macroblocks, then the eight buffer addresses.
static bool PublishFrameBuffers(u32 structAddr, int width, int height, u32 buffers[8]) {
	const int lumaLeft = ((width + 16) >> 5) * (height >> 1) * 16;
	const int lumaRight = (width >> 5) * (height >> 1) * 16;
	const int sizes[8] = {
		lumaLeft, lumaRight, lumaLeft, lumaRight,
		lumaLeft >> 1, lumaLeft >> 1, lumaRight >> 1, lumaRight >> 1,
	};

	u32 total = 0;
	for (int i = 0; i < 8; i++) {
		total += (sizes[i] + 63) & ~63;
	}
	if (total == 0) {
		return false;
	}

	if (g_frameBuffers && (width != g_frameBufferWidth || height != g_frameBufferHeight)) {
		kernelMemory.Free(g_frameBuffers);
		g_frameBuffers = 0;
	}
	if (!g_frameBuffers) {
		// These live in the ME's own memory on hardware, so taking them from the game's user
		// heap would be wrong even if it fit - Death Jr. has no 191KB to spare there.
		u32 size = total;
		g_frameBuffers = kernelMemory.Alloc(size, false, "VideocodecFrame");
		if (g_frameBuffers == (u32)-1) {
			g_frameBuffers = 0;
			ERROR_LOG(Log::ME, "sceVideocodec: couldn't allocate %d bytes of frame buffers", total);
			return false;
		}
		g_frameBuffersSize = total;
		g_frameBufferWidth = width;
		g_frameBufferHeight = height;
		INFO_LOG(Log::ME, "sceVideocodec: %d bytes of frame buffers at %08x for %dx%d",
			total, g_frameBuffers, width, height);
	}

	u32 addr = g_frameBuffers;
	for (int i = 0; i < 8; i++) {
		buffers[i] = addr;
		addr += (sizes[i] + 63) & ~63;
	}

	if (!Memory::IsValidRange(structAddr, 48)) {
		return false;
	}
	Memory::WriteUnchecked_U32(height >> 4, structAddr + 0);   // macroblocks
	Memory::WriteUnchecked_U32(width >> 4, structAddr + 4);
	for (int i = 0; i < 8; i++) {
		Memory::WriteUnchecked_U32(buffers[i], structAddr + 16 + i * 4);
	}
	return true;
}

// Writes the decoded frame into the eight buffers the hardware uses. The image is in 32-pixel
// vertical bands split into two 16-pixel halves, and which buffer a row lands in depends on
// whether it is even or odd. This is the exact inverse of ReadTiledYCbCr in sceMpeg.cpp, which
// is what reads it back out - see the comment there for the full layout.
static void WriteTiledYCbCr(const u32 *buffers, const AvcDecoder &dec, int width, int height) {
	const int width2 = width >> 1;
	const int height2 = height >> 1;

	const u8 *srcY = dec.Plane(0);
	const u8 *srcCb = dec.Plane(1);
	const u8 *srcCr = dec.Plane(2);
	const int strideY = dec.Stride(0);
	const int strideCb = dec.Stride(1);
	const int strideCr = dec.Stride(2);
	if (!srcY || !srcCb || !srcCr) {
		return;
	}

	const int lumaSizeLeft = ((width + 16) >> 5) * (height >> 1) * 16;
	const int lumaSizeRight = (width >> 5) * (height >> 1) * 16;
	const int ySize[4] = { lumaSizeLeft, lumaSizeRight, lumaSizeLeft, lumaSizeRight };
	const int cSize[4] = { lumaSizeLeft >> 1, lumaSizeLeft >> 1, lumaSizeRight >> 1, lumaSizeRight >> 1 };

	for (int b = 0; b < 4; b++) {
		if (ySize[b] <= 0 || !Memory::IsValidRange(buffers[b], ySize[b])) {
			continue;
		}
		u8 *dst = Memory::GetTypedPointerWriteRange<u8>(buffers[b], ySize[b]);
		if (!dst) {
			continue;
		}
		const int xOffset = (b & 1) ? 16 : 0;
		const int yStart = (b >> 1) ? 1 : 0;
		int j = 0;
		for (int bandX = xOffset; bandX < width; bandX += 32) {
			const int run = std::min(16, width - bandX);
			for (int row = yStart; row < height; row += 2, j += 16) {
				if (run <= 0 || j + run > ySize[b]) {
					continue;
				}
				memcpy(dst + j, srcY + (size_t)row * strideY + bandX, run);
			}
		}
	}

	for (int b = 0; b < 4; b++) {
		if (cSize[b] <= 0 || !Memory::IsValidRange(buffers[4 + b], cSize[b])) {
			continue;
		}
		u8 *dst = Memory::GetTypedPointerWriteRange<u8>(buffers[4 + b], cSize[b]);
		if (!dst) {
			continue;
		}
		const int xOffset = (b >> 1) ? 8 : 0;
		const int yStart = (b & 1) ? 1 : 0;
		int j = 0;
		for (int bandX = xOffset; bandX < width2; bandX += 16) {
			for (int row = yStart; row < height2; row += 2) {
				for (int k = 0; k < 8; k++, j += 2) {
					const int x = bandX + k;
					if (x >= width2 || j + 1 >= cSize[b]) {
						continue;
					}
					dst[j] = srcCb[(size_t)row * strideCb + x];
					dst[j + 1] = srcCr[(size_t)row * strideCr + x];
				}
			}
		}
	}
}

static int sceVideocodecOpen(u32 ctxAddr, int type) {
	if (!Memory::IsValidRange(ctxAddr, 96)) {
		return hleLogError(Log::ME, -1, "bad context pointer");
	}
	Memory::WriteUnchecked_U32(0x05100601, ctxAddr + CTX_MAGIC);
	if (!AvcDecoder::IsAvailable()) {
		return hleLogError(Log::ME, -1, "built without ffmpeg, can't decode video");
	}
	return hleLogInfo(Log::ME, 0, "type %d", type);
}

static int sceVideocodecInit(u32 ctxAddr, int type) {
	if (!Memory::IsValidRange(ctxAddr, 96)) {
		return hleLogError(Log::ME, -1, "bad context pointer");
	}
	Memory::WriteUnchecked_U32(Memory::ReadUnchecked_U32(ctxAddr + CTX_EDRAM) + 8, ctxAddr + CTX_MEM);
	delete g_avcDecoder;
	g_avcDecoder = new AvcDecoder();
	g_frameCount = 0;
	return hleLogInfo(Log::ME, 0, "type %d", type);
}

// Unlike sceAudiocodec, this memory really is written to and read back by sceMpegbase, so it has
// to be a genuine allocation rather than a plausible-looking address.
static int sceVideocodecGetEDRAM(u32 ctxAddr, int type) {
	if (!Memory::IsValidRange(ctxAddr, 96)) {
		return hleLogError(Log::ME, -1, "bad context pointer");
	}
	u32 size = (Memory::ReadUnchecked_U32(ctxAddr + CTX_EDRAM_SIZE) + 63) | 0x3F;
	if (g_edramAddr) {
		userMemory.Free(g_edramAddr);
		g_edramAddr = 0;
	}
	g_edramAddr = userMemory.Alloc(size, false, "VideocodecEDRAM");
	if (g_edramAddr == (u32)-1) {
		g_edramAddr = 0;
		return hleLogError(Log::ME, -1, "couldn't allocate %d bytes", size);
	}
	Memory::WriteUnchecked_U32((g_edramAddr + 63) & ~63, ctxAddr + CTX_EDRAM);
	Memory::WriteUnchecked_U32(g_edramAddr, ctxAddr + CTX_EDRAM_RAW);
	return hleLogInfo(Log::ME, 0, "%d bytes at %08x", size, g_edramAddr);
}

static int sceVideocodecReleaseEDRAM(u32 ctxAddr) {
	if (Memory::IsValidRange(ctxAddr, 96)) {
		Memory::WriteUnchecked_U32(0, ctxAddr + CTX_EDRAM);
		Memory::WriteUnchecked_U32(0, ctxAddr + CTX_EDRAM_RAW);
	}
	if (g_edramAddr) {
		userMemory.Free(g_edramAddr);
		g_edramAddr = 0;
	}
	return hleLogInfo(Log::ME, 0);
}

static int sceVideocodecDecode(u32 ctxAddr, int type) {
	if (!Memory::IsValidRange(ctxAddr, 96)) {
		return hleLogError(Log::ME, -1, "bad context pointer");
	}
	if (type != 0 && type != 1) {
		return hleLogError(Log::ME, -1, "unknown type %d", type);
	}
	if (!g_avcDecoder) {
		g_avcDecoder = new AvcDecoder();
	}

	const u32 auAddr = Memory::ReadUnchecked_U32(ctxAddr + CTX_AU_DATA);
	const int auSize = (int)Memory::ReadUnchecked_U32(ctxAddr + CTX_AU_SIZE);
	const u32 outAddr = Memory::ReadUnchecked_U32(ctxAddr + CTX_OUT_INFO);
	Memory::WriteUnchecked_U32(0, ctxAddr + CTX_STATUS);

	if (!Memory::IsValidRange(outAddr, 108)) {
		return hleLogError(Log::ME, -1, "bad output descriptor");
	}

	bool gotFrame = false;
	if (auSize > 0 && Memory::IsValidRange(auAddr, auSize)) {
		const u8 *au = Memory::GetTypedPointerRange<u8>(auAddr, auSize);
		if (au) {
			gotFrame = g_avcDecoder->Decode(au, auSize);
		}
	}

	const int width = gotFrame ? g_avcDecoder->Width() : 0;
	const int height = gotFrame ? g_avcDecoder->Height() : 0;

	auto out32 = [outAddr](int offset, u32 value) {
		Memory::WriteUnchecked_U32(value, outAddr + offset);
	};

	// Only the type 1 path fills the descriptor in. For type 0 the YCbCr descriptor sits just
	// 0x40 bytes after this one - mpeg.prx allocates them adjacently - so writing the type 1
	// fields here scribbles over the buffer addresses the colour conversion is about to read.
	if (type == 0) {
		out32(8, width);
		out32(12, height);
		out32(28, 1);
		out32(32, gotFrame ? 1 : 0);   // images decoded - mpeg.prx won't convert without this
		out32(36, gotFrame ? 0 : 1);
	} else {
		out32(OUT_DATA, auAddr);
		out32(OUT_SIZE, auSize);
		out32(OUT_UNK12, 0x40);
		out32(OUT_CONSUMED, auSize);
		out32(OUT_WIDTH, width);
		out32(OUT_HEIGHT, height);
		out32(OUT_FRAME_READY, gotFrame ? 2 : 1);
		out32(OUT_UNK64, 1);
		out32(OUT_UNK72, (u32)-1);
		out32(OUT_TIMESTAMP, g_frameCount * 0x64);
		out32(OUT_FPS, 2997);
	}

	if (gotFrame) {
		g_frameCount++;
		if (type == 0) {
			const u32 yuvStructAddr = Memory::ReadUnchecked_U32(ctxAddr + CTX_YUV_STRUCT);
			if (Memory::IsValidRange(yuvStructAddr, 8 * 4)) {
				u32 buffers[8];
				if (PublishFrameBuffers(yuvStructAddr, width, height, buffers)) {
					WriteTiledYCbCr(buffers, *g_avcDecoder, width, height);
				}
			} else {
				WARN_LOG(Log::ME, "sceVideocodecDecode: type 0 without a usable buffer list");
			}
		} else {
			// Type 1 hands back plain planar YUV, so just point at the decoder's own planes -
			// nothing in the descriptor is read until the caller copies from them.
			out32(OUT_WIDTH_Y, width);
			out32(OUT_WIDTH_CR, width / 2);
			out32(OUT_WIDTH_CB, width / 2);
		}
	}

	return hleLogDebug(Log::ME, 0, "type %d, %d bytes -> %s %dx%d",
		type, auSize, gotFrame ? "frame" : "no frame yet", width, height);
}

static int sceVideocodecStop(u32 ctxAddr, int type) {
	if (g_avcDecoder) {
		g_avcDecoder->Flush();
	}
	return hleLogInfo(Log::ME, 0);
}

static int sceVideocodecDelete(u32 ctxAddr, int type) {
	delete g_avcDecoder;
	g_avcDecoder = nullptr;
	return hleLogInfo(Log::ME, 0);
}

static int sceVideocodecGetVersion(u32 ctxAddr, int type) {
	if (!Memory::IsValidRange(ctxAddr, 96)) {
		return hleLogError(Log::ME, -1, "bad context pointer");
	}
	// The value a real PSP returns, read with JpcspTrace.
	Memory::WriteUnchecked_U32(0x78, ctxAddr + CTX_VERSION);
	return hleLogInfo(Log::ME, 0);
}

static int sceVideocodecGetSEI(u32 ctxAddr, int type) {
	return hleLogWarning(Log::ME, 0, "UNIMPL");
}

static int sceVideocodecScanHeader(u32 ctxAddr, int type) {
	return hleLogWarning(Log::ME, 0, "UNIMPL");
}

static int sceVideocodecGetFrameCrop(u32 ctxAddr, int type) {
	return hleLogWarning(Log::ME, 0, "UNIMPL");
}

static int sceVideocodecSetMemory(u32 ctxAddr, int type) {
	return hleLogDebug(Log::ME, 0);
}

static int sceVideocodec_893B32B1(u32 ctxAddr, int type) {
	return hleLogWarning(Log::ME, 0, "UNIMPL");
}

static int sceVideocodec_D95C24D5(u32 ctxAddr, int type) {
	return hleLogWarning(Log::ME, 0, "UNIMPL");
}

const HLEFunction sceVideocodec[] = {
	{0XC01EC829, &WrapI_UI<sceVideocodecOpen>,          "sceVideocodecOpen",          'i', "xi"},
	{0X2D31F5B1, &WrapI_UI<sceVideocodecGetEDRAM>,      "sceVideocodecGetEDRAM",      'i', "xi"},
	{0X17099F0A, &WrapI_UI<sceVideocodecInit>,          "sceVideocodecInit",          'i', "xi"},
	{0XDBA273FA, &WrapI_UI<sceVideocodecDecode>,        "sceVideocodecDecode",        'i', "xi"},
	{0X4F160BF4, &WrapI_U<sceVideocodecReleaseEDRAM>,   "sceVideocodecReleaseEDRAM",  'i', "x" },
	{0X745A7B7A, &WrapI_UI<sceVideocodecSetMemory>,     "sceVideocodecSetMemory",     'i', "xi"},
	{0X2F385E7F, &WrapI_UI<sceVideocodecScanHeader>,    "sceVideocodecScanHeader",    'i', "xi"},
	{0X307E6E1C, &WrapI_UI<sceVideocodecDelete>,        "sceVideocodecDelete",        'i', "xi"},
	{0XA2F0564E, &WrapI_UI<sceVideocodecStop>,          "sceVideocodecStop",          'i', "xi"},
	{0X17CF7D2C, &WrapI_UI<sceVideocodecGetFrameCrop>,  "sceVideocodecGetFrameCrop",  'i', "xi"},
	{0X26927D19, &WrapI_UI<sceVideocodecGetVersion>,    "sceVideocodecGetVersion",    'i', "xi"},
	{0X627B7D42, &WrapI_UI<sceVideocodecGetSEI>,        "sceVideocodecGetSEI",        'i', "xi"},
	{0X893B32B1, &WrapI_UI<sceVideocodec_893B32B1>,     "sceVideocodec_893B32B1",     'i', "xi"},
	{0XD95C24D5, &WrapI_UI<sceVideocodec_D95C24D5>,     "sceVideocodec_D95C24D5",     'i', "xi"},
};

void Register_sceVideocodec() {
	RegisterHLEModule("sceVideocodec", ARRAY_SIZE(sceVideocodec), sceVideocodec);
}
