#pragma once

#include <boost/asio/any_io_executor.hpp>
#include <boost/asio/ip/address.hpp>
#include <boost/asio/thread_pool.hpp>
#include <boost/beast/http.hpp>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <utility>

#include "asset_auth.hpp"
#include "config.hpp"
#include "diagnostics_limits.hpp"
#include "diagnostics_store.hpp"
#include "discord_api.hpp"
#include "hosted_rom_download_budget.hpp"
#include "limits.hpp"
#include "relay.hpp"
#include "save_store.hpp"

// The page's HTTP API:
//   GET  /api/config               which modes the server supports, and the Discord client id
//   POST /api/token   {code}       Discord OAuth2 code -> access token
//   POST /api/assets {mode,...}    a short-lived session for the engine files (see AssetAuth)
//   POST /api/session {mode,...}   a ticket for /ws, plus whether to host or join
//   POST /api/diagnostics           authenticated, bounded technical report ingestion
//   GET  /api/save?ticket=         the room's save (host only)
//   PUT  /api/save?ticket=         replace the room's save (host only)
class Api {
public:
    using Request = boost::beast::http::request<boost::beast::http::string_body>;
    using Response = boost::beast::http::response<boost::beast::http::string_body>;
    struct Reply {
        Response response;
        std::shared_ptr<void> lifetime;

        Reply(Response value, std::shared_ptr<void> keepAlive = {})
            : response(std::move(value)), lifetime(std::move(keepAlive)) {}
    };
    using Respond = std::function<void(Reply)>;

    Api(const Config& config, Relay& relay, boost::asio::any_io_executor ioExecutor);
    ~Api();

    // `respond` is always called on the I/O executor.
    void handle(const Request& request, const boost::asio::ip::address& remote, bool viaProxy, Respond respond);
    const AssetAuth& asset_auth() const noexcept { return mAssetAuth; }
    bool is_hosted_rom_file(std::uint64_t device, std::uint64_t inode) const noexcept {
        return mConfig.romSourceIdentityValid && mConfig.romSourceDevice == device && mConfig.romSourceInode == inode;
    }

private:
    void handle_token(const Request& request, Respond respond);
    void handle_session(const Request& request, const boost::asio::ip::address& remote, bool viaProxy, Respond respond);
    void handle_assets(const Request& request, const boost::asio::ip::address& remote, bool viaProxy, Respond respond);
    void send_asset_session(const Request& request, Respond respond);
    void handle_save(const Request& request, Respond respond);
    void handle_diagnostics(const Request& request, const boost::asio::ip::address& remote, bool viaProxy, Respond respond);
    void handle_rom(const Request& request, const boost::asio::ip::address& remote, bool viaProxy, Respond respond);
    void send_rom(const Request& request, const std::string& identity, Respond respond);
    // Runs `work` on `pool`, then `done` with its result on the I/O executor.
    template <typename Work, typename Done> void run_blocking(boost::asio::thread_pool& pool, Work work, Done done);
    // False (and answers 503) when too many Discord calls are already waiting.
    bool reserve_discord_call(const Request& request, Respond& respond);
    enum class DiagnosticTicketResult { Allowed, RateLimited, AtCapacity, Failed };
    DiagnosticTicketResult take_diagnostic_token(const std::string& ticket, std::string& sessionId);

    struct Member {
        DiscordApi::User user;
        std::chrono::steady_clock::time_point expires;
    };
    struct DiagnosticTicketState {
        std::string sessionId;
        double tokens = 4;
        std::chrono::steady_clock::time_point refilledAt = std::chrono::steady_clock::now();
    };
    void remember_member(const std::pair<std::string, std::string>& key, const DiscordApi::User& user);

    const Config& mConfig;
    Relay& mRelay;
    AssetAuth mAssetAuth;
    DiscordApi mDiscord;
    SaveStore mSaves;
    DiagnosticsStore mDiagnosticsStore;
    boost::asio::any_io_executor mIo;
    // Blocking Discord API calls.
    boost::asio::thread_pool mDiscordPool{4};
    // Save writes, one at a time in the order they arrived, so an older upload can't land last, and
    // a slow Discord API can't hold them up.
    boost::asio::thread_pool mSavePool{1};
    // Diagnostic persistence is isolated from room I/O and ordered on its own single worker.
    boost::asio::thread_pool mDiagnosticsPool{1};
    DiagnosticsPendingLimit mPendingDiagnostics{32};
    bool mDiagnosticsReady = false;
    std::map<std::string, DiagnosticTicketState> mDiagnosticTickets;
    std::size_t mPendingDiscordCalls = 0;
    // (access token, guild id) -> who that is, for tokens Discord confirmed are in that server.
    std::map<std::pair<std::string, std::string>, Member> mMembers;
    // room -> save uploads allowed
    std::map<std::string, limits::TokenBucket> mUploadRates;
    // ticket -> the highest upload sequence number stored for it (see handle_save)
    std::map<std::string, std::uint64_t> mUploadSeqs;
    // identity -> hosted ROM download rate bucket; reaching the cap rejects only new identities.
    limits::BoundedTokenBuckets mRomDownloadRates;
    HostedRomDownloadBudget mRomResponseBudget;
};
