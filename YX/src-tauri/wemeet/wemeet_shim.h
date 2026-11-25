#ifndef YX_WEMEET_SHIM_H
#define YX_WEMEET_SHIM_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * 腾讯会议原生桥。
 *
 * 暴露：初始化 / 登录 / 会前主页 / 入会 / 快速会议 / 置顶 / 登出 / 释放 /
 * 响铃邀请开关。事件通过 yx_wemeet_event_cb 以 JSON 字符串回传
 * （字段：func/code/msg/service/param）。
 */
typedef void (*yx_wemeet_event_cb)(const char* json);

void yx_wemeet_set_event_callback(yx_wemeet_event_cb cb);

/**
 * 加载 TMSDK 动态库。组件化后框架不再链接进主程序，改为运行时 dlopen：
 * 返回 0 表示成功（可重复调用），-1 表示 dlopen 失败，-2 表示缺少必需导出符号。
 * `dylib_path` 指向 tmsdk_wemeet_sdk 的实体文件（framework 内部路径）。
 */
int yx_wemeet_load_library(const char* dylib_path);

/** 最近一次加载失败的原始错误（dlerror）；成功或未调用过时为空串。 */
const char* yx_wemeet_library_error(void);

/** TMSDK 版本号；未加载时为空串。 */
const char* yx_wemeet_version(void);

int yx_wemeet_init(const char* sdk_id, const char* sdk_token, const char* data_path,
                   const char* app_name, const char* server_host);
int yx_wemeet_is_initialized(void);
int yx_wemeet_is_logged_in(void);

int yx_wemeet_refresh_token(const char* sdk_token);
int yx_wemeet_login(const char* sso_url);
int yx_wemeet_join(const char* meeting_code, const char* display_name,
                   const char* password, bool mic_on, bool camera_on,
                   bool face_beauty_on);
int yx_wemeet_quick(const char* window_title);
int yx_wemeet_show_home(void);
int yx_wemeet_bring_top(void);
/** 是否让 SDK 自己弹响铃接听窗口（`OnRingInvitationEvent` 仍会回传）。 */
int yx_wemeet_enable_ring(int enable);
int yx_wemeet_logout(void);
void yx_wemeet_release(void);

#ifdef __cplusplus
}
#endif

#endif  // YX_WEMEET_SHIM_H
