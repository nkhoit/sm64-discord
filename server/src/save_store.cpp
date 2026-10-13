#include "save_store.hpp"

#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;

namespace {

// Layout of the EEPROM image (src/game/save_file.h): 4 save files x 2 copies of 56 bytes, then
// 2 copies of the 32-byte menu data. Each block ends with {u16 magic, u16 checksum}, big-endian
// as the game writes it (little-endian is accepted too, as the game does). The checksum is the
// sum of every byte before it. Only the first copies are checked: the game always signs them
// before writing, while the second copy of a save file can be in use without a signature.
constexpr std::size_t kSaveFileBytes = 56;
constexpr std::size_t kMenuBytes = 32;
constexpr std::size_t kNumSaveFiles = 4;
constexpr std::uint16_t kSaveFileMagic = 0x4441;
constexpr std::uint16_t kMenuMagic = 0x4849;

bool valid_block(const std::uint8_t* block, std::size_t size, std::uint16_t magic) {
    if (std::all_of(block, block + size, [](std::uint8_t b) { return b == 0; })) { return true; }
    std::uint16_t sum = 0;
    for (std::size_t i = 0; i + 2 < size; i++) { sum = static_cast<std::uint16_t>(sum + block[i]); }
    const std::uint8_t* sig = block + size - 4;
    const bool bigEndian = ((sig[0] << 8) | sig[1]) == magic && ((sig[2] << 8) | sig[3]) == sum;
    const bool littleEndian = ((sig[1] << 8) | sig[0]) == magic && ((sig[3] << 8) | sig[2]) == sum;
    return bigEndian || littleEndian;
}

// Writes `data` to `path` so that readers see either the old file or the whole new one,
// and the new one survives a crash once this returns true.
bool write_atomic(const fs::path& path, const std::string& data) {
    fs::path tmp = path;
    tmp += ".tmp";
    int fd = ::open(tmp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) { return false; }
    std::size_t written = 0;
    while (written < data.size()) {
        ssize_t n = ::write(fd, data.data() + written, data.size() - written);
        if (n < 0 && errno == EINTR) { continue; }
        if (n <= 0) { break; }
        written += static_cast<std::size_t>(n);
    }
    bool ok = written == data.size() && ::fsync(fd) == 0;
    ok = ::close(fd) == 0 && ok;
    if (!ok || ::rename(tmp.c_str(), path.c_str()) != 0) {
        std::cerr << "could not write " << path << ": " << std::strerror(errno) << "\n";
        ::unlink(tmp.c_str());
        return false;
    }
    // make the rename itself durable
    int dir = ::open(path.parent_path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dir >= 0) {
        ::fsync(dir);
        ::close(dir);
    }
    return true;
}

std::optional<std::string> read_file(const fs::path& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) { return std::nullopt; }
    return std::string(std::istreambuf_iterator<char>(in), {});
}

// "20261011T161500.123Z": sorts by time as a string; the first 8 characters are the UTC day.
std::string timestamp(std::chrono::system_clock::time_point when) {
    auto t = std::chrono::system_clock::to_time_t(when);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(when.time_since_epoch()).count() % 1000;
    std::tm tm{};
    gmtime_r(&t, &tm);
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04d%02d%02dT%02d%02d%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
    return buf;
}

} // namespace

SaveStore::SaveStore(fs::path dir) : mDir(std::move(dir)) {
    fs::create_directories(mDir);
}

bool SaveStore::is_valid(std::string_view data) {
    if (data.size() != kSaveBytes) { return false; }
    auto bytes = reinterpret_cast<const std::uint8_t*>(data.data());
    for (std::size_t file = 0; file < kNumSaveFiles; file++) {
        if (!valid_block(bytes + file * 2 * kSaveFileBytes, kSaveFileBytes, kSaveFileMagic)) { return false; }
    }
    return valid_block(bytes + kNumSaveFiles * 2 * kSaveFileBytes, kMenuBytes, kMenuMagic);
}

fs::path SaveStore::current_path(const std::string& room) const {
    // room names are already restricted to [a-z0-9-] by the API
    return mDir / (room + ".bin");
}

fs::path SaveStore::snapshot_dir(const std::string& room) const {
    return mDir / "snapshots" / room;
}

std::optional<std::string> SaveStore::load(const std::string& room) const {
    return read_file(current_path(room));
}

SaveStore::Result SaveStore::store(const std::string& room, const std::string& data) {
    if (!is_valid(data)) { return Result::Invalid; }
    std::lock_guard lock(mMutex);

    auto current = current_path(room);
    auto previous = read_file(current);
    if (previous && *previous == data) { return Result::Unchanged; }

    std::error_code ec;
    fs::create_directories(snapshot_dir(room), ec);
    // A save from before snapshots existed gets one too, dated by its file time, before it's replaced.
    if (previous && fs::is_empty(snapshot_dir(room), ec)) {
        struct stat st {};
        auto when = ::stat(current.c_str(), &st) == 0 ? std::chrono::system_clock::from_time_t(st.st_mtime)
                                                       : std::chrono::system_clock::now();
        snapshot(room, *previous, when);
    }

    if (!write_atomic(current, data)) { return Result::Failed; }
    snapshot(room, data, std::chrono::system_clock::now());
    prune_snapshots(room);
    return Result::Saved;
}

void SaveStore::snapshot(const std::string& room, const std::string& data,
                         std::chrono::system_clock::time_point when) const {
    // "<time>-00.bin"; the counter only goes up when two saves land in the same millisecond
    auto dir = snapshot_dir(room);
    auto name = timestamp(when);
    fs::path path;
    for (int i = 0; i < 100; i++) {
        char suffix[8];
        std::snprintf(suffix, sizeof(suffix), "-%02d.bin", i);
        path = dir / (name + suffix);
        if (!fs::exists(path)) { break; }
    }
    write_atomic(path, data);
}

void SaveStore::prune_snapshots(const std::string& room) const {
    std::error_code ec;
    std::vector<std::string> names;
    for (const auto& entry : fs::directory_iterator(snapshot_dir(room), ec)) {
        auto name = entry.path().filename().string();
        if (entry.is_regular_file() && name.size() > 8 && name.substr(name.size() - 4) == ".bin") { names.push_back(name); }
    }
    std::sort(names.rbegin(), names.rend()); // newest first

    // UTC days (YYYYMMDD) from kKeepDays - 1 days ago up to today keep their newest snapshot
    auto oldestDay = timestamp(std::chrono::system_clock::now() - std::chrono::hours(24 * (kKeepDays - 1))).substr(0, 8);
    std::string lastDayKept;
    for (std::size_t i = 0; i < names.size(); i++) {
        auto day = names[i].substr(0, 8);
        bool keep = i < kKeepRecent;
        if (day >= oldestDay && day != lastDayKept) {
            keep = true;
            lastDayKept = day;
        }
        if (!keep) { fs::remove(snapshot_dir(room) / names[i], ec); }
    }
}
