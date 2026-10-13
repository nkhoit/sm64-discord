#include "sm64.h"
#include "djui.h"
#include "djui_panel.h"
#include "djui_panel_player.h"
#include "djui_panel_dynos.h"
#include "djui_panel_options.h"
#include "djui_panel_host.h"
#include "djui_panel_client_server_settings.h"
#include "djui_panel_menu.h"
#include "djui_panel_confirm.h"
#include "djui_panel_mod_menu.h"
#include "pc/pc_main.h"
#include "pc/network/network.h"
#include "pc/lua/smlua_hooks.h"
#include "game/object_helpers.h"
#include "behavior_table.h"

bool gDjuiPanelPauseCreated = false;

#ifdef TARGET_WEB
// In the Discord Activity the relay picks the host and a session ends when the player closes the
// Activity, so the pause menu has no Server Settings, Stop Hosting or Disconnect (nor the disconnect key).
#define PAUSE_MENU_HOST_BUTTONS 0
#else
#define PAUSE_MENU_HOST_BUTTONS 1
#endif

#ifdef WEB_TEST_HOOKS
static struct DjuiBase* sWebPauseBody = NULL;
static struct DjuiBase* sWebPauseDefault = NULL;
#endif

static void djui_panel_pause_resume(UNUSED struct DjuiBase* caller) {
    djui_panel_shutdown();
}

void djui_panel_pause_quit_yes(UNUSED struct DjuiBase* caller) {
    network_reset_reconnect_and_rehost();
    network_shutdown(true, false, false, false);
}

void djui_panel_pause_disconnect_key_update(int scancode) {
    if (!PAUSE_MENU_HOST_BUTTONS) { return; }
    if (gDjuiInMainMenu || find_object_with_behavior(bhvActSelector) != NULL) { return; }

    for (int i = 0; i < MAX_BINDS; i++) {
        if (scancode == (int)configKeyDisconnect[i]) {
            djui_panel_pause_quit_yes(NULL);
        }
    }
}

static void djui_panel_pause_quit(struct DjuiBase* caller) {
    if (gMarioStates[0].action == ACT_PUSHING_DOOR || gMarioStates[0].action == ACT_PULLING_DOOR) { return; }

    if (gNetworkType == NT_SERVER) {
        djui_panel_confirm_create(caller,
                                DLANG(PAUSE, QUIT_TITLE),
                                DLANG(PAUSE, QUIT_HOST),
                                djui_panel_pause_quit_yes);
    } else {
        djui_panel_confirm_create(caller,
                                DLANG(PAUSE, QUIT_TITLE),
                                DLANG(PAUSE, QUIT_CLIENT),
                                djui_panel_pause_quit_yes);
    }
}

