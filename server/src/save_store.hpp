#pragma once

#include <chrono>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

// One save file (sm64coopdx's 512-byte EEPROM image) per room, on disk, plus rolling snapshots:
//
//   <dir>/<room>.bin                         the current save
//   <dir>/snapshots/<room>/<UTC time>-00.bin the last kKeepRecent distinct saves, plus the
//                                            newest of each of the last kKeepDays days
//
// Every file is written to a temporary name, synced and renamed, so a crash leaves either the
// old or the new version. store() may be called from any thread; load() reads without locking.
class SaveStore {
public:
    static constexpr std::size_t kSaveBytes = 512;
    static constexpr std::size_t kKeepRecent = 10;
    static constexpr int kKeepDays = 7;

    enum class Result { Saved, Unchanged, Invalid, Failed };

    explicit SaveStore(std::filesystem::path dir);

    // True if `data` could be a save the game wrote: 512 bytes, and the first copy of each save
    // file and of the menu data is either blank or has its magic number and checksum.
    static bool is_valid(std::string_view data);

    std::optional<std::string> load(const std::string& room) const;
    Result store(const std::string& room, const std::string& data);

private:
    std::filesystem::path current_path(const std::string& room) const;
    std::filesystem::path snapshot_dir(const std::string& room) const;
    void snapshot(const std::string& room, const std::string& data, std::chrono::system_clock::time_point when) const;
    void prune_snapshots(const std::string& room) const;

    std::filesystem::path mDir;
    std::mutex mMutex;
};
