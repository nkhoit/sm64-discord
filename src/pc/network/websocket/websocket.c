#ifdef TARGET_WEB

#include <stdio.h>
#include <string.h>
#include <emscripten.h>
#include <emscripten/websocket.h>
#include "websocket.h"
#include "../socket/socket.h" // NO_ERROR, SOCKET_ERROR
#include "pc/debuglog.h"
#include "pc/djui/djui.h"

#define WS_HOST_PEER 0
#define WS_HEADER_LENGTH 4
#define WS_QUEUE_LENGTH 1024

struct WsFrame {
    u32 peer;
    u16 length;
    u8 data[PACKET_LENGTH];
};

struct WsQueue {
    struct WsFrame frames[WS_QUEUE_LENGTH];
    u32 head;
    u32 count;
};

static EMSCRIPTEN_WEBSOCKET_T sSocket = 0;
static bool sSocketOpen = false;
static bool sSocketClosed = false;

// received frames, filled by the browser's callbacks and drained in update()
static struct WsQueue sRxQueue = { 0 };
// frames sent before the socket finished opening
static struct WsQueue sTxQueue = { 0 };

// addresses are (relay peer id + 1) so that 0 means "no address"
static u32 sAddr[MAX_PLAYERS] = { 0 };

// The page sets Module.relayUrl to the relay's /ws URL with the ticket from POST /api/session.
// The ticket decides whether this player hosts, so the URL is the same for host and client.
EM_JS(char*, ws_relay_url, (void), {
    var url = Module.relayUrl
           || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    return stringToNewUTF8(url);
});

// Lets the page offer a reload when the relay drops us (the host left, or the network blipped).
EM_JS(void, ws_notify_page_closed, (int code, const char* reason), {
    if (typeof Module.onRelayClosed === 'function') { Module.onRelayClosed(code, UTF8ToString(reason)); }
});

static bool ws_queue_push(struct WsQueue* queue, u32 peer, const u8* data, u32 length) {
    if (queue->count >= WS_QUEUE_LENGTH || length > PACKET_LENGTH) { return false; }
    struct WsFrame* frame = &queue->frames[(queue->head + queue->count) % WS_QUEUE_LENGTH];
    frame->peer = peer;
    frame->length = length;
    memcpy(frame->data, data, length);
    queue->count++;
    return true;
}

static struct WsFrame* ws_queue_pop(struct WsQueue* queue) {
    if (queue->count == 0) { return NULL; }
    struct WsFrame* frame = &queue->frames[queue->head];
    queue->head = (queue->head + 1) % WS_QUEUE_LENGTH;
    queue->count--;
    return frame;
}

static void ws_queue_clear(struct WsQueue* queue) {
    queue->head = 0;
    queue->count = 0;
}

static int ws_send_frame(u32 peer, const u8* data, u16 length) {
    u8 buffer[WS_HEADER_LENGTH + PACKET_LENGTH];
    if (length > PACKET_LENGTH) { return SOCKET_ERROR; }
    buffer[0] = peer & 0xFF;
    buffer[1] = (peer >> 8) & 0xFF;
    buffer[2] = (peer >> 16) & 0xFF;
    buffer[3] = (peer >> 24) & 0xFF;
    memcpy(&buffer[WS_HEADER_LENGTH], data, length);
    EMSCRIPTEN_RESULT rc = emscripten_websocket_send_binary(sSocket, buffer, WS_HEADER_LENGTH + length);
    if (rc != EMSCRIPTEN_RESULT_SUCCESS) {
        LOG_ERROR("websocket send failed: %d", rc);
        return SOCKET_ERROR;
    }
    return NO_ERROR;
}

static EM_BOOL ws_on_open(UNUSED int eventType, UNUSED const EmscriptenWebSocketOpenEvent* e, UNUSED void* userData) {
    LOG_INFO("connected to relay");
    sSocketOpen = true;
    struct WsFrame* frame;
    while ((frame = ws_queue_pop(&sTxQueue)) != NULL) {
        ws_send_frame(frame->peer, frame->data, frame->length);
    }
    return EM_TRUE;
}

