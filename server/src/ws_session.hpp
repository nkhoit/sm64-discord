#pragma once

#include <boost/asio/ip/tcp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/websocket.hpp>
#include <chrono>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <vector>

#include "limits.hpp"
#include "relay.hpp"

// One player's WebSocket connection. Created by HttpSession after it reads an
// upgrade request for /ws?ticket=... (tickets come from POST /api/session).
class WsSession : public std::enable_shared_from_this<WsSession> {
public:
    WsSession(boost::asio::ip::tcp::socket&& socket, Relay& relay, std::string ticket);

    void run(boost::beast::http::request<boost::beast::http::string_body> request);
    void send(std::shared_ptr<std::vector<std::uint8_t>> frame);
    void close(const std::string& reason);
    // For the host: how many clients are connected, which sets how fast it may send.
    void set_client_count(std::size_t clients);

private:
    void on_accept(boost::beast::error_code ec);
    void do_read();
    void on_read(boost::beast::error_code ec, std::size_t bytes);
    void do_write();
    void on_write(boost::beast::error_code ec, std::size_t bytes);
    void leave_room();
    void do_close();

    boost::beast::websocket::stream<boost::beast::tcp_stream> mWs;
    boost::beast::flat_buffer mBuffer;
    std::deque<std::shared_ptr<std::vector<std::uint8_t>>> mWriteQueue;
    std::size_t mQueuedBytes = 0;
    // Set once joined, from the peer's role (and for the host, the room's size). Messages over the
    // limit are dropped; a client that sends at more than twice its rate for a second is disconnected.
    limits::TokenBucket mRate{0, 0};
    std::size_t mDropped = 0;        // in the current one-second window
    std::size_t mDroppedUnlogged = 0;
    std::chrono::steady_clock::time_point mDropWindow;
    std::chrono::steady_clock::time_point mLastDropLog;
    Relay& mRelay;
    std::string mTicket;
    std::string mRoom;
    bool mJoined = false;
    bool mClosing = false;
    std::string mCloseReason;
    std::uint32_t mPeer = 0;
};
