// AssetAuth: issued sessions last 30-90 minutes, are the same within an hour, and fail closed.
#include <cstdio>
#include <string>

#include "asset_auth.hpp"

static int failures = 0;
static void check(const char* name, bool ok) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", name);
    if (!ok) { failures++; }
}

int main() {
    const AssetAuth auth("unit-test-secret-unit-test-secret-0000");
    const AssetAuth other("another-secret-another-secret-000000");
    const std::int64_t hour = 1'800'000'000 / 3600 * 3600;
    bool lifetimes = true, verifies = true, expires = true;
    for (std::int64_t now = hour; now < hour + 2 * 3600; now += 7) {
        const auto issued = auth.issue(now);
        const auto lifetime = issued.expires - now;
        lifetimes &= lifetime >= AssetAuth::kMinLifetimeSeconds && lifetime <= AssetAuth::kMaxLifetimeSeconds;
        verifies &= auth.verify(issued.token, now) == AssetAuth::Check::Ok
                 && auth.verify(issued.token, issued.expires - 1) == AssetAuth::Check::Ok;
        expires &= auth.verify(issued.token, issued.expires) == AssetAuth::Check::Expired;
    }
    check("every issued session lasts 30-90 minutes", lifetimes);
    check("...and verifies until it expires", verifies);
    check("...then reports Expired", expires);
    check("sessions issued in the same half hour are identical", auth.issue(hour + 10).token == auth.issue(hour + 1700).token);
    const auto token = auth.issue(hour).token;
    check("another secret's verifier rejects it", other.verify(token, hour) == AssetAuth::Check::Invalid);
    std::string tampered = token;
    tampered.back() = tampered.back() == '0' ? '1' : '0';
    check("a tampered signature is Invalid", auth.verify(tampered, hour) == AssetAuth::Check::Invalid);
    check("a tampered expiry is Invalid", auth.verify("9" + token, hour) == AssetAuth::Check::Invalid);
    check("an empty session is Missing", auth.verify("", hour) == AssetAuth::Check::Missing);
    for (const char* junk : {".", "abc", "123", "123.", ".abc", "-5.abc", "12345678901234567890.ab"}) {
        if (auth.verify(junk, hour) != AssetAuth::Check::Invalid) { check(junk, false); }
    }
    check("malformed sessions are Invalid", true);
    check("random secrets are 64 hex characters", AssetAuth::random_secret().value_or("").size() == 64);
    std::printf(failures ? "FAILED %d\n" : "PASS: asset auth\n", failures);
    return failures ? 1 : 0;
}
