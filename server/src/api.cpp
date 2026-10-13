#include "api.hpp"

#include <boost/asio/post.hpp>
#include <boost/json.hpp>
#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <iostream>
#include <limits>
#include <random>

#include "limits.hpp"

namespace http = boost::beast::http;
namespace json = boost::json;

namespace {

Api::Response make_response(const Api::Request& request, http::status status, std::string body,
                            const char* contentType = "application/json") {
    Api::Response res(status, request.version());
    res.set(http::field::content_type, contentType);
    res.set(http::field::cache_control, "no-store");
    res.keep_alive(request.keep_alive());
    res.body() = std::move(body);
    res.prepare_payload();
    return res;
}

Api::Response json_response(const Api::Request& request, http::status status, const json::object& obj) {
    return make_response(request, status, json::serialize(obj));
}

Api::Response error_response(const Api::Request& request, http::status status, const std::string& message) {
    return json_response(request, status, json::object{{"error", message}});
}

std::string query_value(std::string_view target, std::string_view key) {
    auto q = target.find('?');
    if (q == std::string_view::npos) { return {}; }
    std::string_view query = target.substr(q + 1);
    while (!query.empty()) {
        auto amp = query.find('&');
        std::string_view pair = query.substr(0, amp);
        auto eq = pair.find('=');
        if (eq != std::string_view::npos && pair.substr(0, eq) == key) { return std::string(pair.substr(eq + 1)); }
        if (amp == std::string_view::npos) { break; }
        query.remove_prefix(amp + 1);
    }
    return {};
}

std::string json_string(const json::object& obj, const char* key) {
    if (auto* v = obj.if_contains(key); v && v->is_string()) { return std::string(v->as_string()); }
    return {};
}

bool is_snowflake(const std::string& value) {
    if (value.empty() || value.size() > 20) { return false; }
    for (char c : value) {
        if (!std::isdigit(static_cast<unsigned char>(c))) { return false; }
    }
    return true;
}

// Lowercase letters, digits and dashes only, so room names are safe as file names.
std::string sanitize_room(const std::string& value) {
    std::string out;
    for (char c : value) {
        if (std::isalnum(static_cast<unsigned char>(c))) {
            out += static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        } else if (c == '-' || c == '_') {
            out += '-';
        }
        if (out.size() >= 32) { break; }
    }
    return out.empty() ? "default" : out;
}

bool is_local_network(const boost::asio::ip::address& address) {
    if (address.is_loopback()) { return true; }
    if (address.is_v4()) {
        auto bytes = address.to_v4().to_bytes();
        return bytes[0] == 10 || (bytes[0] == 172 && (bytes[1] & 0xF0) == 16) || (bytes[0] == 192 && bytes[1] == 168)
            || (bytes[0] == 169 && bytes[1] == 254);
    }
    auto v6 = address.to_v6();
    if (v6.is_v4_mapped()) { return is_local_network(boost::asio::ip::make_address_v4(boost::asio::ip::v4_mapped, v6)); }
    auto bytes = v6.to_bytes();
    return v6.is_link_local() || (bytes[0] & 0xFE) == 0xFC; // fe80::/10, fc00::/7
}

std::optional<json::object> parse_body(const Api::Request& request) {
    boost::system::error_code ec;
    auto value = json::parse(request.body(), ec);
    if (ec || !value.is_object()) { return std::nullopt; }
    return value.as_object();
}

enum class DiagnosticRule {
    Number, Integer, Boolean, Phase, AudioState, NetworkState, RuntimeError,
    Game, Audio, Performance, Network, Runtime,
};
struct DiagnosticField {
    std::string_view name;
    DiagnosticRule rule;
    double minimum = 0;
    double maximum = 0;
};

bool diagnostic_number(const json::value& value, double minimum, double maximum, bool integer) {
    double number = 0;
    if (value.is_int64()) { number = static_cast<double>(value.as_int64()); }
    else if (value.is_uint64()) { number = static_cast<double>(value.as_uint64()); }
    else if (value.is_double()) { number = value.as_double(); }
    else { return false; }
    return std::isfinite(number) && number >= minimum && number <= maximum && (!integer || std::trunc(number) == number);
}

bool diagnostic_enum(const json::value& value, std::initializer_list<std::string_view> allowed) {
    if (!value.is_string()) { return false; }
    const std::string_view actual(value.as_string().data(), value.as_string().size());
    return std::find(allowed.begin(), allowed.end(), actual) != allowed.end();
}

bool diagnostic_fields(const json::value& value, std::initializer_list<DiagnosticField> fields, bool nonempty = false);

bool diagnostic_value(const json::value& value, const DiagnosticField& field) {
    switch (field.rule) {
    case DiagnosticRule::Number:
        return diagnostic_number(value, field.minimum, field.maximum, false);
    case DiagnosticRule::Integer:
        return diagnostic_number(value, field.minimum, field.maximum, true);
    case DiagnosticRule::Boolean:
        return value.is_bool();
    case DiagnosticRule::Phase:
        return diagnostic_enum(value, {"loading", "playing", "closed"});
    case DiagnosticRule::AudioState:
        return diagnostic_enum(value, {"unavailable", "suspended", "running", "closed", "interrupted"});
    case DiagnosticRule::NetworkState:
        return diagnostic_enum(value, {"loading", "connecting", "connected", "closed", "offline", "unknown"});
    case DiagnosticRule::RuntimeError:
        return diagnostic_enum(value, {"none", "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError",
                                       "URIError", "EvalError", "RuntimeError", "Other"});
    case DiagnosticRule::Game:
        return diagnostic_fields(value, {{"ticksPerSec", DiagnosticRule::Number, 0, 1000},
                                         {"framesPerSec", DiagnosticRule::Number, 0, 1000},
                                         {"worstTickMs", DiagnosticRule::Number, 0, 600000}});
    case DiagnosticRule::Audio:
        return diagnostic_fields(value, {{"state", DiagnosticRule::AudioState},
                                         {"sampleRate", DiagnosticRule::Number, 0, 384000},
                                         {"queueFrames", DiagnosticRule::Integer, 0, 1000000},
                                         {"emptyDelta", DiagnosticRule::Integer, 0, 1000000},
                                         {"droppedDelta", DiagnosticRule::Integer, 0, 100000000},
                                         {"peak", DiagnosticRule::Number, 0, 32768},
                                         {"callbacks", DiagnosticRule::Integer, 0, 100000000},
                                         {"lateCallbacks", DiagnosticRule::Integer, 0, 100000000},
                                         {"maxCallbackGapMs", DiagnosticRule::Number, 0, 600000},
                                         {"sampledFrames", DiagnosticRule::Integer, 0, 100000000},
                                         {"clippedSamples", DiagnosticRule::Integer, 0, 100000000},
                                         {"boundaryJumps", DiagnosticRule::Integer, 0, 100000000}});
    case DiagnosticRule::Performance:
        return diagnostic_fields(value, {{"longTasks", DiagnosticRule::Integer, 0, 1000000},
                                         {"longestTaskMs", DiagnosticRule::Number, 0, 600000},
                                         {"maxRafGapMs", DiagnosticRule::Number, 0, 600000}});
    case DiagnosticRule::Network:
        return diagnostic_fields(value, {{"state", DiagnosticRule::NetworkState},
                                         {"closeCode", DiagnosticRule::Integer, 0, 4999},
                                         {"rejoins", DiagnosticRule::Integer, 0, 10000},
                                         {"uploadFailures", DiagnosticRule::Integer, 0, 10000}});
    case DiagnosticRule::Runtime:
        return diagnostic_fields(value, {{"errors", DiagnosticRule::Integer, 0, 10000},
                                         {"lastError", DiagnosticRule::RuntimeError}});
    }
    return false;
}

bool diagnostic_fields(const json::value& value, std::initializer_list<DiagnosticField> fields, bool nonempty) {
    if (!value.is_object() || (nonempty && value.as_object().empty())) { return false; }
    for (const auto& item : value.as_object()) {
        const std::string_view name(item.key().data(), item.key().size());
        const auto rule = std::find_if(fields.begin(), fields.end(), [&](const DiagnosticField& field) { return field.name == name; });
        if (rule == fields.end() || !diagnostic_value(item.value(), *rule)) { return false; }
    }
    return true;
}

bool validate_diagnostic_sample(const json::value& value) {
    return diagnostic_fields(value, {{"uptimeMs", DiagnosticRule::Number, 0, 604800000},
                                     {"phase", DiagnosticRule::Phase},
                                     {"visible", DiagnosticRule::Boolean},
                                     {"game", DiagnosticRule::Game},
                                     {"audio", DiagnosticRule::Audio},
                                     {"performance", DiagnosticRule::Performance},
                                     {"network", DiagnosticRule::Network},
                                     {"runtime", DiagnosticRule::Runtime}}, true);
}

bool validate_diagnostic_report(const Api::Request& request, json::object& report, std::string& ticket) {
    boost::system::error_code ec;
    const json::value parsed = json::parse(request.body(), ec);
    if (ec || !parsed.is_object()) { return false; }
    const auto& object = parsed.as_object();
    static constexpr std::array<std::string_view, 7> allowed = {"ticket", "version", "kind", "category", "seq", "sample", "history"};
    for (const auto& item : object) {
        const std::string_view name(item.key().data(), item.key().size());
        if (std::find(allowed.begin(), allowed.end(), name) == allowed.end()) { return false; }
    }
    const auto* ticketValue = object.if_contains("ticket");
    const auto* version = object.if_contains("version");
    const auto* kind = object.if_contains("kind");
    const auto* category = object.if_contains("category");
    const auto* sequence = object.if_contains("seq");
    const auto* sample = object.if_contains("sample");
    if (!ticketValue || !ticketValue->is_string() || ticketValue->as_string().empty() || ticketValue->as_string().size() > 128
        || !version || !diagnostic_number(*version, 1, 1, true)
        || !kind || !diagnostic_enum(*kind, {"periodic", "issue", "error"})
        || !category || !diagnostic_enum(*category, {"audio", "performance", "network", "runtime", "other"})
        || !sequence || !diagnostic_number(*sequence, 1, 9007199254740991.0, true)
        || !sample || !validate_diagnostic_sample(*sample)) {
        return false;
    }
    if (const auto* history = object.if_contains("history")) {
        if (!history->is_array() || history->as_array().size() > 6) { return false; }
        for (const auto& historicalSample : history->as_array()) {
            if (!validate_diagnostic_sample(historicalSample)) { return false; }
        }
    }
    ticket.assign(ticketValue->as_string().data(), ticketValue->as_string().size());
    report = object;
    report.erase("ticket");
    return true;
}

std::optional<std::string> new_diagnostic_session_id() {
    static constexpr char hex[] = "0123456789abcdef";
    try {
        std::random_device random;
        std::string id;
        id.reserve(32);
        for (int i = 0; i < 4; ++i) {
            const std::uint32_t bits = random();
            for (int nibble = 0; nibble < 8; ++nibble) { id.push_back(hex[(bits >> (nibble * 4)) & 0x0f]); }
        }
        return id;
    } catch (...) {
        return std::nullopt;
    }
}

const char* role_name(Relay::Role role) {
    return role == Relay::Role::Host ? "host" : "client";
}

} // namespace

