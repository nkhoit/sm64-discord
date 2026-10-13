#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include "diagnostics_store.hpp"

namespace fs = std::filesystem;

int main() {
    const fs::path root = fs::temp_directory_path() / ("sm64-diagnostics-store-" + std::to_string(::getpid()));
    const fs::path www = root / "www";
    const fs::path data = root / "data";
    std::error_code ec;
    fs::remove_all(root, ec);
    fs::create_directories(www);

    bool passed = true;
    auto check = [&](bool ok, const char* name) {
        std::cout << (ok ? "ok  " : "FAIL") << " " << name << '\n';
        passed = passed && ok;
    };

    using Clock = std::chrono::system_clock;
    auto now = Clock::time_point(std::chrono::milliseconds(1'800'000'000'000LL));
    DiagnosticsStore::Options limits;
    limits.maxFileBytes = 256;
    limits.maxTotalBytes = 450;
    limits.maxFiles = 8;
    limits.retention = std::chrono::hours(24 * 7);
    DiagnosticsStore store(data, www, limits, [&] { return now; });
    check(store.initialize(), "owner-only diagnostics directory initializes outside the static root");
    struct stat directoryStat {};
    check(::stat((data / "diagnostics").c_str(), &directoryStat) == 0
              && (directoryStat.st_mode & 0777) == 0700,
          "diagnostics directory has mode 0700");

    const auto record = [&](const std::string& session) {
        return store.store(now, session, "g111111111111111111", "host", "{\"version\":1}");
    };
    check(record("session-a"), "first JSONL record is stored");
    check(record("session-b"), "a record rotates before the per-file hard limit");
    check(record("session-c"), "storage remains under the aggregate hard limit");
    check(!record("session-d"), "aggregate hard limit fails closed");

    std::size_t files = 0;
    bool privateFiles = true;
    for (const auto& entry : fs::directory_iterator(data / "diagnostics")) {
        ++files;
        struct stat fileStat {};
        privateFiles = privateFiles && ::lstat(entry.path().c_str(), &fileStat) == 0
            && S_ISREG(fileStat.st_mode) && fileStat.st_nlink == 1 && (fileStat.st_mode & 0777) == 0600;
    }
    check(files >= 2, "rotation creates multiple bounded JSONL files");
    check(privateFiles, "diagnostic files have mode 0600 and no hard-link aliases");

    now += std::chrono::hours(24 * 8);
    check(record("session-after-retention"), "expired files are pruned before a new write");
    std::size_t retained = 0;
    for (const auto& entry : fs::directory_iterator(data / "diagnostics")) {
        if (entry.is_regular_file()) { ++retained; }
    }
    check(retained == 1, "retention removes every expired diagnostic file");
    for (const auto& entry : fs::directory_iterator(data / "diagnostics")) {
        ::chmod(entry.path().c_str(), 0644);
    }
    ::chmod((data / "diagnostics").c_str(), 0755);
    check(record("session-permission-repair"), "each write restores private directory and file modes");
    struct stat repairedDirectoryStat {};
    bool repairedFiles = true;
    for (const auto& entry : fs::directory_iterator(data / "diagnostics")) {
        struct stat fileStat {};
        repairedFiles = repairedFiles && ::stat(entry.path().c_str(), &fileStat) == 0
            && (fileStat.st_mode & 0777) == 0600;
    }
    check(::stat((data / "diagnostics").c_str(), &repairedDirectoryStat) == 0
              && (repairedDirectoryStat.st_mode & 0777) == 0700 && repairedFiles,
          "write-time permission repair is verified");

    const fs::path outside = root / "outside";
    const fs::path symlinkData = root / "symlink-data";
    fs::create_directories(outside);
    fs::create_directories(symlinkData);
    fs::create_directory_symlink(outside, symlinkData / "diagnostics");
    DiagnosticsStore symlinkStore(symlinkData, www);
    check(!symlinkStore.initialize(), "diagnostics directory symlinks fail closed");
    check(fs::is_empty(outside), "symlink rejection does not write through to an outside directory");

    const fs::path hardlinkData = root / "hardlink-data";
    fs::create_directories(hardlinkData / "diagnostics");
    const auto currentMs = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count();
    const fs::path target = hardlinkData / "diagnostics"
        / ("diagnostics-" + std::to_string(currentMs) + "-0000000000000000.jsonl");
    const fs::path alias = root / "outside-alias.jsonl";
    { std::ofstream output(target); output << "{}\n"; }
    fs::create_hard_link(target, alias);
    DiagnosticsStore hardlinkStore(hardlinkData, www);
    check(!hardlinkStore.initialize(), "diagnostic hard-link aliases fail closed");

    const fs::path nestedWww = root / "nested-www";
    fs::create_directories(nestedWww / "data");
    DiagnosticsStore webStore(nestedWww / "data", nestedWww);
    check(!webStore.initialize(), "diagnostics storage inside the static tree is refused");
    check(!fs::exists(nestedWww / "data" / "diagnostics"), "web-tree rejection happens before creating a static-path directory");

    fs::remove_all(root, ec);
    if (!passed) { return 1; }
    std::cout << "PASS: diagnostic storage permissions, rotation, retention and path safety" << std::endl;
    return 0;
}
