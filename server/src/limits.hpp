#pragma once

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <map>
#include <string>

// Limits that keep one room, player or misbehaving page from hurting everyone else.
// Nothing here is keyed on IP addresses: behind Discord's proxy or a tunnel every player
// shares the proxy's address, and the headers that carry the real one can be forged.
namespace limits {

// sm64coopdx's MAX_PLAYERS, host included.
constexpr std::size_t kMaxPeersPerRoom = 16;
// Rooms that exist at once (each is one Discord server playing, or loading).
constexpr std::size_t kMaxRooms = 64;
// Tickets plus open connections per Discord account. More than one allows a quick reload
// while the old connection is still closing.
constexpr std::size_t kMaxSessionsPerUser = 3;
// Discord API calls (sign-in, membership checks) waiting or running at once.
constexpr std::size_t kMaxPendingDiscordCalls = 32;
// How long a verified (token, server) pair is trusted before asking Discord again. Players
// waiting for a host poll /api/session every 2 seconds.
constexpr auto kMembershipCacheLifetime = std::chrono::minutes(5);

// One WebSocket message is [u32 peer][packet], and sm64coopdx packets are at most 3000 bytes.
constexpr std::size_t kMaxMessageBytes = 4096;
// Messages per second a peer may send, as token buckets (sustained rate, burst). Messages over the
// rate are dropped. A client that keeps flooding is disconnected; the host never is, since that
// would end the room for everyone.
//
// A client sends its own state (30/s while moving) plus acks and object updates, and bursts when
// joining. The web build sends one message per packet per recipient, and the host relays every
// player's state to every other player, so the host sends about 30 * (N - 1)^2 messages per second
// for player state alone while everyone moves: ~1,500 with 8 players, ~6,750 with 16. Its
// allowance therefore grows with the number of connected clients: 22,500/s with 15.
constexpr double kClientMessagesPerSecond = 300;
constexpr double kClientMessageBurst = 2000;
constexpr double kHostMessagesPerSecondPerClient = 1500;
constexpr double kHostMessageBurstPerClient = 6000;
// How often a peer that is over its rate is logged, with the number of messages dropped.
constexpr auto kDropLogInterval = std::chrono::seconds(10);
// Messages waiting to be sent to one peer. A peer that can't keep up is disconnected
// rather than letting its queue grow without bound.
constexpr std::size_t kMaxQueuedBytes = 4 * 1024 * 1024;

// A quiet connection gets a ping after half of this, and is closed if nothing at all (not even
// the pong) arrives within it. Cloudflare drops connections idle for ~100 s.
constexpr auto kWsIdleTimeout = std::chrono::seconds(30);

// Save uploads per room, as a token bucket. The page uploads within a second or two of a change.
constexpr double kSaveUploadsPerSecond = 0.5;
constexpr double kSaveUploadBurst = 10;

// A verified Discord user can fetch the hosted ROM twice at once, then once every 2 seconds.
// The bounded identity map preserves existing buckets and rejects new identities at capacity.
constexpr double kRomDownloadsPerSecond = 0.5;
constexpr double kRomDownloadBurst = 2;
constexpr std::size_t kMaxRomRateIdentities = 1024;

// One configured ROM can be at most 32 MiB. Bound response copies across slow readers and keep
// a finite deadline on every HTTP response write so abandoned transfers release their lease.
constexpr std::size_t kMaxHostedRomInFlightBytes = 64 * 1024 * 1024;
constexpr std::size_t kMaxHostedRomInFlightDownloads = 4;
constexpr auto kHttpResponseWriteTimeout = std::chrono::seconds(30);

// Allows `rate` events per second on average and up to `burst` at once.
class TokenBucket {
public:
    TokenBucket(double rate, double burst) : mRate(rate), mBurst(burst), mTokens(burst) {}

    // Changes the limits from now on. A bigger burst is available at once (a host gets one when a
    // client joins, which is when it sends the most); a smaller one caps the tokens saved up.
    void set_limits(double rate, double burst) {
        take_refill();
        mTokens = std::min(burst, mTokens + std::max(0.0, burst - mBurst));
        mRate = rate;
        mBurst = burst;
    }

    bool take() {
        take_refill();
        if (mTokens < 1) { return false; }
        mTokens -= 1;
        return true;
    }

private:
    void take_refill() {
        auto now = std::chrono::steady_clock::now();
        mTokens = std::min(mBurst, mTokens + std::chrono::duration<double>(now - mLast).count() * mRate);
        mLast = now;
    }

    double mRate;
    double mBurst;
    double mTokens;
    std::chrono::steady_clock::time_point mLast = std::chrono::steady_clock::now();
};

// Never reset active identities when the map reaches its cap: callers can distinguish an exhausted
// identity from a new identity rejected fail-closed at capacity.
class BoundedTokenBuckets {
public:
    enum class Result { Allowed, RateLimited, AtCapacity };

    explicit BoundedTokenBuckets(std::size_t maxEntries = kMaxRomRateIdentities) : mMaxEntries(maxEntries) {}

    Result take(const std::string& identity, double rate, double burst) {
        auto bucket = mBuckets.find(identity);
        if (bucket == mBuckets.end()) {
            if (mBuckets.size() >= mMaxEntries) { return Result::AtCapacity; }
            bucket = mBuckets.try_emplace(identity, rate, burst).first;
        }
        return bucket->second.take() ? Result::Allowed : Result::RateLimited;
    }

    std::size_t size() const { return mBuckets.size(); }

private:
    const std::size_t mMaxEntries;
    std::map<std::string, TokenBucket> mBuckets;
};

} // namespace limits
