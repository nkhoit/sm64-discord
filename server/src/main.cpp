// sm64-relay: serves the browser build and relays co-op packets between players.
//
//   sm64-relay [--port 8080] [--www build/us_web] [--data relay-data] [--allow-lan-test]
//
// Discord sign-in is enabled by DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in the environment.
// --allow-lan-test lets browsers on the local network play without Discord; keep it off on a public VM.

#include <boost/asio.hpp>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <string_view>
#include <sys/stat.h>
#include <vector>

#include "api.hpp"
#include "config.hpp"
#include "http_session.hpp"
#include "relay.hpp"

namespace asio = boost::asio;
using tcp = asio::ip::tcp;

namespace {

void do_accept(tcp::acceptor& acceptor, Relay& relay, Api& api, const std::filesystem::path& wwwRoot) {
    acceptor.async_accept([&acceptor, &relay, &api, &wwwRoot](boost::system::error_code ec, tcp::socket socket) {
        if (!ec) { std::make_shared<HttpSession>(std::move(socket), relay, api, wwwRoot)->run(); }
        do_accept(acceptor, relay, api, wwwRoot);
    });
}

std::string env(const char* name) {
    const char* value = std::getenv(name);
    return value ? value : "";
}

constexpr std::uintmax_t kMaxHostedRomBytes = 32 * 1024 * 1024;

bool valid_snowflake(std::string_view value) {
    return !value.empty() && value.size() <= 20
        && std::all_of(value.begin(), value.end(), [](unsigned char c) { return c >= '0' && c <= '9'; });
}

bool path_is_within(const std::filesystem::path& path, const std::filesystem::path& root) {
    auto relative = path.lexically_relative(root);
    if (relative.empty()) { return path == root; }
    return *relative.begin() != "..";
}

bool configure_hosted_rom(Config& config, const std::string& guildIds, std::string& error) {
    if (!guildIds.empty()) {
        std::string_view remaining(guildIds);
        while (true) {
            auto comma = remaining.find(',');
            auto item = remaining.substr(0, comma);
            while (!item.empty() && (item.front() == ' ' || item.front() == 9)) { item.remove_prefix(1); }
            while (!item.empty() && (item.back() == ' ' || item.back() == 9)) { item.remove_suffix(1); }
            if (!valid_snowflake(item)) {
                error = "DISCORD_GUILD_IDS must be a comma-separated list of numeric Discord server IDs";
                return false;
            }
            config.discordGuildIds.emplace(item);
            if (comma == std::string_view::npos) { break; }
            remaining.remove_prefix(comma + 1);
        }
    }

    if (config.romPath.empty()) { return true; }
    if (!config.romPath.is_absolute()) {
        error = "SM64_ROM_PATH must be an absolute path";
        return false;
    }
    if (config.discordGuildIds.empty()) {
        error = "SM64_ROM_PATH requires a nonempty DISCORD_GUILD_IDS allowlist";
        return false;
    }
    const bool discordConfigured = !config.discordClientId.empty() && !config.discordClientSecret.empty();
    if (!discordConfigured && !config.allowLanTest) {
        error = "SM64_ROM_PATH requires Discord credentials or --allow-lan-test";
        return false;
    }

    std::error_code ec;
    auto rom = std::filesystem::canonical(config.romPath, ec);
    if (ec || !std::filesystem::is_regular_file(rom, ec) || ec) {
        error = "SM64_ROM_PATH must resolve to a readable regular file";
        return false;
    }
    auto www = std::filesystem::weakly_canonical(config.wwwRoot, ec);
    if (ec) {
        error = "could not resolve the --www root while configuring hosted ROM delivery";
        return false;
    }
    std::error_code configuredPathError;
    std::error_code configuredWwwError;
    auto configuredPath = std::filesystem::absolute(config.romPath, configuredPathError).lexically_normal();
    auto configuredWww = std::filesystem::absolute(config.wwwRoot, configuredWwwError).lexically_normal();
    if (configuredPathError || configuredWwwError || path_is_within(rom, www) || path_is_within(configuredPath, www)
        || path_is_within(configuredPath, configuredWww)) {
        error = "SM64_ROM_PATH must be outside the canonical --www tree";
        return false;
    }
    auto size = std::filesystem::file_size(rom, ec);
    if (ec || size == 0 || size > kMaxHostedRomBytes) {
        error = "SM64_ROM_PATH must be a nonempty file no larger than 32 MiB";
        return false;
    }
    std::ifstream input(rom, std::ios::binary);
    if (!input) {
        error = "SM64_ROM_PATH is not readable by the relay process";
        return false;
    }
    struct stat sourceIdentity {};
    if (::stat(rom.c_str(), &sourceIdentity) != 0 || !S_ISREG(sourceIdentity.st_mode)) {
        error = "could not identify the configured SM64_ROM_PATH file";
        return false;
    }
    config.romBytes.resize(static_cast<std::size_t>(size));
    input.read(reinterpret_cast<char*>(config.romBytes.data()), static_cast<std::streamsize>(size));
    if (!input || static_cast<std::uintmax_t>(input.gcount()) != size) {
        config.romBytes.clear();
        error = "could not read the complete SM64_ROM_PATH file";
        return false;
    }
    config.romPath = rom;
    config.romSourceDevice = static_cast<std::uint64_t>(sourceIdentity.st_dev);
    config.romSourceInode = static_cast<std::uint64_t>(sourceIdentity.st_ino);
    config.romSourceIdentityValid = true;
    return true;
}

} // namespace

