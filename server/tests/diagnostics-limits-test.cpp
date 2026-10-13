#include <iostream>

#include "diagnostics_limits.hpp"

int main() {
    DiagnosticsPendingLimit pending(32);
    bool passed = true;
    const auto check = [&](bool ok, const char* name) {
        std::cout << (ok ? "ok  " : "FAIL") << " " << name << '\n';
        passed = passed && ok;
    };
    for (int i = 0; i < 32; ++i) { check(pending.try_reserve(), "each slot up to the global cap is reserved"); }
    check(!pending.try_reserve(), "the global pending cap fails closed");
    check(pending.pending() == 32, "rejected work does not consume pending capacity");
    pending.release();
    check(pending.try_reserve(), "a completed write releases exactly one slot");
    check(pending.pending() == 32, "released capacity is reusable without resetting active work");
    if (!passed) { return 1; }
    std::cout << "PASS: diagnostic pending admission remains bounded" << std::endl;
    return 0;
}