void djui_panel_pause_create(struct DjuiBase* caller) {
    if (gDjuiPanelPauseCreated) { return; }
    if (gDjuiChatBoxFocus) { djui_chat_box_toggle(); }

    struct DjuiBase* defaultBase = NULL;
    struct DjuiThreePanel* panel = djui_panel_menu_create(DLANG(PAUSE, PAUSE_TITLE), false);
    struct DjuiBase* body = djui_three_panel_get_body(panel);
    {
        struct DjuiRect* rect1 = djui_rect_container_create(body, 64);
        {
            djui_button_left_create(&rect1->base, DLANG(PAUSE, PLAYER), DJUI_BUTTON_STYLE_NORMAL, djui_panel_player_create);
            djui_button_right_create(&rect1->base, DLANG(PAUSE, DYNOS_PACKS), DJUI_BUTTON_STYLE_NORMAL, djui_panel_dynos_create);
        }

        struct DjuiButton* button3 = djui_button_create(body, DLANG(PAUSE, OPTIONS), DJUI_BUTTON_STYLE_NORMAL, djui_panel_options_create);
        defaultBase = &button3->base;

        if (!PAUSE_MENU_HOST_BUTTONS) {
        } else if (gNetworkType == NT_SERVER) {
            djui_button_create(body, DLANG(PAUSE, SERVER_SETTINGS), DJUI_BUTTON_STYLE_NORMAL, djui_panel_host_create);
        } else {
            djui_button_create(body, DLANG(PAUSE, SERVER_SETTINGS), DJUI_BUTTON_STYLE_NORMAL, djui_panel_client_server_settings_create);
        }

        struct Mod* addedMods[MAX_HOOKED_MOD_MENU_ELEMENTS] = { 0 };
        int modCount = 0;
        for (int i = 0; i < gHookedModMenuElementsCount; i++) {
            struct LuaHookedModMenuElement* hooked = &gHookedModMenuElements[i];
            bool shouldContinue = false;
            for (int i = 0; i < MAX_HOOKED_MOD_MENU_ELEMENTS; i++) {
                if (addedMods[i] == NULL) { break; }
                if (addedMods[i] == hooked->mod) {
                    shouldContinue = true;
                    break;
                }
            }
            if (shouldContinue) { continue; }
            addedMods[modCount++] = hooked->mod;
        }

        if (modCount == 1) {
            struct LuaHookedModMenuElement* hooked = &gHookedModMenuElements[0];
            char buffer[256] = { 0 };
            if (gHookedModMenuElementsCount == 1 && gHookedModMenuElements[0].element == MOD_MENU_ELEMENT_BUTTON) {
                snprintf(buffer, 256, "%s - %s", hooked->mod->name, hooked->name);
                struct DjuiButton* button = djui_button_create(body, buffer, DJUI_BUTTON_STYLE_NORMAL, djui_panel_mod_menu_mod_button);
                button->base.tag = 0;
            } else {
                snprintf(buffer, 256, "%s", hooked->mod->name);
                struct DjuiButton* button = djui_button_create(body, buffer, DJUI_BUTTON_STYLE_NORMAL, djui_panel_mod_menu_mod_create);
                button->base.tag = hooked->mod->index;
            }
        } else if (gHookedModMenuElementsCount > 0) {
            djui_button_create(body, DLANG(PAUSE, MOD_MENU), DJUI_BUTTON_STYLE_NORMAL, djui_panel_mod_menu_create);
        }

        djui_button_create(body, DLANG(PAUSE, RESUME), DJUI_BUTTON_STYLE_NORMAL, djui_panel_pause_resume);

        if (!PAUSE_MENU_HOST_BUTTONS) {
        } else if (gNetworkType == NT_SERVER) {
            djui_button_create(body, DLANG(PAUSE, STOP_HOSTING), DJUI_BUTTON_STYLE_BACK, djui_panel_pause_quit);
        } else {
            djui_button_create(body, DLANG(PAUSE, DISCONNECT), DJUI_BUTTON_STYLE_BACK, djui_panel_pause_quit);
        }
    }

#ifdef WEB_TEST_HOOKS
    sWebPauseBody = body;
    sWebPauseDefault = defaultBase;
#endif
    djui_panel_add(caller, panel, defaultBase);
    gInteractableOverridePad = true;
    gDjuiPanelPauseCreated = true;
}

#ifdef WEB_TEST_HOOKS
#include <emscripten.h>
static void web_pause_list_buttons(struct DjuiBase* base, char* out, size_t size) {
    for (struct DjuiBaseChild* c = base->child; c != NULL; c = c->next) {
        if (c->base->interactable == NULL) { web_pause_list_buttons(c->base, out, size); continue; }
        struct DjuiButton* button = (struct DjuiButton*)c->base;
        size_t len = strlen(out);
        snprintf(out + len, size - len, "%s\"%s%s\"", out[len - 1] == '[' ? "" : ",",
                 c->base == sWebPauseDefault ? "*" : "", button->text ? button->text->message : "");
    }
}

// Test hook (WEB_TEST_HOOKS builds only): the open pause menu's button labels as a JSON array, the
// default (focused) one prefixed with "*". "null" while the pause menu isn't open.
EMSCRIPTEN_KEEPALIVE const char* web_debug_pause_buttons(void) {
    static char json[1024];
    if (!gDjuiPanelPauseCreated || sWebPauseBody == NULL) { return "null"; }
    snprintf(json, sizeof(json), "[");
    web_pause_list_buttons(sWebPauseBody, json, sizeof(json) - 1);
    strcat(json, "]");
    return json;
}
#endif