Api::Api(const Config& config, Relay& relay, boost::asio::any_io_executor ioExecutor)
    : mConfig(config),
      mRelay(relay),
      mDiscord(config.discordApiBase, config.discordClientId, config.discordClientSecret),
      mSaves(config.dataDir),
      mDiagnosticsStore(config.dataDir, config.wwwRoot),
      mIo(std::move(ioExecutor)) {
    if (mConfig.diagnostics) {
        boost::asio::post(mDiagnosticsPool, [this] { mDiagnosticsReady = mDiagnosticsStore.initialize(); });
    }
}

Api::~Api() {
    mDiscordPool.join();
    mSavePool.join();
    mDiagnosticsPool.join();
}

template <typename Work, typename Done>
void Api::run_blocking(boost::asio::thread_pool& pool, Work work, Done done) {
    boost::asio::post(pool, [this, work = std::move(work), done = std::move(done)]() mutable {
        auto result = work();
        boost::asio::post(mIo, [done = std::move(done), result = std::move(result)]() mutable { done(std::move(result)); });
    });
}

bool Api::reserve_discord_call(const Request& request, Respond& respond) {
    if (mPendingDiscordCalls >= limits::kMaxPendingDiscordCalls) {
        respond(error_response(request, http::status::service_unavailable, "The server is busy. Try again in a moment."));
        return false;
    }
    mPendingDiscordCalls++;
    return true;
}

