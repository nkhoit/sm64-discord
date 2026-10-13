#pragma once

#include <boost/asio/ip/tcp.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/http.hpp>
#include <filesystem>
#include <memory>
#include <optional>

#include "api.hpp"
#include "relay.hpp"

// Serves the game's static files, answers /api/* through Api, and hands /ws upgrades to WsSession.
class HttpSession : public std::enable_shared_from_this<HttpSession> {
public:
    HttpSession(boost::asio::ip::tcp::socket&& socket, Relay& relay, Api& api, std::filesystem::path wwwRoot);

    void run();

private:
    void do_read();
    void on_read(boost::beast::error_code ec, std::size_t bytes);
    void serve_api();
    void serve_file();
    template <typename Response> void send(std::shared_ptr<Response> res, std::shared_ptr<void> lifetime = {});
    void on_write(bool keepAlive, boost::beast::error_code ec, std::size_t bytes);

    boost::beast::tcp_stream mStream;
    boost::beast::flat_buffer mBuffer;
    std::optional<boost::beast::http::request_parser<boost::beast::http::string_body>> mParser;
    Relay& mRelay;
    Api& mApi;
    std::filesystem::path mWwwRoot;
};
