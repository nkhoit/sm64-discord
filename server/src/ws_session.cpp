#include "ws_session.hpp"

#include <algorithm>
#include <iostream>

namespace beast = boost::beast;
namespace websocket = beast::websocket;

WsSession::WsSession(boost::asio::ip::tcp::socket&& socket, Relay& relay, std::string ticket)
    : mWs(std::move(socket)), mRelay(relay), mTicket(std::move(ticket)) {}

void WsSession::run(beast::http::request<beast::http::string_body> request) {
    // Pings a quiet peer so proxies (Cloudflare drops connections idle for ~100 s) keep the
    // connection open, and drops a peer that stops answering.
    websocket::stream_base::timeout timeouts;
    timeouts.handshake_timeout = std::chrono::seconds(30);
    timeouts.idle_timeout = limits::kWsIdleTimeout;
    timeouts.keep_alive_pings = true;
    mWs.set_option(timeouts);
    mWs.read_message_max(limits::kMaxMessageBytes);
    mWs.binary(true);
    mWs.async_accept(request, beast::bind_front_handler(&WsSession::on_accept, shared_from_this()));
}

void WsSession::on_accept(beast::error_code ec) {
    if (ec) { return; }

    switch (mRelay.join(mTicket, shared_from_this(), mPeer, mRoom)) {
        case Relay::JoinResult::Ok:
            mJoined = true;
            if (mPeer == Relay::kHostPeer) {
                mRate = limits::TokenBucket(limits::kHostMessagesPerSecondPerClient, limits::kHostMessageBurstPerClient);
            } else {
                mRate = limits::TokenBucket(limits::kClientMessagesPerSecond, limits::kClientMessageBurst);
            }
            do_read();
            break;
        case Relay::JoinResult::BadTicket:
            close("invalid or expired ticket");
            break;
        case Relay::JoinResult::NoHost:
            close("room has no host");
            break;
        case Relay::JoinResult::RoomFull:
            close("room is full");
            break;
    }
}

void WsSession::do_read() {
    mWs.async_read(mBuffer, beast::bind_front_handler(&WsSession::on_read, shared_from_this()));
}

void WsSession::on_read(beast::error_code ec, std::size_t) {
    if (ec) {
        leave_room();
        return;
    }
    const bool allowed = mRate.take();
    if (allowed && mWs.got_binary()) {
        auto data = static_cast<const std::uint8_t*>(mBuffer.cdata().data());
        mRelay.forward(mRoom, mPeer, data, mBuffer.size());
    }
    mBuffer.consume(mBuffer.size());
    if (!allowed) {
        auto now = std::chrono::steady_clock::now();
        if (now - mDropWindow > std::chrono::seconds(1)) {
            mDropWindow = now;
            mDropped = 0;
        }
        mDropped++;
        mDroppedUnlogged++;
        if (now - mLastDropLog >= limits::kDropLogInterval) {
            std::cout << "[" << mRoom << "] peer " << mPeer << " is over its message rate; dropped " << mDroppedUnlogged
                      << (mLastDropLog == std::chrono::steady_clock::time_point{} ? "" : " since the last report") << "\n";
            mLastDropLog = now;
            mDroppedUnlogged = 0;
        }
        // Closing the host would end the room for everyone, so it is only ever throttled.
        if (mPeer != Relay::kHostPeer && mDropped > limits::kClientMessagesPerSecond) {
            close("sending too fast");
            return;
        }
    }
    do_read();
}

void WsSession::set_client_count(std::size_t clients) {
    const double scale = static_cast<double>(std::max<std::size_t>(1, clients));
    mRate.set_limits(limits::kHostMessagesPerSecondPerClient * scale, limits::kHostMessageBurstPerClient * scale);
}

void WsSession::send(std::shared_ptr<std::vector<std::uint8_t>> frame) {
    if (mClosing) { return; }
    mQueuedBytes += frame->size();
    if (mQueuedBytes > limits::kMaxQueuedBytes) {
        std::cout << "[" << mRoom << "] peer " << mPeer << " can't keep up, disconnecting\n";
        close("connection too slow");
        return;
    }
    mWriteQueue.push_back(std::move(frame));
    if (mWriteQueue.size() == 1) { do_write(); }
}

void WsSession::do_write() {
    mWs.async_write(boost::asio::buffer(*mWriteQueue.front()),
                    beast::bind_front_handler(&WsSession::on_write, shared_from_this()));
}

void WsSession::on_write(beast::error_code ec, std::size_t) {
    if (ec) {
        leave_room();
        return;
    }
    mQueuedBytes -= mWriteQueue.front()->size();
    mWriteQueue.pop_front();
    if (mClosing) {
        do_close();
    } else if (!mWriteQueue.empty()) {
        do_write();
    }
}

void WsSession::close(const std::string& reason) {
    if (mClosing) { return; }
    mClosing = true;
    mCloseReason = reason;
    leave_room();
    // Beast allows only one write-side operation at a time, so let an in-flight write finish first
    if (mWriteQueue.empty()) {
        do_close();
    } else {
        mWriteQueue.resize(1);
        mQueuedBytes = mWriteQueue.front()->size();
    }
}

void WsSession::do_close() {
    websocket::close_reason cr(websocket::close_code::policy_error, mCloseReason);
    mWs.async_close(cr, [self = shared_from_this()](beast::error_code) {});
}

void WsSession::leave_room() {
    if (!mJoined) { return; }
    mJoined = false;
    mRelay.leave(mTicket, mRoom, mPeer);
}