Api::DiagnosticTicketResult Api::take_diagnostic_token(const std::string& ticket, std::string& sessionId) {
    constexpr std::size_t kMaxDiagnosticTicketStates = 1024;
    constexpr double kBurst = 4;
    constexpr double kRatePerSecond = 0.2;
    const auto now = std::chrono::steady_clock::now();
    auto state = mDiagnosticTickets.find(ticket);
    if (state == mDiagnosticTickets.end()) {
        if (mDiagnosticTickets.size() >= kMaxDiagnosticTicketStates) {
            for (auto it = mDiagnosticTickets.begin(); it != mDiagnosticTickets.end();) {
                if (!mRelay.find_ticket(it->first)) { it = mDiagnosticTickets.erase(it); }
                else { ++it; }
            }
        }
        if (mDiagnosticTickets.size() >= kMaxDiagnosticTicketStates) { return DiagnosticTicketResult::AtCapacity; }
        std::optional<std::string> id;
        for (int attempt = 0; attempt < 8 && !id; ++attempt) {
            auto candidate = new_diagnostic_session_id();
            if (candidate && std::none_of(mDiagnosticTickets.begin(), mDiagnosticTickets.end(),
                                          [&](const auto& item) { return item.second.sessionId == *candidate; })) {
                id = std::move(candidate);
            }
        }
        if (!id) { return DiagnosticTicketResult::Failed; }
        state = mDiagnosticTickets.emplace(ticket, DiagnosticTicketState{std::move(*id), kBurst, now}).first;
    }
    const double elapsed = std::chrono::duration<double>(now - state->second.refilledAt).count();
    state->second.tokens = std::min(kBurst, state->second.tokens + std::max(0.0, elapsed) * kRatePerSecond);
    state->second.refilledAt = now;
    if (state->second.tokens < 1) { return DiagnosticTicketResult::RateLimited; }
    state->second.tokens -= 1;
    sessionId = state->second.sessionId;
    return DiagnosticTicketResult::Allowed;
}

