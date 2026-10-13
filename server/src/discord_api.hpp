#pragma once

#include <optional>
#include <string>

// Blocking calls to Discord's HTTP API. Run them off the I/O thread.
class DiscordApi {
public:
    struct User {
        std::string id;
        std::string username;
        std::string globalName;
    };

    DiscordApi(std::string apiBase, std::string clientId, std::string clientSecret);

    // Exchanges an OAuth2 code from the Embedded App SDK's authorize() for an access token.
    std::optional<std::string> exchange_code(const std::string& code) const;
    std::optional<User> get_user(const std::string& accessToken) const;
    // Needs the guilds.members.read scope.
    bool is_guild_member(const std::string& accessToken, const std::string& guildId) const;

private:
    struct Response {
        int status = 0;
        std::string body;
    };
    Response request(const std::string& method, const std::string& path, const std::string& authorization,
                     const std::string& contentType, const std::string& body) const;

    std::string mScheme;
    std::string mHost;
    std::string mPort;
    std::string mClientId;
    std::string mClientSecret;
};
