#include "http_session.hpp"

#include <algorithm>
#include <boost/beast/websocket.hpp>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <optional>
#include <string_view>
#include <sys/stat.h>

#include "ws_session.hpp"

namespace beast = boost::beast;
namespace http = beast::http;

namespace {

// Only the build's own kinds of files are served, so stray objects, sources or dependency files
// under --www (.o, .c, .d, .mk, ...) never are. Returns nullptr for anything else.
const char* mime_type(const std::filesystem::path& path) {
    const auto ext = path.extension().string();
    if (ext == ".html") { return "text/html; charset=utf-8"; }
    if (ext == ".js") { return "text/javascript"; }
    if (ext == ".wasm") { return "application/wasm"; }
    if (ext == ".data") { return "application/octet-stream"; }
    if (ext == ".css") { return "text/css"; }
    if (ext == ".png") { return "image/png"; }
    if (ext == ".ico") { return "image/x-icon"; }
    if (ext == ".json") { return "application/json"; }
    return nullptr;
}

// The only files anyone may fetch: the page, the code that signs in, and favicon.ico (browsers ask
// for it on their own, without ?s=). Everything else (the engine, the page's own game code) needs an
// asset session from POST /api/assets as ?s=.
bool is_public_file(const std::filesystem::path& relative) {
    if (relative == "index.html" || relative == "boot.js" || relative == "favicon.ico") { return true; }
    auto first = relative.begin();
    return first != relative.end() && *first == "vendor" && std::next(first) != relative.end();
}

std::int64_t unix_now() {
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

bool path_is_within(const std::filesystem::path& path, const std::filesystem::path& root) {
    auto relative = path.lexically_relative(root);
    return relative.empty() ? path == root : *relative.begin() != "..";
}

std::string lowercase(std::string_view value) {
    std::string out(value);
    for (char& c : out) { c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); }
    return out;
}

std::string_view trim(std::string_view value) {
    while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) { value.remove_prefix(1); }
    while (!value.empty() && (value.back() == ' ' || value.back() == '\t')) { value.remove_suffix(1); }
    return value;
}

// Calls `fn` with each comma-separated item of a header value, trimmed.
template <typename Fn> void for_each_item(std::string_view list, Fn fn) {
    while (!list.empty()) {
        auto comma = list.find(',');
        fn(trim(list.substr(0, comma)));
        if (comma == std::string_view::npos) { break; }
        list.remove_prefix(comma + 1);
    }
}

// True if Accept-Encoding lists `coding` without q=0.
bool accepts_encoding(std::string_view header, std::string_view coding) {
    bool accepted = false;
    for_each_item(header, [&](std::string_view item) {
        auto semicolon = item.find(';');
        if (lowercase(trim(item.substr(0, semicolon))) != coding) { return; }
        accepted = true;
        if (semicolon != std::string_view::npos) {
            auto params = lowercase(item.substr(semicolon + 1));
            params.erase(std::remove(params.begin(), params.end(), ' '), params.end());
            if (params.rfind("q=0", 0) == 0 && params.find_first_of("123456789") == std::string::npos) { accepted = false; }
        }
    });
    return accepted;
}

// True if If-None-Match lists `etag` (weak comparison: proxies such as Cloudflare mark an ETag
// weak when they compress the response, and browsers send it back that way).
bool etag_matches(std::string_view header, std::string_view etag) {
    bool match = false;
    for_each_item(header, [&](std::string_view item) {
        if (item.rfind("W/", 0) == 0) { item.remove_prefix(2); }
        if (item == "*" || item == etag) { match = true; }
    });
    return match;
}

std::string http_date(std::time_t t) {
    std::tm tm{};
    gmtime_r(&t, &tm);
    char buf[64];
    std::strftime(buf, sizeof(buf), "%a, %d %b %Y %H:%M:%S GMT", &tm);
    return buf;
}

std::optional<std::time_t> parse_http_date(std::string_view value) {
    std::tm tm{};
    std::string text(value);
    const char* end = strptime(text.c_str(), "%a, %d %b %Y %H:%M:%S GMT", &tm);
    if (!end || *end != '\0') { return std::nullopt; }
    return timegm(&tm);
}

// True if a reverse proxy or CDN touched the request: Forwarded, Via, X-Forwarded-*, X-Real-IP,
// True-Client-IP, or any CF-* header (cloudflared adds CF-Connecting-IP and CF-Ray). The peer address
// is then the proxy's, so it says nothing about whether the player is on the local network.
bool came_through_proxy(const http::request<http::string_body>& request) {
    for (const auto& field : request) {
        std::string name = lowercase(field.name_string());
        if (name == "forwarded" || name == "via" || name == "x-real-ip" || name == "true-client-ip"
            || name.rfind("x-forwarded-", 0) == 0 || name.rfind("cf-", 0) == 0) {
            return true;
        }
    }
    return false;
}

