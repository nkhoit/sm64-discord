#pragma once

#include <cstdint>
#include <filesystem>
#include <set>
#include <string>
#include <vector>

struct Config {
    unsigned short port = 8080;
    std::filesystem::path wwwRoot = "build/us_web";
    std::filesystem::path dataDir = "relay-data";
    std::filesystem::path romPath;
    std::vector<std::uint8_t> romBytes;
    std::uint64_t romSourceDevice = 0;
    std::uint64_t romSourceInode = 0;
    bool romSourceIdentityValid = false;
    std::set<std::string> discordGuildIds;

    // Discord application credentials (from the Developer Portal). Without them,
    // only the local-network test mode can create sessions.
    std::string discordClientId;
    std::string discordClientSecret;
    std::string discordApiBase = "https://discord.com";
    // Signs the short-lived sessions for the engine files (SM64_ASSET_SECRET, or random per start).
    std::string assetSecret;

    // Lets browsers on the local network play without Discord, for testing.
    // Refused for any request that came through a reverse proxy.
    bool allowLanTest = false;
    // Diagnostics ingestion is enabled by default and can be disabled with SM64_DIAGNOSTICS=0.
    bool diagnostics = true;
};
