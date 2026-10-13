#pragma once

#include <cstddef>
#include <memory>
#include <utility>

#include "limits.hpp"

// Event-loop-owned budget for copied hosted-ROM response bodies. A lease travels with the response
// until Beast finishes, times out, or cancels its async write; destroying any abandoned reply also
// releases it. This class is intentionally single-executor, like Api's other mutable state.
class HostedRomDownloadBudget {
    struct State {
        std::size_t maxBytes;
        std::size_t maxDownloads;
        std::size_t inFlightBytes = 0;
        std::size_t inFlightDownloads = 0;
    };

public:
    class Lease {
    public:
        ~Lease() {
            if (mActive) {
                mState->inFlightBytes -= mBytes;
                mState->inFlightDownloads--;
            }
        }

        Lease(const Lease&) = delete;
        Lease& operator=(const Lease&) = delete;

    private:
        friend class HostedRomDownloadBudget;
        Lease(std::shared_ptr<State> state, std::size_t bytes) : mState(std::move(state)), mBytes(bytes) {}
        void activate() { mActive = true; }

        std::shared_ptr<State> mState;
        std::size_t mBytes;
        bool mActive = false;
    };

    using LeasePtr = std::shared_ptr<Lease>;

    explicit HostedRomDownloadBudget(std::size_t maxBytes = limits::kMaxHostedRomInFlightBytes,
                                     std::size_t maxDownloads = limits::kMaxHostedRomInFlightDownloads)
        : mState(std::make_shared<State>(State{maxBytes, maxDownloads})) {}

    LeasePtr try_acquire(std::size_t bytes) {
        if (bytes == 0 || bytes > mState->maxBytes || mState->inFlightDownloads >= mState->maxDownloads
            || bytes > mState->maxBytes - mState->inFlightBytes) {
            return {};
        }
        auto lease = LeasePtr(new Lease(mState, bytes));
        mState->inFlightBytes += bytes;
        mState->inFlightDownloads++;
        lease->activate();
        return lease;
    }

private:
    std::shared_ptr<State> mState;
};
