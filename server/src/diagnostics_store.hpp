#pragma once

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <vector>

class DiagnosticsStore {
public:
    using Clock = std::function<std::chrono::system_clock::time_point()>;

    struct Options {
        std::size_t maxFileBytes = 8 * 1024 * 1024;
        std::size_t maxTotalBytes = 64 * 1024 * 1024;
        std::size_t maxFiles = 16;
        std::chrono::hours retention = std::chrono::hours(24 * 7);
    };

    DiagnosticsStore(std::filesystem::path dataDir, std::filesystem::path wwwRoot);
    DiagnosticsStore(std::filesystem::path dataDir, std::filesystem::path wwwRoot, Options options, Clock clock);
    ~DiagnosticsStore();

    DiagnosticsStore(const DiagnosticsStore&) = delete;
    DiagnosticsStore& operator=(const DiagnosticsStore&) = delete;

    // Called once on the diagnostics worker at startup and again before every append. False is fail-closed.
    bool initialize() noexcept;
    bool store(std::chrono::system_clock::time_point receivedAt, const std::string& sessionId,
               const std::string& room, const std::string& role, const std::string& sanitizedReportJson) noexcept;
    std::filesystem::path directory() const { return mDirectory; }

private:
    struct FileInfo {
        std::string name;
        std::uint64_t timestampMs = 0;
        std::size_t size = 0;
    };

    bool ensure_directory() noexcept;
    bool scan_and_prune(std::chrono::system_clock::time_point now, std::vector<FileInfo>& files,
                        std::size_t& totalBytes) noexcept;
    bool create_file(std::uint64_t timestampMs, std::string& name) noexcept;

    std::filesystem::path mDataDir;
    std::filesystem::path mWwwRoot;
    std::filesystem::path mDirectory;
    Options mOptions;
    Clock mClock;
    int mDirectoryFd = -1;
    bool mInitialized = false;
    std::string mActiveFile;
    std::size_t mActiveBytes = 0;
};