void Api::handle(const Request& request, const boost::asio::ip::address& remote, bool viaProxy, Respond respond) {
    std::string_view target(request.target().data(), request.target().size());
    std::string_view path = target.substr(0, target.find('?'));
    if (path.rfind("/.proxy", 0) == 0) { path.remove_prefix(7); }

    if (path == "/api/config" && request.method() == http::verb::get) {
        respond(json_response(request, http::status::ok,
                              json::object{{"clientId", mConfig.discordClientId},
                                           {"discord", !mConfig.discordClientId.empty() && !mConfig.discordClientSecret.empty()},
                                           {"lanTest", mConfig.allowLanTest},
                                           {"hostedRom", !mConfig.romBytes.empty()},
                                           {"diagnostics", mConfig.diagnostics}}));
    } else if (path == "/api/diagnostics") {
        handle_diagnostics(request, remote, viaProxy, std::move(respond));
    } else if (path == "/api/token" && request.method() == http::verb::post) {
        handle_token(request, std::move(respond));
    } else if (path == "/api/session" && request.method() == http::verb::post) {
        handle_session(request, remote, viaProxy, std::move(respond));
    } else if (path == "/api/rom") {
        handle_rom(request, remote, viaProxy, std::move(respond));
    } else if (path == "/api/save") {
        handle_save(request, std::move(respond));
    } else {
        respond(error_response(request, http::status::not_found, "not found"));
    }
}

