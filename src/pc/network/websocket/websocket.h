#ifndef WEBSOCKET_H
#define WEBSOCKET_H

#include "../network.h"

// Network system for the browser build. Every packet goes through a relay server
// over one WebSocket, since browsers (and Discord Activities) can't use raw UDP.
//
// Relay framing, all integers little-endian:
//   to relay:   [u32 destination peer][packet]   (the host is peer 0)
//   from relay: [u32 source peer][packet]
// The relay URL and room come from the page (Module.relayUrl, Module.room).
extern struct NetworkSystem gNetworkSystemWebSocket;

#endif
