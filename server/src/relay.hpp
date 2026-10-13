#pragma once

#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

class WsSession;

// Routes packets between the players in each room. The host is always peer 0 and
// clients get increasing ids. Clients only talk to the host; the host relays to
// everyone else (sm64coopdx's server-broadcast model).
//
// Frames are [u32 peer, little-endian][packet]: the destination when sent to the
// relay, the source when sent from it.
//
// Players get into a room with a ticket from reserve(). The first player in an
// empty room is told to host; while that host is still loading, others are told
// to wait, so a room never has two hosts. Rooms, players per room and sessions
// per Discord account are capped (see limits.hpp).
class Relay {
public:
    static constexpr std::uint32_t kHostPeer = 0;

    enum class Role { Host, Client };
    enum class JoinResult { Ok, BadTicket, NoHost, RoomFull };

    struct Ticket {
        std::string room;
        Role role = Role::Client;
        std::string user; // Discord user id; empty in LAN test mode
        std::chrono::steady_clock::time_point expires;
        bool connected = false;
    };

    struct Reservation {
        enum class Result {
            Ok,
            Wait,            // the room's host is still loading
            RoomFull,        // kMaxPeersPerRoom players are in or on their way
            TooManyRooms,    // kMaxRooms rooms exist and this would be a new one
            TooManySessions, // this account already holds kMaxSessionsPerUser tickets
        };
        Result result = Result::Ok;
        std::string ticket;
        Role role = Role::Client;
    };

    Reservation reserve(const std::string& room, const std::string& user);
    const Ticket* find_ticket(const std::string& ticketId);
    // True while this ticket's holder is (or is about to be) the room's host.
    bool is_host(const std::string& ticketId);
    // The room whose save this ticket may read (the host) or write (the host, or a host that
    // left in the last kRetiredHostGrace while nobody has taken over, so the upload a closing
    // page sends as it goes still lands). Empty if neither.
    std::string save_room(const std::string& ticketId, bool write);

    JoinResult join(const std::string& ticketId, const std::shared_ptr<WsSession>& session, std::uint32_t& outPeer,
                    std::string& outRoom);
    void leave(const std::string& ticketId, const std::string& room, std::uint32_t peer);
    void forward(const std::string& room, std::uint32_t fromPeer, const std::uint8_t* data, std::size_t length);

private:
    struct Room {
        std::weak_ptr<WsSession> host;
        std::string hostTicket;
        std::map<std::uint32_t, std::weak_ptr<WsSession>> clients;
        std::uint32_t nextPeer = 1;
    };

    void prune_expired();
    void prune_retired_hosts();
    // Forgets the room if nobody is in it or on their way.
    void erase_if_empty(std::unordered_map<std::string, Room>::iterator room);

    std::unordered_map<std::string, Room> mRooms;
    std::unordered_map<std::string, Ticket> mTickets;
    // host ticket -> room and until when its last save upload is accepted
    std::unordered_map<std::string, std::pair<std::string, std::chrono::steady_clock::time_point>> mRetiredHosts;
};