void Api::handle_diagnostics(const Request& request, const boost::asio::ip::address& remote, bool viaProxy,
                             Respond respond) {
    if (request.method() != http::verb::post) {
        respond(error_response(request, http::status::method_not_allowed, "method not allowed"));
        return;
    }
    if (!mConfig.diagnostics) {
        respond(error_response(request, http::status::service_unavailable, "diagnostics unavailable"));
        return;
    }
    constexpr std::size_t kMaxBodyBytes = 16 * 1024;
    if (request.body().size() > kMaxBodyBytes) {
        respond(error_response(request, http::status::payload_too_large, "payload too large"));
        return;
    }
    json::object report;
    std::string ticketId;
    if (!validate_diagnostic_report(request, report, ticketId)) {
        respond(error_response(request, http::status::bad_request, "invalid diagnostics report"));
        return;
    }

    const Relay::Ticket* ticket = mRelay.find_ticket(ticketId);
    if (!ticket) {
        respond(error_response(request, http::status::forbidden, "forbidden"));
        return;
    }
    const std::string ticketRoom = ticket->room;
    const bool lanTicket = ticketRoom.rfind("lan-", 0) == 0;
    const Relay::Role role = ticket->role;
    if (lanTicket) {
        if (!ticket->user.empty() || !mConfig.allowLanTest || viaProxy || !is_local_network(remote)) {
            respond(error_response(request, http::status::forbidden, "forbidden"));
            return;
        }
    } else {
        if (ticket->user.empty() || ticketRoom.size() < 2 || ticketRoom.front() != 'g') {
            respond(error_response(request, http::status::forbidden, "forbidden"));
            return;
        }
        const std::string guildId = ticketRoom.substr(1);
        if (!is_snowflake(guildId) || mConfig.discordGuildIds.find(guildId) == mConfig.discordGuildIds.end()) {
            respond(error_response(request, http::status::forbidden, "forbidden"));
            return;
        }
    }
    // LAN room labels originate from the test page, so persist only the server-derived LAN class.
    const std::string room = lanTicket ? "lan" : ticketRoom;

    if (!mPendingDiagnostics.try_reserve()) {
        respond(error_response(request, http::status::service_unavailable, "diagnostics unavailable"));
        return;
    }
    std::string sessionId;
    const DiagnosticTicketResult rate = take_diagnostic_token(ticketId, sessionId);
    if (rate != DiagnosticTicketResult::Allowed) {
        mPendingDiagnostics.release();
        const http::status status = rate == DiagnosticTicketResult::RateLimited ? http::status::too_many_requests
                                                                                 : http::status::service_unavailable;
        const char* message = rate == DiagnosticTicketResult::RateLimited ? "rate limited" : "diagnostics unavailable";
        respond(error_response(request, status, message));
        return;
    }

    const auto receivedAt = std::chrono::system_clock::now();
    const std::string sanitizedReport = json::serialize(report);
    const std::string derivedRole(role_name(role));
    run_blocking(mDiagnosticsPool,
                 [this, receivedAt, sessionId, room, derivedRole, sanitizedReport] {
                     try {
                         return mDiagnosticsReady
                             && mDiagnosticsStore.store(receivedAt, sessionId, room, derivedRole, sanitizedReport);
                     } catch (...) {
                         return false;
                     }
                 },
                 [this, request, sessionId, respond = std::move(respond)](bool stored) mutable {
                     mPendingDiagnostics.release();
                     if (!stored) {
                         respond(error_response(request, http::status::service_unavailable, "diagnostics unavailable"));
                         return;
                     }
                     respond(json_response(request, http::status::accepted,
                                           json::object{{"stored", true}, {"sessionId", sessionId}}));
                 });
}

