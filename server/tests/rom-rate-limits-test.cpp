#include <iostream>
#include <string>

#include "limits.hpp"

int main() {
    bool passed = true;
    const auto check = [&](bool condition, const char* name) {
        if (!condition) {
            std::cerr << "FAIL: " << name << std::endl;
            passed = false;
        }
    };
    limits::BoundedTokenBuckets buckets(limits::kMaxRomRateIdentities);
    const auto take = [&](const std::string& identity) {
        return buckets.take(identity, limits::kRomDownloadsPerSecond, limits::kRomDownloadBurst);
    };

    check(take("identity-0") == limits::BoundedTokenBuckets::Result::Allowed, "initial burst token one");
    check(take("identity-0") == limits::BoundedTokenBuckets::Result::Allowed, "initial burst token two");
    check(take("identity-0") == limits::BoundedTokenBuckets::Result::RateLimited, "exhausted identity rate limits");
    for (std::size_t i = 1; i < limits::kMaxRomRateIdentities; ++i) {
        check(take("identity-" + std::to_string(i)) == limits::BoundedTokenBuckets::Result::Allowed,
              "identity accepted before the cap");
    }

    check(buckets.size() == limits::kMaxRomRateIdentities, "map reaches its configured cap");
    check(take("new-identity") == limits::BoundedTokenBuckets::Result::AtCapacity, "new identity fails closed at capacity");
    check(buckets.size() == limits::kMaxRomRateIdentities, "map remains bounded at capacity");
    check(take("identity-0") == limits::BoundedTokenBuckets::Result::RateLimited,
          "exhausted original identity retains its 429 state after the cap");

    if (!passed) { return 1; }
    std::cout << "PASS: full ROM rate bucket map stays bounded and preserves exhausted identity state" << std::endl;
}
