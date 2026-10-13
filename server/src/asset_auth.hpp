#pragma once

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <charconv>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

// Short-lived sessions for the engine files (everything under --www except the public bootstrap).
// After the page proves Discord membership (POST /api/assets), it gets a token "<expiry>.<hmac>" and
// adds it to the engine file URLs as ?s=. The token names no one; it only says "this relay let
// someone in until <expiry>", so it's checked without any server-side state.
//
// Expiry is rounded up to the end of the current hour (at least half an hour away), so every
// session in the same hour gets the same URLs and the browser's private cache keeps working.
class AssetAuth {
public:
    static constexpr std::int64_t kWindowSeconds = 3600;
    static constexpr std::int64_t kMinLifetimeSeconds = 1800;
    // A valid signature never names an expiry further away than this.
    static constexpr std::int64_t kMaxLifetimeSeconds = kWindowSeconds + kMinLifetimeSeconds;
    static constexpr std::size_t kMinSecretLength = 32;

    enum class Check { Ok, Missing, Invalid, Expired };
    struct Issued {
        std::string token;
        std::int64_t expires;
    };

    explicit AssetAuth(std::string secret) : mSecret(std::move(secret)) {}

    Issued issue(std::int64_t now) const {
        std::int64_t expires = (now / kWindowSeconds + 1) * kWindowSeconds;
        if (expires - now < kMinLifetimeSeconds) { expires += kWindowSeconds; }
        return {std::to_string(expires) + "." + sign(expires), expires};
    }

    Check verify(std::string_view token, std::int64_t now) const {
        if (token.empty()) { return Check::Missing; }
        const auto dot = token.find('.');
        if (dot == std::string_view::npos || dot == 0 || dot > 12) { return Check::Invalid; }
        std::int64_t expires = 0;
        const auto [end, err] = std::from_chars(token.data(), token.data() + dot, expires);
        if (err != std::errc() || end != token.data() + dot) { return Check::Invalid; }
        const std::string expected = sign(expires);
        const std::string_view signature = token.substr(dot + 1);
        if (signature.size() != expected.size() || CRYPTO_memcmp(signature.data(), expected.data(), expected.size()) != 0) {
            return Check::Invalid;
        }
        if (expires <= now) { return Check::Expired; }
        if (expires > now + kMaxLifetimeSeconds) { return Check::Invalid; }
        return Check::Ok;
    }

    // 32 random bytes as hex, or nullopt if the system has no randomness to give.
    static std::optional<std::string> random_secret() {
        unsigned char bytes[32];
        if (RAND_bytes(bytes, sizeof(bytes)) != 1) { return std::nullopt; }
        return hex(bytes, sizeof(bytes));
    }

private:
    static std::string hex(const unsigned char* data, std::size_t size) {
        static constexpr char digits[] = "0123456789abcdef";
        std::string out;
        out.reserve(size * 2);
        for (std::size_t i = 0; i < size; ++i) {
            out.push_back(digits[data[i] >> 4]);
            out.push_back(digits[data[i] & 0x0f]);
        }
        return out;
    }

    std::string sign(std::int64_t expires) const {
        const std::string message = "sm64-assets:v1:" + std::to_string(expires);
        unsigned char mac[EVP_MAX_MD_SIZE];
        unsigned int length = 0;
        HMAC(EVP_sha256(), mSecret.data(), static_cast<int>(mSecret.size()),
             reinterpret_cast<const unsigned char*>(message.data()), message.size(), mac, &length);
        return hex(mac, length);
    }

    std::string mSecret;
};