void Api::handle_token(const Request& request, Respond respond) {
    auto body = parse_body(request);
    std::string code = body ? json_string(*body, "code") : "";
    if (code.empty() || mConfig.discordClientSecret.empty()) {
        respond(error_response(request, http::status::bad_request, "missing code or server not configured for Discord"));
        return;
    }
    if (!reserve_discord_call(request, respond)) { return; }
    run_blocking(mDiscordPool, [this, code] { return mDiscord.exchange_code(code); },
                 [this, request, respond = std::move(respond)](std::optional<std::string> token) {
                     mPendingDiscordCalls--;
                     if (!token) {
                         respond(error_response(request, http::status::unauthorized, "code exchange failed"));
                         return;
                     }
                     respond(json_response(request, http::status::ok, json::object{{"access_token", *token}}));
                 });
}

void Api::handle_session(const Request& request, const boost::asio::ip::address& remote, bool viaProxy,
                         Respond respond) {
    auto body = parse_body(request);
    if (!body) {
        respond(error_response(request, http::status::bad_request, "expected a JSON body"));
        return;
    }

    // Reserves a slot in the room and answers with the ticket, or asks the page to retry.
    auto finish = [this, request](const std::string& room, const std::string& name, const std::string& user,
                                  Respond respond) {
        using Result = Relay::Reservation::Result;
        auto reservation = mRelay.reserve(room, user);
        switch (reservation.result) {
            case Result::Ok:
                respond(json_response(request, http::status::ok,
                                      json::object{{"ticket", reservation.ticket},
                                                   {"role", role_name(reservation.role)},
                                                   {"room", room},
                                                   {"name", name}}));
                break;
            case Result::Wait:
                respond(json_response(request, http::status::conflict,
                                      json::object{{"wait", true}, {"error", "the host is still loading"}}));
                break;
            case Result::RoomFull:
                respond(json_response(request, http::status::conflict,
                                      json::object{{"full", true},
                                                   {"error", "This world is full (" + std::to_string(limits::kMaxPeersPerRoom)
                                                                 + " players). Try again when someone leaves."}}));
                break;
            case Result::TooManyRooms:
                respond(error_response(request, http::status::service_unavailable,
                                       "The game server is at capacity. Try again later."));
                break;
            case Result::TooManySessions:
                respond(error_response(request, http::status::too_many_requests,
                                       "You already have the game open somewhere else. Close it and try again."));
                break;
        }
    };

    std::string mode = json_string(*body, "mode");
    if (mode == "lan") {
        if (!mConfig.allowLanTest || viaProxy || !is_local_network(remote)) {
            respond(error_response(request, http::status::forbidden, "open this activity from Discord"));
            return;
        }
        finish("lan-" + sanitize_room(json_string(*body, "room")), json_string(*body, "name"), "", std::move(respond));
        return;
    }

    if (mode != "discord" || mConfig.discordClientId.empty()) {
        respond(error_response(request, http::status::bad_request, "unsupported mode"));
        return;
    }
    std::string token = json_string(*body, "access_token");
    std::string guildId = json_string(*body, "guild_id");
    if (token.empty() || !is_snowflake(guildId)) {
        respond(error_response(request, http::status::bad_request, "launch this activity from a server"));
        return;
    }

    auto now = std::chrono::steady_clock::now();
    auto key = std::make_pair(token, guildId);
    if (auto cached = mMembers.find(key); cached != mMembers.end() && cached->second.expires > now) {
        const auto& user = cached->second.user;
        finish("g" + guildId, user.globalName.empty() ? user.username : user.globalName, user.id, std::move(respond));
        return;
    }

    struct Verified {
        std::optional<DiscordApi::User> user;
        bool member = false;
    };
    if (!reserve_discord_call(request, respond)) { return; }
    run_blocking(
        mDiscordPool,
        [this, token, guildId] {
            Verified v;
            v.user = mDiscord.get_user(token);
            v.member = v.user && mDiscord.is_guild_member(token, guildId);
            return v;
        },
        [this, request, key, finish, respond = std::move(respond)](Verified v) mutable {
            mPendingDiscordCalls--;
            const std::string& guildId = key.second;
            if (!v.user || !v.member) {
                respond(error_response(request, http::status::forbidden, "could not verify your server membership"));
                return;
            }
            remember_member(key, *v.user);
            std::string name = v.user->globalName.empty() ? v.user->username : v.user->globalName;
            std::cout << "[g" << guildId << "] session for user " << v.user->id << "\n";
            finish("g" + guildId, name, v.user->id, std::move(respond));
        });
}

