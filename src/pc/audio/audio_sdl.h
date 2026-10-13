#ifndef AUDIO_SDL_H
#define AUDIO_SDL_H

#include "audio_api.h"

extern struct AudioAPI audio_sdl;

#ifdef TARGET_WEB
// For Module._web_debug_stats()
extern unsigned int gAudioSdlDropped;
int audio_sdl_status(void);
#endif

#endif
