#include "diagnostics_store.hpp"

#include <boost/json.hpp>
#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <limits>
#include <random>
#include <string_view>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <vector>

namespace fs = std::filesystem;
namespace json = boost::json;

namespace {

constexpr std::string_view kPrefix = "diagnostics-";
constexpr std::string_view kSuffix = ".jsonl";

bool path_is_within(const fs::path& path, const fs::path& root) {
    const auto relative = path.lexically_relative(root);
    return relative.empty() ? path == root : *relative.begin() != "..";
}

bool parse_filename(std::string_view name, std::uint64_t& timestampMs) {
    if (name.size() <= kPrefix.size() + kSuffix.size() + 1 || name.substr(0, kPrefix.size()) != kPrefix
        || name.substr(name.size() - kSuffix.size()) != kSuffix) {
        return false;
    }
    const auto randomSeparator = name.rfind('-', name.size() - kSuffix.size() - 1);
    if (randomSeparator == std::string_view::npos || randomSeparator <= kPrefix.size()) { return false; }
    const auto timestamp = name.substr(kPrefix.size(), randomSeparator - kPrefix.size());
    const auto random = name.substr(randomSeparator + 1, name.size() - kSuffix.size() - randomSeparator - 1);
    if (timestamp.empty() || timestamp.size() > 20 || random.size() != 16) { return false; }
    for (char c : timestamp) {
        if (c < '0' || c > '9') { return false; }
    }
    for (char c : random) {
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) { return false; }
    }
    const auto [end, error] = std::from_chars(timestamp.data(), timestamp.data() + timestamp.size(), timestampMs);
    return error == std::errc() && end == timestamp.data() + timestamp.size();
}

std::uint64_t epoch_milliseconds(std::chrono::system_clock::time_point point) {
    const auto value = std::chrono::duration_cast<std::chrono::milliseconds>(point.time_since_epoch()).count();
    return value < 0 ? 0 : static_cast<std::uint64_t>(value);
}

std::string format_utc(std::chrono::system_clock::time_point point) {
    const auto milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(point.time_since_epoch());
    auto seconds = std::chrono::duration_cast<std::chrono::seconds>(milliseconds);
    auto remainder = milliseconds - seconds;
    if (remainder.count() < 0) {
        seconds -= std::chrono::seconds(1);
        remainder += std::chrono::seconds(1);
    }
    const std::time_t raw = static_cast<std::time_t>(seconds.count());
    std::tm utc{};
    if (!gmtime_r(&raw, &utc)) { return {}; }
    char buffer[40]{};
    if (std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%S", &utc) == 0) { return {}; }
    char result[48]{};
    std::snprintf(result, sizeof(result), "%s.%03lldZ", buffer, static_cast<long long>(remainder.count()));
    return result;
}

bool random_suffix(std::string& out) {
    static constexpr char hex[] = "0123456789abcdef";
    try {
        std::random_device device;
        out.clear();
        out.reserve(16);
        for (int i = 0; i < 2; ++i) {
            const std::uint32_t bits = device();
            for (int j = 0; j < 8; ++j) { out.push_back(hex[(bits >> (j * 4)) & 0x0f]); }
        }
        return true;
    } catch (...) {
        return false;
    }
}

bool write_all(int fd, const char* data, std::size_t length) {
    while (length > 0) {
        const ssize_t written = ::write(fd, data, length);
        if (written < 0 && errno == EINTR) { continue; }
        if (written <= 0) { return false; }
        data += written;
        length -= static_cast<std::size_t>(written);
    }
    return true;
}

} // namespace

DiagnosticsStore::DiagnosticsStore(fs::path dataDir, fs::path wwwRoot)
    : DiagnosticsStore(std::move(dataDir), std::move(wwwRoot), Options{}, [] { return std::chrono::system_clock::now(); }) {}

DiagnosticsStore::DiagnosticsStore(fs::path dataDir, fs::path wwwRoot, Options options, Clock clock)
    : mDataDir(std::move(dataDir)), mWwwRoot(std::move(wwwRoot)), mDirectory(mDataDir / "diagnostics"),
      mOptions(options), mClock(std::move(clock)) {}

DiagnosticsStore::~DiagnosticsStore() {
    if (mDirectoryFd >= 0) { ::close(mDirectoryFd); }
}

