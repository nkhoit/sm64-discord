#pragma once

#include <cstddef>

class DiagnosticsPendingLimit {
public:
    explicit DiagnosticsPendingLimit(std::size_t maximum = 32) : mMaximum(maximum) {}

    bool try_reserve() noexcept {
        if (mPending >= mMaximum) { return false; }
        ++mPending;
        return true;
    }

    void release() noexcept {
        if (mPending > 0) { --mPending; }
    }

    std::size_t pending() const noexcept { return mPending; }
    std::size_t maximum() const noexcept { return mMaximum; }

private:
    const std::size_t mMaximum;
    std::size_t mPending = 0;
};