static EM_BOOL ws_on_message(UNUSED int eventType, const EmscriptenWebSocketMessageEvent* e, UNUSED void* userData) {
    if (e->isText || e->numBytes <= WS_HEADER_LENGTH) { return EM_TRUE; }
    u32 peer = (u32)e->data[0] | ((u32)e->data[1] << 8) | ((u32)e->data[2] << 16) | ((u32)e->data[3] << 24);
    if (!ws_queue_push(&sRxQueue, peer, e->data + WS_HEADER_LENGTH, e->numBytes - WS_HEADER_LENGTH)) {
        LOG_ERROR("dropped a websocket packet (%u bytes)", e->numBytes);
    }
    return EM_TRUE;
}

static EM_BOOL ws_on_close(UNUSED int eventType, const EmscriptenWebSocketCloseEvent* e, UNUSED void* userData) {
    LOG_INFO("relay connection closed (%u: %s)", e->code, e->reason);
    sSocketOpen = false;
    sSocketClosed = true;
    ws_notify_page_closed(e->code, e->reason);
    return EM_TRUE;
}

static bool ns_websocket_initialize(enum NetworkType networkType, UNUSED bool reconnecting) {
    if (!emscripten_websocket_is_supported()) { return false; }

    char* url = ws_relay_url();
    EmscriptenWebSocketCreateAttributes attributes;
    emscripten_websocket_init_create_attributes(&attributes);
    attributes.url = url;
    attributes.createOnMainThread = EM_TRUE;
    sSocket = emscripten_websocket_new(&attributes);
    LOG_INFO("connecting to %s", url);
    free(url);
    if (sSocket <= 0) {
        LOG_ERROR("could not create websocket: %d", sSocket);
        sSocket = 0;
        return false;
    }

    sSocketOpen = false;
    sSocketClosed = false;
    emscripten_websocket_set_onopen_callback(sSocket, NULL, ws_on_open);
    emscripten_websocket_set_onmessage_callback(sSocket, NULL, ws_on_message);
    emscripten_websocket_set_onclose_callback(sSocket, NULL, ws_on_close);

    if (networkType == NT_CLIENT) {
        // a client only ever talks to the host
        sAddr[0] = WS_HOST_PEER + 1;
        djui_connect_menu_open();
        gNetworkType = NT_CLIENT;
        network_send_mod_list_request();
    }

    LOG_INFO("initialized");
    return true;
}

static s64 ns_websocket_get_id(UNUSED u8 localIndex) {
    return 0;
}

static char* ns_websocket_get_id_str(u8 localIndex) {
    if (localIndex == UNKNOWN_LOCAL_INDEX) { localIndex = 0; }
    static char idStr[32] = { 0 };
    snprintf(idStr, sizeof(idStr), "peer %u", sAddr[localIndex] - 1);
    return idStr;
}

static void ns_websocket_save_id(u8 localIndex, UNUSED s64 networkId) {
    SOFT_ASSERT(localIndex > 0);
    SOFT_ASSERT(localIndex < MAX_PLAYERS);
    sAddr[localIndex] = sAddr[0];
}

static void ns_websocket_clear_id(u8 localIndex) {
    if (localIndex == 0) { return; }
    SOFT_ASSERT(localIndex < MAX_PLAYERS);
    sAddr[localIndex] = 0;
}

static void* ns_websocket_dup_addr(u8 localIndex) {
    u32* address = malloc(sizeof(u32));
    *address = sAddr[localIndex];
    return address;
}

static bool ns_websocket_match_addr(void* addr1, void* addr2) {
    return *(u32*)addr1 == *(u32*)addr2;
}

static void ns_websocket_update(void) {
    if (gNetworkType == NT_NONE) { return; }

    struct WsFrame* frame;
    while ((frame = ws_queue_pop(&sRxQueue)) != NULL) {
        sAddr[0] = frame->peer + 1;
        u8 localIndex = UNKNOWN_LOCAL_INDEX;
        for (int i = 1; i < MAX_PLAYERS; i++) {
            if (sAddr[i] == sAddr[0]) {
                localIndex = i;
                break;
            }
        }
        network_receive(localIndex, &sAddr[0], frame->data, frame->length);
    }

    if (sSocketClosed) {
        sSocketClosed = false;
        djui_popup_create("Lost connection to the relay server.", 2);
    }
}

