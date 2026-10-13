#include <stdio.h>

#include <SDL2/SDL.h>
#ifdef TARGET_WEB
#include <emscripten.h>
#endif

#include "audio_api.h"

static SDL_AudioDeviceID dev;

#ifdef TARGET_WEB
unsigned int gAudioSdlDropped = 0; // samples the game made but the queue had no room for

int audio_sdl_status(void) {
    return dev ? (int)SDL_GetAudioDeviceStatus(dev) : -1;
}
#endif

static bool audio_sdl_init(void) {
    if (SDL_Init(SDL_INIT_AUDIO) != 0) {
        fprintf(stderr, "SDL init error: %s\n", SDL_GetError());
        return false;
    }

    SDL_AudioSpec want, have;
    SDL_zero(want);
    want.freq = 32000;
    want.format = AUDIO_S16SYS;
    want.channels = 2;
    want.samples = 512;
    want.callback = NULL;
    dev = SDL_OpenAudioDevice(NULL, 0, &want, &have, 0);
    if (dev == 0) {
        fprintf(stderr, "SDL_OpenAudio error: %s\n", SDL_GetError());
        return false;
    }
    SDL_PauseAudioDevice(dev, 0);
#ifdef TARGET_WEB
    // Browsers only let audio start after the player interacts with the page (inside Discord: clicks into
    // the activity), and may suspend it again later. Resume it on any click, tap or key press.
    EM_ASM({
        const resume = () => {
            const ctx = Module['SDL2'] && Module['SDL2'].audioContext;
            if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') { ctx.resume(); }
        };
        for (const type of ['pointerdown', 'keydown', 'touchend']) {
            window.addEventListener(type, resume, { capture: true, passive: true });
        }
    });
#endif
    return true;
}

static int audio_sdl_buffered(void) {
    return SDL_GetQueuedAudioSize(dev) / 4;
}

static int audio_sdl_get_desired_buffered(void) {
    return 1100;
}

static void audio_sdl_play(const uint8_t *buf, size_t len) {
    if (audio_sdl_buffered() < 6000) {
        // Don't fill the audio buffer too much in case this happens
        SDL_QueueAudio(dev, buf, len);
    }
#ifdef TARGET_WEB
    else { gAudioSdlDropped += len / 4; }
#endif
}

static void audio_sdl_shutdown(void)
{
    if (SDL_WasInit(SDL_INIT_AUDIO)) {
        if (dev != 0) {
            SDL_CloseAudioDevice(dev);
            dev = 0;
        }
        SDL_QuitSubSystem(SDL_INIT_AUDIO);
    }
}

struct AudioAPI audio_sdl = {
    audio_sdl_init,
    audio_sdl_buffered,
    audio_sdl_get_desired_buffered,
    audio_sdl_play,
    audio_sdl_shutdown
};
