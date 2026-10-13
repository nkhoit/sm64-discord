#include "relay.hpp"

#include <iostream>
#include <random>

#include "limits.hpp"
#include "ws_session.hpp"

namespace {

// How long a ticket stays valid before its WebSocket connects. The host's covers
// downloading and booting the game.
constexpr auto kHostTicketLifetime = std::chrono::seconds(90);
constexpr auto kClientTicketLifetime = std::chrono::seconds(90);
// How long a host that left may still upload the save (see save_room()).
constexpr auto kRetiredHostGrace = std::chrono::seconds(30);

std::string random_ticket_id() {
    static std::random_device device;
    static const char* hex = "0123456789abcdef";
    std::string id;
    for (int i = 0; i < 4; i++) {
        std::uint32_t bits = device();
        for (int j = 0; j < 8; j++) { id += hex[(bits >> (j * 4)) & 0xF]; }
    }
    return id;
}

void write_peer(std::vector<std::uint8_t>& frame, std::uint32_t peer) {
    frame[0] = peer & 0xFF;
    frame[1] = (peer >> 8) & 0xFF;
    frame[2] = (peer >> 16) & 0xFF;
    frame[3] = (peer >> 24) & 0xFF;
}

std::uint32_t read_peer(const std::uint8_t* data) {
    return std::uint32_t(data[0]) | (std::uint32_t(data[1]) << 8) | (std::uint32_t(data[2]) << 16)
         | (std::uint32_t(data[3]) << 24);
}

} // namespace

void Relay::prune_expired() {
    auto now = std::chrono::steady_clock::now();
    for (auto it = mTickets.begin(); it != mTickets.end();) {
        if (!it->second.connected && it->second.expires < now) {
            auto room = mRooms.find(it->second.room);
            if (room != mRooms.end() && room->second.hostTicket == it->first) { room->second.hostTicket.clear(); }
            it = mTickets.erase(it);
            if (room != mRooms.end()) { erase_if_empty(room); }
        } else {
            ++it;
        }
    }
}

void Relay::erase_if_empty(std::unordered_map<std::string, Room>::iterator room) {
    const Room& r = room->second;
    if (!r.host.expired() || !r.hostTicket.empty() || !r.clients.empty()) { return; }
    for (const auto& [id, ticket] : mTickets) {
        if (ticket.room == room->first) { return; }
    }
    mRooms.erase(room);
}

Relay::Reservation Relay::reserve(const std::string& room, const std::string& user) {
    using Result = Reservation::Result;
    prune_expired();

    auto existing = mRooms.find(room);
    if (existing == mRooms.end() && mRooms.size() >= limits::kMaxRooms) { return {Result::TooManyRooms, {}, Role::Client}; }

    std::size_t userSessions = 0, pendingClients = 0;
    for (const auto& [id, ticket] : mTickets) {
        if (!user.empty() && ticket.user == user) { userSessions++; }
        if (ticket.room == room && ticket.role == Role::Client && !ticket.connected) { pendingClients++; }
    }
    if (userSessions >= limits::kMaxSessionsPerUser) { return {Result::TooManySessions, {}, Role::Client}; }

    Room& r = mRooms[room];
    auto id = random_ticket_id();
    auto now = std::chrono::steady_clock::now();

    if (!r.host.expired()) {
        if (1 + r.clients.size() + pendingClients >= limits::kMaxPeersPerRoom) { return {Result::RoomFull, {}, Role::Client}; }
        mTickets[id] = Ticket{room, Role::Client, user, now + kClientTicketLifetime};
        return {Result::Ok, id, Role::Client};
    }
    if (!r.hostTicket.empty()) {
        return {Result::Wait, {}, Role::Client}; // a host is loading
    }
    r.hostTicket = id;
    mTickets[id] = Ticket{room, Role::Host, user, now + kHostTicketLifetime};
    std::cout << "[" << room << "] host reserved\n";
    return {Result::Ok, id, Role::Host};
}

const Relay::Ticket* Relay::find_ticket(const std::string& ticketId) {
    prune_expired();
    auto it = mTickets.find(ticketId);
    return it == mTickets.end() ? nullptr : &it->second;
}

bool Relay::is_host(const std::string& ticketId) {
    const Ticket* ticket = find_ticket(ticketId);
    if (!ticket || ticket->role != Role::Host) { return false; }
    auto room = mRooms.find(ticket->room);
    return room != mRooms.end() && room->second.hostTicket == ticketId;
}