// Returns the value of `key` in a query string like "a=1&b=2" (no percent-decoding needed for our keys).
std::string query_value(std::string_view target, std::string_view key) {
    auto q = target.find('?');
    if (q == std::string_view::npos) { return {}; }
    std::string_view query = target.substr(q + 1);
    while (!query.empty()) {
        auto amp = query.find('&');
        std::string_view pair = query.substr(0, amp);
        auto eq = pair.find('=');
        if (eq != std::string_view::npos && pair.substr(0, eq) == key) { return std::string(pair.substr(eq + 1)); }
        if (amp == std::string_view::npos) { break; }
        query.remove_prefix(amp + 1);
    }
    return {};
}

} // namespace

HttpSession::HttpSession(boost::asio::ip::tcp::socket&& socket, Relay& relay, Api& api, std::filesystem::path wwwRoot)
    : mStream(std::move(socket)), mRelay(relay), mApi(api), mWwwRoot(std::move(wwwRoot)) {}

void HttpSession::run() {
    do_read();
}

void HttpSession::do_read() {
    mParser.emplace();
    mParser->body_limit(64 * 1024);
    mStream.expires_after(std::chrono::seconds(30));
    http::async_read(mStream, mBuffer, *mParser, beast::bind_front_handler(&HttpSession::on_read, shared_from_this()));
}

void HttpSession::on_read(beast::error_code ec, std::size_t) {
    if (ec) { return; }

    auto& request = mParser->get();
    std::string_view target(request.target().data(), request.target().size());
    std::string_view path = target.substr(0, target.find('?'));

    // Discord's Activity proxy prefixes mapped routes with /.proxy
    if (path.rfind("/.proxy", 0) == 0) { path.remove_prefix(7); }

    if (beast::websocket::is_upgrade(request) && path == "/ws") {
        mStream.expires_never();
        std::make_shared<WsSession>(mStream.release_socket(), mRelay, query_value(target, "ticket"))
            ->run(mParser->release());
        return;
    }

    if (path.rfind("/api/", 0) == 0) {
        serve_api();
        return;
    }

    serve_file();
}

template <typename Response> void HttpSession::send(std::shared_ptr<Response> res, std::shared_ptr<void> lifetime) {
    const bool keepAlive = res->keep_alive();
    mStream.expires_after(limits::kHttpResponseWriteTimeout);
    http::async_write(mStream, *res, [self = shared_from_this(), res, lifetime = std::move(lifetime), keepAlive](beast::error_code e, std::size_t n) {
        self->on_write(keepAlive, e, n);
    });
}

void HttpSession::serve_api() {
    auto& request = mParser->get();
    const bool viaProxy = came_through_proxy(request);
    beast::error_code ec;
    auto remote = mStream.socket().remote_endpoint(ec).address();
    if (ec) { return; }

    mApi.handle(request, remote, viaProxy, [self = shared_from_this()](Api::Reply reply) {
        self->send(std::make_shared<Api::Response>(std::move(reply.response)), std::move(reply.lifetime));
    });
}

