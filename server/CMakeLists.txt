cmake_minimum_required(VERSION 3.16)
project(sm64_relay CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(Boost 1.75 REQUIRED)
find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)

add_executable(sm64-relay
    src/main.cpp
    src/api.cpp
    src/discord_api.cpp
    src/diagnostics_store.cpp
    src/http_session.cpp
    src/json_impl.cpp
    src/relay.cpp
    src/save_store.cpp
    src/ws_session.cpp
)
target_include_directories(sm64-relay PRIVATE src)
target_link_libraries(sm64-relay PRIVATE Boost::headers Threads::Threads OpenSSL::SSL OpenSSL::Crypto)
target_compile_options(sm64-relay PRIVATE -Wall -Wextra)

include(CTest)
if(BUILD_TESTING)
    add_executable(rom-rate-limits-test tests/rom-rate-limits-test.cpp)
    target_include_directories(rom-rate-limits-test PRIVATE src)
    target_compile_options(rom-rate-limits-test PRIVATE -Wall -Wextra)
    add_test(NAME rom-rate-limits COMMAND rom-rate-limits-test)
    add_executable(diagnostics-store-test tests/diagnostics-store-test.cpp src/diagnostics_store.cpp src/json_impl.cpp)
    target_include_directories(diagnostics-store-test PRIVATE src)
    target_link_libraries(diagnostics-store-test PRIVATE Boost::headers)
    target_compile_options(diagnostics-store-test PRIVATE -Wall -Wextra)
    add_test(NAME diagnostics-store COMMAND diagnostics-store-test)
    add_executable(diagnostics-limits-test tests/diagnostics-limits-test.cpp)
    target_include_directories(diagnostics-limits-test PRIVATE src)
    target_compile_options(diagnostics-limits-test PRIVATE -Wall -Wextra)
    add_test(NAME diagnostics-limits COMMAND diagnostics-limits-test)
endif()