void Api::handle_rom(const Request& request, const boost::asio::ip::address& remote, bool viaProxy, Respond respond) {
    if (request.method() != http::verb::post) {
        respond(error_response(request, http::status::method_not_allowed, "use POST"));
        return;
    }
    if (mConfig.romBytes.empty()) {
        respond(error_response(request, http::status::not_found, "hosted ROM is not configured"));
        return;
    }
    auto body = parse_body(request);
    if (!body) {
        respond(error_response(request, http::status::bad_request, "expected a JSON body"));
        return;
    }

    const std::string mode = json_string(*body, "mode");
    if (mode == "lan") {
        if (!mConfig.allowLanTest || viaProxy || !is_local_network(remote)) {
            respond(error_response(request, http::status::forbidden, "open this activity from Discord"));
            return;
        }
        send_rom(request, "lan:" + remote.to_string(), std::move(respond));
        return;
    }
    if (mode != "discord" || mConfig.discordClientId.empty() || mConfig.discordClientSecret.empty()) {
        respond(error_response(request, http::status::bad_request, "unsupported mode"));
        return;
    }

    std::string token = json_string(*body, "access_token");
    std::string guildId = json_string(*body, "guild_id");
    if (token.empty() || !is_snowflake(guildId)) {
        respond(error_response(request, http::status::bad_request, "launch this activity from a server"));
        return;
    }
    if (!mConfig.discordGuildIds.count(guildId)) {
        respond(error_response(request, http::status::forbidden, "this server is not enabled for hosted ROM delivery"));
        return;
    }

    auto now = std::chrono::steady_clock::now();
    auto key = std::make_pair(token, guildId);
    if (auto cached = mMembers.find(key); cached != mMembers.end() && cached->second.expires > now) {
        send_rom(request, "discord:" + guildId + ":" + cached->second.user.id, std::move(respond));
        return;
    }

    struct Verified {
        std::optional<DiscordApi::User> user;
        bool member = false;
    };
    if (!reserve_discord_call(request, respond)) { return; }
    run_blocking(
        mDiscordPool,
        [this, token, guildId] {
            Verified verified;
            verified.user = mDiscord.get_user(token);
            verified.member = verified.user && mDiscord.is_guild_member(token, guildId);
            return verified;
        },
        [this, request, key, respond = std::move(respond)](Verified verified) mutable {
            mPendingDiscordCalls--;
            if (!verified.user || !verified.member) {
                respond(error_response(request, http::status::forbidden, "could not verify your server membership"));
                return;
            }
            remember_member(key, *verified.user);
            send_rom(request, "discord:" + key.second + ":" + verified.user->id, std::move(respond));
        });
}

void Api::send_rom(const Request& request, const std::string& identity, Respond respond) {
    const auto rate = mRomDownloadRates.take(identity, limits::kRomDownloadsPerSecond, limits::kRomDownloadBurst);
    if (rate == limits::BoundedTokenBuckets::Result::RateLimited) {
        respond(error_response(request, http::status::too_many_requests, "hosted ROM download rate exceeded"));
        return;
    }
    if (rate == limits::BoundedTokenBuckets::Result::AtCapacity) {
        respond(error_response(request, http::status::service_unavailable, "hosted ROM rate-limit capacity is full; try again later"));
        return;
    }

    auto lease = mRomResponseBudget.try_acquire(mConfig.romBytes.size());
    if (!lease) {
        respond(error_response(request, http::status::service_unavailable, "hosted ROM delivery is at capacity; try again later"));
        return;
    }

    std::string bytes(reinterpret_cast<const char*>(mConfig.romBytes.data()), mConfig.romBytes.size());
    auto response = make_response(request, http::status::ok, std::move(bytes), "application/octet-stream");
    response.set(http::field::content_disposition, "attachment; filename=baserom.us.z64");
    response.set("X-Content-Type-Options", "nosniff");
    response.set("X-Robots-Tag", "noindex, nofollow");
    respond(Reply(std::move(response), std::move(lease)));
}

