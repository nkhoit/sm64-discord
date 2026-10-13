#include "discord_api.hpp"

#include <boost/asio/connect.hpp>
#include <boost/asio/io_context.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/ssl.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <boost/beast/ssl.hpp>
#include <boost/json.hpp>
#include <iostream>

namespace asio = boost::asio;
namespace beast = boost::beast;
namespace http = beast::http;
namespace json = boost::json;

namespace {

std::string url_encode(const std::string& value) {
    static const char* hex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : value) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 0xF];
        }
    }
    return out;
}

std::string json_string(const json::object& obj, const char* key) {
    if (auto* v = obj.if_contains(key); v && v->is_string()) { return std::string(v->as_string()); }
    return {};
}

} // namespace

DiscordApi::DiscordApi(std::string apiBase, std::string clientId, std::string clientSecret)
    : mClientId(std::move(clientId)), mClientSecret(std::move(clientSecret)) {
    // apiBase looks like https://discord.com or http://127.0.0.1:9000 (tests)
    auto schemeEnd = apiBase.find("://");
    mScheme = apiBase.substr(0, schemeEnd);
    std::string hostPort = apiBase.substr(schemeEnd + 3);
    if (!hostPort.empty() && hostPort.back() == '/') { hostPort.pop_back(); }
    auto colon = hostPort.find(':');
    mHost = hostPort.substr(0, colon);
    mPort = (colon == std::string::npos) ? (mScheme == "https" ? "443" : "80") : hostPort.substr(colon + 1);
}

DiscordApi::Response DiscordApi::request(const std::string& method, const std::string& path,
                                         const std::string& authorization, const std::string& contentType,
                                         const std::string& body) const {
    Response result;
    try {
        asio::io_context io;
        asio::ip::tcp::resolver resolver(io);
        auto endpoints = resolver.resolve(mHost, mPort);

        http::request<http::string_body> req(http::string_to_verb(method), path, 11);
        req.set(http::field::host, mHost);
        req.set(http::field::user_agent, "sm64-relay (https://github.com/nkhoit/sm64-discord, 1.0)");
        if (!authorization.empty()) { req.set(http::field::authorization, authorization); }
        if (!contentType.empty()) { req.set(http::field::content_type, contentType); }
        req.body() = body;
        req.prepare_payload();

        beast::flat_buffer buffer;
        http::response<http::string_body> res;
        if (mScheme == "https") {
            asio::ssl::context ctx(asio::ssl::context::tls_client);
            ctx.set_default_verify_paths();
            ctx.set_verify_mode(asio::ssl::verify_peer);
            beast::ssl_stream<beast::tcp_stream> stream(io, ctx);
            SSL_set_tlsext_host_name(stream.native_handle(), mHost.c_str());
            stream.set_verify_callback(asio::ssl::host_name_verification(mHost));
            beast::get_lowest_layer(stream).expires_after(std::chrono::seconds(10));
            beast::get_lowest_layer(stream).connect(endpoints);
            stream.handshake(asio::ssl::stream_base::client);
            http::write(stream, req);
            http::read(stream, buffer, res);
            beast::error_code ec;
            stream.shutdown(ec);
        } else {
            beast::tcp_stream stream(io);
            stream.expires_after(std::chrono::seconds(10));
            stream.connect(endpoints);
            http::write(stream, req);
            http::read(stream, buffer, res);
        }
        result.status = static_cast<int>(res.result_int());
        result.body = std::move(res.body());
    } catch (const std::exception& e) {
        std::cerr << "discord api " << method << " " << path << " failed: " << e.what() << "\n";
    }
    return result;
}

std::optional<std::string> DiscordApi::exchange_code(const std::string& code) const {
    std::string form = "client_id=" + url_encode(mClientId) + "&client_secret=" + url_encode(mClientSecret)
                     + "&grant_type=authorization_code&code=" + url_encode(code);
    auto res = request("POST", "/api/oauth2/token", "", "application/x-www-form-urlencoded", form);
    if (res.status != 200) { return std::nullopt; }
    boost::system::error_code ec;
    auto value = json::parse(res.body, ec);
    if (ec || !value.is_object()) { return std::nullopt; }
    auto token = json_string(value.as_object(), "access_token");
    if (token.empty()) { return std::nullopt; }
    return token;
}

std::optional<DiscordApi::User> DiscordApi::get_user(const std::string& accessToken) const {
    auto res = request("GET", "/api/users/@me", "Bearer " + accessToken, "", "");
    if (res.status != 200) { return std::nullopt; }
    boost::system::error_code ec;
    auto value = json::parse(res.body, ec);
    if (ec || !value.is_object()) { return std::nullopt; }
    const auto& obj = value.as_object();
    User user{json_string(obj, "id"), json_string(obj, "username"), json_string(obj, "global_name")};
    if (user.id.empty()) { return std::nullopt; }
    return user;
}

bool DiscordApi::is_guild_member(const std::string& accessToken, const std::string& guildId) const {
    auto res = request("GET", "/api/users/@me/guilds/" + guildId + "/member", "Bearer " + accessToken, "", "");
    return res.status == 200;
}
