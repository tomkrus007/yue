#ifndef YX_WEMEET_SHIM_H
#define YX_WEMEET_SHIM_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * P0 用的腾讯会议原生桥。
 *
 * 只暴露最小面：初始化 / 登录 / 会前主页 / 入会 / 快速会议 / 置顶 / 登出 / 释放。
 * 事件通过 yx_wemeet_event_cb 以 JSON 字符串回传（字段：func/code/msg/service/param）。
 */
typedef void (*yx_wemeet_event_cb)(const char* json);

void yx_wemeet_set_event_callback(yx_wemeet_event_cb cb);

int yx_wemeet_init(const char* sdk_id, const char* sdk_token, const char* data_path,
                   const char* app_name, const char* server_host);
int yx_wemeet_is_initialized(void);

int yx_wemeet_refresh_token(const char* sdk_token);
int yx_wemeet_login(const char* sso_url);
int yx_wemeet_join(const char* meeting_code, const char* display_name,
                   const char* password, bool mic_on, bool camera_on,
                   bool face_beauty_on);
int yx_wemeet_quick(const char* window_title);
int yx_wemeet_show_home(void);
int yx_wemeet_bring_top(void);
int yx_wemeet_logout(void);
void yx_wemeet_release(void);

#ifdef __cplusplus
}
#endif

#endif  // YX_WEMEET_SHIM_H