int main(int argc, char* argv[]) {
    Config config;
    std::filesystem::path cliRomPath;
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--port" && i + 1 < argc) {
            config.port = static_cast<unsigned short>(std::atoi(argv[++i]));
        } else if (arg == "--www" && i + 1 < argc) {
            config.wwwRoot = argv[++i];
        } else if (arg == "--data" && i + 1 < argc) {
            config.dataDir = argv[++i];
        } else if (arg == "--rom" && i + 1 < argc) {
            cliRomPath = argv[++i];
        } else if (arg == "--allow-lan-test") {
            config.allowLanTest = true;
        } else {
            std::cerr << "usage: sm64-relay [--port 8080] [--www build/us_web] [--data relay-data] [--rom FILE] [--allow-lan-test]\n";
            return 1;
        }
    }
    config.discordClientId = env("DISCORD_CLIENT_ID");
    config.discordClientSecret = env("DISCORD_CLIENT_SECRET");
    config.diagnostics = env("SM64_DIAGNOSTICS") != "0";
    if (auto base = env("DISCORD_API_BASE"); !base.empty()) { config.discordApiBase = base; }
    config.romPath = env("SM64_ROM_PATH");
    if (config.romPath.empty()) { config.romPath = std::move(cliRomPath); }
    std::string configError;
    if (!configure_hosted_rom(config, env("DISCORD_GUILD_IDS"), configError)) {
        std::cerr << "configuration error: " << configError << "\n";
        return 1;
    }

    std::cout << std::unitbuf; // keep logs live when stdout is a file

    config.assetSecret = env("SM64_ASSET_SECRET");
    if (config.assetSecret.empty()) {
        auto generated = AssetAuth::random_secret();
        if (!generated) {
            std::cerr << "configuration error: could not generate an asset session secret; set SM64_ASSET_SECRET\n";
            return 1;
        }
        config.assetSecret = std::move(*generated);
        std::cout << "SM64_ASSET_SECRET is not set: using a random one, so game file sessions end when the relay restarts\n";
    } else if (config.assetSecret.size() < AssetAuth::kMinSecretLength) {
        std::cerr << "configuration error: SM64_ASSET_SECRET must be at least " << AssetAuth::kMinSecretLength << " characters\n";
        return 1;
    }

    // One thread: rooms are only touched from this io_context, so they need no locking.
    // Api runs blocking Discord calls on its own pool and posts results back here.
    asio::io_context io;
    Relay relay;
    Api api(config, relay, io.get_executor());
    tcp::acceptor acceptor(io, tcp::endpoint(tcp::v4(), config.port));
    do_accept(acceptor, relay, api, config.wwwRoot);

    asio::signal_set signals(io, SIGINT, SIGTERM);
    signals.async_wait([&io](boost::system::error_code, int) { io.stop(); });

    std::cout << "sm64-relay listening on port " << config.port << ", serving " << config.wwwRoot
              << (config.discordClientId.empty() || config.discordClientSecret.empty() ? ", Discord sign-in off" : ", Discord sign-in on")
              << (config.romBytes.empty() ? ", hosted ROM off" : ", hosted ROM on")
              << (config.allowLanTest ? ", LAN test mode ON" : "") << std::endl;
    io.run();
    return 0;
}