bool DiagnosticsStore::ensure_directory() noexcept {
    try {
        if (mOptions.maxFileBytes == 0 || mOptions.maxTotalBytes == 0 || mOptions.maxFiles == 0
            || mOptions.retention <= std::chrono::hours::zero() || !mClock) {
            return false;
        }
        std::error_code ec;
        const fs::path prospectiveDirectory = fs::weakly_canonical(mDirectory, ec);
        if (ec) { return false; }
        ec.clear();
        const fs::path canonicalWww = fs::weakly_canonical(mWwwRoot, ec);
        if (ec || path_is_within(prospectiveDirectory, canonicalWww)) { return false; }
        ec.clear();
        fs::create_directories(mDataDir, ec);
        if (ec) { return false; }
        struct stat dataStat {};
        if (::lstat(mDataDir.c_str(), &dataStat) != 0 || !S_ISDIR(dataStat.st_mode) || S_ISLNK(dataStat.st_mode)
            || dataStat.st_uid != ::geteuid()) {
            return false;
        }
        if (::mkdir(mDirectory.c_str(), 0700) != 0 && errno != EEXIST) { return false; }
        struct stat directoryStat {};
        if (::lstat(mDirectory.c_str(), &directoryStat) != 0 || !S_ISDIR(directoryStat.st_mode)
            || S_ISLNK(directoryStat.st_mode) || directoryStat.st_uid != ::geteuid()) {
            return false;
        }
        if (::chmod(mDirectory.c_str(), 0700) != 0) { return false; }

        const fs::path canonicalDirectory = fs::canonical(mDirectory, ec);
        if (ec || path_is_within(canonicalDirectory, canonicalWww)) { return false; }
        if (mDirectoryFd < 0) {
            mDirectoryFd = ::open(mDirectory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            if (mDirectoryFd < 0) { return false; }
        }
        if (::fstat(mDirectoryFd, &directoryStat) != 0 || !S_ISDIR(directoryStat.st_mode)
            || directoryStat.st_uid != ::geteuid() || (directoryStat.st_mode & 0777) != 0700) {
            return false;
        }
        return true;
    } catch (...) {
        return false;
    }
}

bool DiagnosticsStore::scan_and_prune(std::chrono::system_clock::time_point now, std::vector<FileInfo>& files,
                                      std::size_t& totalBytes) noexcept {
    files.clear();
    totalBytes = 0;
    if (mDirectoryFd < 0) { return false; }
    struct stat directoryStat {};
    if (::fstat(mDirectoryFd, &directoryStat) != 0 || !S_ISDIR(directoryStat.st_mode)
        || directoryStat.st_uid != ::geteuid()) {
        return false;
    }
    if ((directoryStat.st_mode & 0777) != 0700) {
        if (::fchmod(mDirectoryFd, 0700) != 0 || ::fstat(mDirectoryFd, &directoryStat) != 0
            || (directoryStat.st_mode & 0777) != 0700) {
            return false;
        }
    }
    const int scanFd = ::openat(mDirectoryFd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (scanFd < 0) { return false; }
    DIR* directory = ::fdopendir(scanFd);
    if (!directory) { ::close(scanFd); return false; }

    bool ok = true;
    bool removedExpired = false;
    const std::uint64_t nowMs = epoch_milliseconds(now);
    const auto retentionCount = std::chrono::duration_cast<std::chrono::milliseconds>(mOptions.retention).count();
    const std::uint64_t retentionMs = retentionCount < 0 ? 0 : static_cast<std::uint64_t>(retentionCount);
    while (true) {
        errno = 0;
        dirent* entry = ::readdir(directory);
        if (!entry) {
            if (errno != 0) { ok = false; }
            break;
        }
        const std::string_view name(entry->d_name);
        if (name == "." || name == "..") { continue; }
        std::uint64_t timestampMs = 0;
        if (!parse_filename(name, timestampMs) || files.size() >= mOptions.maxFiles) { ok = false; break; }
        struct stat st {};
        if (::fstatat(mDirectoryFd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(st.st_mode)
            || S_ISLNK(st.st_mode) || st.st_nlink != 1 || st.st_uid != ::geteuid() || st.st_size < 0) {
            ok = false;
            break;
        }
        const std::size_t size = static_cast<std::size_t>(st.st_size);
        if (size > mOptions.maxFileBytes || timestampMs > nowMs) { ok = false; break; }
        const bool expired = nowMs - timestampMs > retentionMs;
        if (expired) {
            if (::unlinkat(mDirectoryFd, entry->d_name, 0) != 0) { ok = false; break; }
            removedExpired = true;
            if (mActiveFile == entry->d_name) { mActiveFile.clear(); mActiveBytes = 0; }
            continue;
        }
        const int fileFd = ::openat(mDirectoryFd, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
        if (fileFd < 0) { ok = false; break; }
        struct stat openedStat {};
        const bool safeFile = ::fstat(fileFd, &openedStat) == 0 && S_ISREG(openedStat.st_mode)
            && openedStat.st_nlink == 1 && openedStat.st_uid == ::geteuid()
            && openedStat.st_dev == st.st_dev && openedStat.st_ino == st.st_ino && openedStat.st_size >= 0
            && static_cast<std::size_t>(openedStat.st_size) == size && ::fchmod(fileFd, 0600) == 0;
        ::close(fileFd);
        if (!safeFile) { ok = false; break; }
        if (size > mOptions.maxTotalBytes - std::min(totalBytes, mOptions.maxTotalBytes)) { ok = false; break; }
        totalBytes += size;
        files.push_back(FileInfo{std::string(name), timestampMs, size});
    }
    ::closedir(directory);
    if (ok && removedExpired && ::fsync(mDirectoryFd) != 0) { ok = false; }
    if (!ok || files.size() > mOptions.maxFiles || totalBytes > mOptions.maxTotalBytes) { return false; }
    std::sort(files.begin(), files.end(), [](const FileInfo& a, const FileInfo& b) {
        return a.timestampMs == b.timestampMs ? a.name < b.name : a.timestampMs < b.timestampMs;
    });
    if (!mActiveFile.empty()) {
        const auto active = std::find_if(files.begin(), files.end(), [&](const FileInfo& file) { return file.name == mActiveFile; });
        if (active == files.end()) { mActiveFile.clear(); mActiveBytes = 0; }
        else { mActiveBytes = active->size; }
    }
    return true;
}

bool DiagnosticsStore::initialize() noexcept {
    try {
        if (!ensure_directory()) { return false; }
        std::vector<FileInfo> files;
        std::size_t totalBytes = 0;
        if (!scan_and_prune(mClock(), files, totalBytes)) { return false; }
        mInitialized = true;
        return true;
    } catch (...) {
        return false;
    }
}

bool DiagnosticsStore::create_file(std::uint64_t timestampMs, std::string& name) noexcept {
    try {
        for (int attempt = 0; attempt < 8; ++attempt) {
            std::string random;
            if (!random_suffix(random)) { return false; }
            name = std::string(kPrefix) + std::to_string(timestampMs) + "-" + random + std::string(kSuffix);
            const int fd = ::openat(mDirectoryFd, name.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
            if (fd < 0) {
                if (errno == EEXIST) { continue; }
                return false;
            }
            struct stat st {};
            const bool safe = ::fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_nlink == 1
                && st.st_uid == ::geteuid() && ::fchmod(fd, 0600) == 0;
            const bool synced = safe && ::fsync(fd) == 0 && ::fsync(mDirectoryFd) == 0;
            const int closeResult = ::close(fd);
            if (!synced || closeResult != 0) {
                ::unlinkat(mDirectoryFd, name.c_str(), 0);
                return false;
            }
            mActiveFile = name;
            mActiveBytes = 0;
            return true;
        }
    } catch (...) {
        return false;
    }
    return false;
}

bool DiagnosticsStore::store(std::chrono::system_clock::time_point receivedAt, const std::string& sessionId,
                             const std::string& room, const std::string& role,
                             const std::string& sanitizedReportJson) noexcept {
    try {
        if (!mInitialized && !initialize()) { return false; }
        boost::system::error_code parseError;
        json::value report = json::parse(sanitizedReportJson, parseError);
        if (parseError || !report.is_object() || report.as_object().if_contains("ticket")) { return false; }
        const std::string timestamp = format_utc(receivedAt);
        if (timestamp.empty()) { return false; }
        json::object row{{"receivedAt", timestamp}, {"sessionId", sessionId}, {"room", room}, {"role", role},
                         {"report", std::move(report)}};
        std::string line = json::serialize(row);
        line.push_back('\n');
        if (line.size() > mOptions.maxFileBytes) { return false; }

        const auto now = mClock();
        std::vector<FileInfo> files;
        std::size_t totalBytes = 0;
        if (!scan_and_prune(now, files, totalBytes)) { return false; }
        if (line.size() > mOptions.maxTotalBytes || totalBytes > mOptions.maxTotalBytes - line.size()) { return false; }

        if (mActiveFile.empty() && !files.empty()) {
            mActiveFile = files.back().name;
            mActiveBytes = files.back().size;
        }
        const bool rotate = mActiveFile.empty() || mActiveBytes > mOptions.maxFileBytes - line.size();
        if (rotate) {
            if (files.size() >= mOptions.maxFiles || !create_file(epoch_milliseconds(now), mActiveFile)) { return false; }
        }

        const int fd = ::openat(mDirectoryFd, mActiveFile.c_str(), O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW);
        if (fd < 0) { return false; }
        struct stat st {};
        const bool safeFile = ::fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_nlink == 1
            && st.st_uid == ::geteuid() && st.st_size >= 0 && static_cast<std::size_t>(st.st_size) == mActiveBytes
            && ::fchmod(fd, 0600) == 0;
        const off_t originalSize = st.st_size;
        const bool written = safeFile && write_all(fd, line.data(), line.size()) && ::fsync(fd) == 0;
        if (!written && safeFile) {
            const int truncateResult = ::ftruncate(fd, originalSize);
            const int rollbackSyncResult = truncateResult == 0 ? ::fsync(fd) : -1;
            (void)truncateResult;
            (void)rollbackSyncResult;
        }
        const int closeResult = ::close(fd);
        if (!written || closeResult != 0) { return false; }
        mActiveBytes += line.size();
        return true;
    } catch (...) {
        return false;
    }
}