static int ns_websocket_send(u8 localIndex, void* address, u8* data, u16 dataLength) {
    if (localIndex != 0) {
        if (gNetworkType == NT_SERVER && gNetworkPlayers[localIndex].type != NPT_CLIENT) { return SOCKET_ERROR; }
        if (gNetworkType == NT_CLIENT && gNetworkPlayers[localIndex].type != NPT_SERVER) { return SOCKET_ERROR; }
    }

    u32 addr = sAddr[localIndex];
    if (localIndex == 0 && address != NULL) { addr = *(u32*)address; }
    if (addr == 0) { return SOCKET_ERROR; }

    if (!sSocketOpen) {
        return ws_queue_push(&sTxQueue, addr - 1, data, dataLength) ? NO_ERROR : SOCKET_ERROR;
    }
    return ws_send_frame(addr - 1, data, dataLength);
}

static void ns_websocket_get_lobby_id(char* destination, u32 destLength) {
    snprintf(destination, destLength, "%s", "");
}

static void ns_websocket_get_lobby_secret(char* destination, u32 destLength) {
    snprintf(destination, destLength, "%s", "");
}

static void ns_websocket_shutdown(UNUSED bool reconnecting) {
    if (sSocket > 0) {
        emscripten_websocket_close(sSocket, 1000, "shutdown");
        emscripten_websocket_delete(sSocket);
    }
    sSocket = 0;
    sSocketOpen = false;
    sSocketClosed = false;
    ws_queue_clear(&sRxQueue);
    ws_queue_clear(&sTxQueue);
    memset(sAddr, 0, sizeof(sAddr));
    LOG_INFO("shutdown");
}

struct NetworkSystem gNetworkSystemWebSocket = {
    .initialize       = ns_websocket_initialize,
    .get_id           = ns_websocket_get_id,
    .get_id_str       = ns_websocket_get_id_str,
    .save_id          = ns_websocket_save_id,
    .clear_id         = ns_websocket_clear_id,
    .dup_addr         = ns_websocket_dup_addr,
    .match_addr       = ns_websocket_match_addr,
    .update           = ns_websocket_update,
    .send             = ns_websocket_send,
    .get_lobby_id     = ns_websocket_get_lobby_id,
    .get_lobby_secret = ns_websocket_get_lobby_secret,
    .shutdown         = ns_websocket_shutdown,
    .requireServerBroadcast = true,
    .name             = "WebSocket",
};

#endif // TARGET_WEB

#ifdef TARGET_WEB
#include "game/level_update.h"
#include "pc/network/network_player.h"

// Test hook: returns the connected players and where their Marios are, as JSON.
// Call from the page with UTF8ToString(Module._web_debug_players()).
EMSCRIPTEN_KEEPALIVE const char* web_debug_players(void) {
    static char json[4096];
    int len = snprintf(json, sizeof(json), "{\"networkType\":%d,\"players\":[", gNetworkType);
    bool first = true;
    for (int i = 0; i < MAX_PLAYERS && len < (int)sizeof(json) - 256; i++) {
        struct NetworkPlayer* np = &gNetworkPlayers[i];
        if (!np->connected) { continue; }
        struct MarioState* m = &gMarioStates[i];
        // names are validated by the game, but keep quotes and backslashes out of the JSON anyway
        char name[MAX_CONFIG_STRING] = { 0 };
        for (int s = 0, d = 0; np->name[s] && d < MAX_CONFIG_STRING - 1; s++) {
            if (np->name[s] != '"' && np->name[s] != '\\') { name[d++] = np->name[s]; }
        }
        len += snprintf(json + len, sizeof(json) - len,
            "%s{\"local\":%d,\"global\":%d,\"name\":\"%s\",\"level\":%d,\"pos\":[%.0f,%.0f,%.0f]}",
            first ? "" : ",", i, np->globalIndex, name, np->currLevelNum, m->pos[0], m->pos[1], m->pos[2]);
        first = false;
    }
    snprintf(json + len, sizeof(json) - len, "]}");
    return json;
}
#endif