void Relay::prune_retired_hosts() {
    auto now = std::chrono::steady_clock::now();
    for (auto it = mRetiredHosts.begin(); it != mRetiredHosts.end();) {
        it = it->second.second < now ? mRetiredHosts.erase(it) : std::next(it);
    }
}

std::string Relay::save_room(const std::string& ticketId, bool write) {
    if (is_host(ticketId)) { return mTickets.find(ticketId)->second.room; }
    if (!write) { return {}; }
    prune_retired_hosts();
    auto retired = mRetiredHosts.find(ticketId);
    if (retired == mRetiredHosts.end()) { return {}; }
    auto room = mRooms.find(retired->second.first);
    if (room != mRooms.end() && (!room->second.host.expired() || !room->second.hostTicket.empty())) { return {}; }
    return retired->second.first;
}

Relay::JoinResult Relay::join(const std::string& ticketId, const std::shared_ptr<WsSession>& session,
                              std::uint32_t& outPeer, std::string& outRoom) {
    prune_expired();
    auto it = mTickets.find(ticketId);
    if (it == mTickets.end() || it->second.connected) { return JoinResult::BadTicket; }
    Ticket& ticket = it->second;
    outRoom = ticket.room;
    auto room = mRooms.find(ticket.room);
    // A ticket that can't be used is dropped, so it stops counting against the room and the player.
    auto refuse = [&](JoinResult result) {
        mTickets.erase(it);
        if (room != mRooms.end()) { erase_if_empty(room); }
        return result;
    };
    if (room == mRooms.end()) { return refuse(JoinResult::NoHost); }
    Room& r = room->second;

    if (ticket.role == Role::Host) {
        if (r.hostTicket != ticketId || !r.host.expired()) { return refuse(JoinResult::BadTicket); }
        r.host = session;
        ticket.connected = true;
        outPeer = kHostPeer;
        std::cout << "[" << ticket.room << "] host joined\n";
        return JoinResult::Ok;
    }

    if (r.host.expired()) { return refuse(JoinResult::NoHost); }
    if (1 + r.clients.size() >= limits::kMaxPeersPerRoom) { return refuse(JoinResult::RoomFull); }
    outPeer = r.nextPeer++;
    r.clients[outPeer] = session;
    ticket.connected = true;
    if (auto host = r.host.lock()) { host->set_client_count(r.clients.size()); }
    std::cout << "[" << ticket.room << "] client " << outPeer << " joined\n";
    return JoinResult::Ok;
}

void Relay::leave(const std::string& ticketId, const std::string& room, std::uint32_t peer) {
    mTickets.erase(ticketId);
    auto it = mRooms.find(room);
    if (it == mRooms.end()) { return; }
    Room& r = it->second;

    if (peer != kHostPeer) {
        r.clients.erase(peer);
        std::cout << "[" << room << "] client " << peer << " left\n";
        if (auto host = r.host.lock()) { host->set_client_count(r.clients.size()); }
        erase_if_empty(it);
        return;
    }

    // No host migration yet: when the host leaves, the room ends for everyone, and their pages
    // rejoin; the first back becomes the host.
    std::cout << "[" << room << "] host left, closing room\n";
    prune_retired_hosts();
    mRetiredHosts[ticketId] = {room, std::chrono::steady_clock::now() + kRetiredHostGrace};
    auto clients = std::move(r.clients);
    mRooms.erase(it);
    for (auto& [clientPeer, weak] : clients) {
        if (auto client = weak.lock()) { client->close("host left"); }
    }
}

void Relay::forward(const std::string& room, std::uint32_t fromPeer, const std::uint8_t* data, std::size_t length) {
    if (length <= 4) { return; }
    auto it = mRooms.find(room);
    if (it == mRooms.end()) { return; }
    Room& r = it->second;

    std::uint32_t toPeer = read_peer(data);
    std::shared_ptr<WsSession> target;
    if (toPeer == kHostPeer) {
        target = r.host.lock();
    } else if (fromPeer == kHostPeer) {
        // only the host may address clients
        auto client = r.clients.find(toPeer);
        if (client != r.clients.end()) { target = client->second.lock(); }
    }
    if (!target) { return; }

    auto frame = std::make_shared<std::vector<std::uint8_t>>(data, data + length);
    write_peer(*frame, fromPeer);
    target->send(std::move(frame));
}