// Static files are served with an ETag and Last-Modified and "Cache-Control: no-cache": file names
// aren't content-hashed, so browsers must always check, but an unchanged file costs a 304.
// If the client accepts it and <file>.br or <file>.gz exists (and is at least as new), that's sent
// instead with Content-Encoding.
void HttpSession::serve_file() {
    auto& request = mParser->get();
    const bool keepAlive = request.keep_alive();
    std::string_view target(request.target().data(), request.target().size());
    std::string path(target.substr(0, target.find('?')));
    if (path.rfind("/.proxy", 0) == 0) { path.erase(0, 7); }
    if (path.empty() || path.back() == '/') { path += "index.html"; }

    auto respond_error = [&](http::status status) {
        auto res = std::make_shared<http::response<http::string_body>>(status, request.version());
        res->set(http::field::content_type, "text/plain");
        res->set(http::field::cache_control, "no-store");
        res->keep_alive(keepAlive);
        if (request.method() != http::verb::head) { res->body() = std::string(http::obsolete_reason(status)); }
        res->prepare_payload();
        send(res);
    };

    if (request.method() != http::verb::get && request.method() != http::verb::head) {
        respond_error(http::status::method_not_allowed);
        return;
    }

    // keep requests inside the web root, and to the kinds of files the game is made of
    std::filesystem::path relative = std::filesystem::path(path.substr(1)).lexically_normal();
    const char* contentType = mime_type(relative);

    // Engine files: only with a valid asset session (401 without one, 403 for a bad or expired one).
    // They're answered "private" so no shared cache (Cloudflare's included) keeps a copy for others.
    const bool gated = !relative.empty() && !is_public_file(relative);
    if (gated) {
        switch (mApi.asset_auth().verify(query_value(target, "s"), unix_now())) {
            case AssetAuth::Check::Ok: break;
            case AssetAuth::Check::Missing: respond_error(http::status::unauthorized); return;
            case AssetAuth::Check::Invalid:
            case AssetAuth::Check::Expired: respond_error(http::status::forbidden); return;
        }
    }
    struct stat st {};
    const auto fullPath = mWwwRoot / relative;
    std::error_code pathError;
    const auto canonicalRoot = std::filesystem::weakly_canonical(mWwwRoot, pathError);
    const auto canonicalFile = pathError ? std::filesystem::path{} : std::filesystem::weakly_canonical(fullPath, pathError);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." || !contentType || pathError
        || !path_is_within(canonicalFile, canonicalRoot) || ::stat(fullPath.c_str(), &st) != 0 || !S_ISREG(st.st_mode)
        || mApi.is_hosted_rom_file(st.st_dev, st.st_ino)) {
        respond_error(http::status::not_found);
        return;
    }

    // pick a precompressed copy if there's a usable one
    auto filePath = fullPath;
    std::string encoding;
    auto acceptEncoding = request[http::field::accept_encoding];
    for (const char* coding : {"br", "gzip"}) {
        if (!accepts_encoding(acceptEncoding, coding)) { continue; }
        auto candidate = fullPath;
        candidate += std::string_view(coding) == "br" ? ".br" : ".gz";
        struct stat cst {};
        pathError.clear();
        const auto canonicalCandidate = std::filesystem::weakly_canonical(candidate, pathError);
        if (!pathError && path_is_within(canonicalCandidate, canonicalRoot)
            && ::stat(candidate.c_str(), &cst) == 0 && S_ISREG(cst.st_mode) && cst.st_mtime >= st.st_mtime
            && !mApi.is_hosted_rom_file(cst.st_dev, cst.st_ino)) {
            filePath = candidate;
            encoding = coding;
            st = cst;
            break;
        }
    }

    char etagBuf[64];
    std::snprintf(etagBuf, sizeof(etagBuf), "\"%llx-%llx%s%s\"", static_cast<unsigned long long>(st.st_size),
                  static_cast<unsigned long long>(st.st_mtim.tv_sec) * 1000000000ULL + st.st_mtim.tv_nsec,
                  encoding.empty() ? "" : "-", encoding.c_str());
    const std::string etag = etagBuf;
    const std::string lastModified = http_date(st.st_mtime);

    auto set_headers = [&](auto& res) {
        res.set(http::field::cache_control, gated ? "private, no-cache" : "no-cache");
        res.set(http::field::etag, etag);
        res.set(http::field::last_modified, lastModified);
        res.set(http::field::vary, "Accept-Encoding");
        res.keep_alive(keepAlive);
    };

    bool notModified = false;
    if (auto inm = request[http::field::if_none_match]; !inm.empty()) {
        notModified = etag_matches(inm, etag);
    } else if (auto ims = request[http::field::if_modified_since]; !ims.empty()) {
        auto since = parse_http_date(ims);
        notModified = since && st.st_mtime <= *since;
    }
    if (notModified) {
        auto res = std::make_shared<http::response<http::empty_body>>(http::status::not_modified, request.version());
        set_headers(*res);
        send(res);
        return;
    }

    if (request.method() == http::verb::head) {
        auto res = std::make_shared<http::response<http::empty_body>>(http::status::ok, request.version());
        set_headers(*res);
        res->set(http::field::content_type, contentType);
        if (!encoding.empty()) { res->set(http::field::content_encoding, encoding); }
        res->content_length(static_cast<std::uint64_t>(st.st_size));
        send(res);
        return;
    }

    beast::error_code ec;
    http::file_body::value_type body;
    body.open(filePath.c_str(), beast::file_mode::scan, ec);
    if (ec) {
        respond_error(http::status::not_found);
        return;
    }
    auto res = std::make_shared<http::response<http::file_body>>(
        std::piecewise_construct, std::make_tuple(std::move(body)), std::make_tuple(http::status::ok, request.version()));
    set_headers(*res);
    res->set(http::field::content_type, contentType);
    if (!encoding.empty()) { res->set(http::field::content_encoding, encoding); }
    res->prepare_payload();
    send(res);
}

void HttpSession::on_write(bool keepAlive, beast::error_code ec, std::size_t) {
    if (ec) { return; }
    if (!keepAlive) {
        mStream.socket().shutdown(boost::asio::ip::tcp::socket::shutdown_send, ec);
        return;
    }
    do_read();
}