void Api::handle_save(const Request& request, Respond respond) {
    std::string_view target(request.target().data(), request.target().size());
    std::string ticketId = query_value(target, "ticket");
    const bool write = request.method() == http::verb::put;
    std::string room = mRelay.save_room(ticketId, write);
    if (room.empty()) {
        respond(error_response(request, http::status::forbidden, "only the host can read or write the save"));
        return;
    }

    if (request.method() == http::verb::get) {
        auto data = mSaves.load(room);
        if (!data) {
            respond(error_response(request, http::status::not_found, "no save yet"));
            return;
        }
        respond(make_response(request, http::status::ok, std::move(*data), "application/octet-stream"));
    } else if (write) {
        if (!SaveStore::is_valid(request.body())) {
            respond(error_response(request, http::status::bad_request, "not a valid save file"));
            return;
        }
        if (mUploadRates.size() > 1024) { mUploadRates.clear(); }
        auto rate = mUploadRates.try_emplace(room, limits::kSaveUploadsPerSecond, limits::kSaveUploadBurst).first;
        if (!rate->second.take()) {
            respond(error_response(request, http::status::too_many_requests, "saving too often"));
            return;
        }
        // The page numbers its uploads (seq=1, 2, ...). Two can be in flight at once (a regular one and
        // the one sent as the page closes) over different connections, so they may arrive out of
        // order; one older than what this ticket already stored is ignored.
        if (auto seqText = query_value(target, "seq"); !seqText.empty()) {
            std::uint64_t seq = 0;
            auto [end, err] = std::from_chars(seqText.data(), seqText.data() + seqText.size(), seq);
            if (err != std::errc() || end != seqText.data() + seqText.size()) {
                respond(error_response(request, http::status::bad_request, "bad seq"));
                return;
            }
            if (mUploadSeqs.size() > 4096) { mUploadSeqs.clear(); }
            auto& last = mUploadSeqs[ticketId];
            if (seq <= last) {
                respond(json_response(request, http::status::ok, json::object{{"saved", false}, {"stale", true}}));
                return;
            }
            last = seq;
        }
        // Saving syncs to disk, so keep it off the I/O thread; the save pool's single thread stores
        // uploads in the order they arrived.
        run_blocking(mSavePool, [this, room, data = request.body()] { return mSaves.store(room, data); },
                     [request, room, respond = std::move(respond)](SaveStore::Result result) {
                         if (result == SaveStore::Result::Failed) {
                             respond(error_response(request, http::status::internal_server_error, "could not save"));
                             return;
                         }
                         if (result == SaveStore::Result::Saved) { std::cout << "[" << room << "] save stored\n"; }
                         respond(json_response(request, http::status::ok, json::object{{"saved", true}}));
                     });
    } else {
        respond(error_response(request, http::status::method_not_allowed, "use GET or PUT"));
    }
}

void Api::remember_member(const std::pair<std::string, std::string>& key, const DiscordApi::User& user) {
    auto now = std::chrono::steady_clock::now();
    if (mMembers.size() >= 1024) {
        for (auto it = mMembers.begin(); it != mMembers.end();) {
            it = it->second.expires <= now ? mMembers.erase(it) : std::next(it);
        }
        if (mMembers.size() >= 1024) { mMembers.clear(); }
    }
    mMembers[key] = Member{user, now + limits::kMembershipCacheLifetime};
}
