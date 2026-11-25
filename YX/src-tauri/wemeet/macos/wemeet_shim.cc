// P0：腾讯会议原生桥。直接调用 TMSDK 的 C++ 接口（GetWemeetSDKInstance）。
//
// 与官方 wemeet_electron_sdk.node 的做法一致：初始化后挂 SDK/账号/会前/会中四组回调，
// 事件序列化成 JSON 交回 Rust，再 emit 给前端。

#include "wemeet_shim.h"

#include "wemeet_sdk.h"

#include <dlfcn.h>

#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>

namespace {

yx_wemeet_event_cb g_cb = nullptr;
std::mutex g_mu;
IWemeetSDK* g_sdk = nullptr;
bool g_released = true;

// 组件化：框架不在链接期依赖，改为运行时 dlopen + dlsym（只需要这三个导出符号）。
using GetInstanceFn = IWemeetSDK* (*)();
using ReleaseInstanceFn = void (*)();
using VersionFn = void (*)(char*, int);

GetInstanceFn g_get_instance = nullptr;
ReleaseInstanceFn g_release_instance = nullptr;
VersionFn g_version = nullptr;
std::string g_load_error;

std::string json_escape(const char* s) {
  std::string out;
  if (!s) return out;
  for (const auto* p = reinterpret_cast<const unsigned char*>(s); *p; ++p) {
    switch (*p) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (*p < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", *p);
          out += buf;
        } else {
          out += static_cast<char>(*p);
        }
    }
  }
  return out;
}

void emit_event(const char* func, int code, const char* msg,
                const char* service = nullptr, const char* param = nullptr) {
  yx_wemeet_event_cb cb;
  {
    std::lock_guard<std::mutex> lock(g_mu);
    cb = g_cb;
  }
  if (!cb || g_released) return;

  std::string j = "{\"func\":\"";
  j += json_escape(func);
  j += "\",\"code\":\"";
  j += std::to_string(code);
  j += "\",\"msg\":\"";
  j += json_escape(msg);
  if (service) {
    j += "\",\"service\":\"";
    j += json_escape(service);
  }
  if (param) {
    j += "\",\"param\":\"";
    j += json_escape(param);
  }
  j += "\"}";
  cb(j.c_str());
}

void wire_services();

class SdkCallback : public ISDKCallback {
 public:
  void OnSDKInitializeResult(int code, const char* msg) override {
    emit_event("OnSDKInitializeResult", code, msg, "SDKService");
    if (code == 0 || code == kTMSDKErrorDuplicateInitCall) wire_services();
  }
  void OnSDKTokenExpired(const char* sdk_token) override {
    emit_event("OnSDKTokenExpired", 0, sdk_token, "SDKService", sdk_token);
  }
  void OnSDKError(int code, const char* msg) override {
    emit_event("OnSDKError", code, msg, "SDKService");
  }
  void OnShowLogsResult(int code, const char* msg) override {
    emit_event("OnShowLogsResult", code, msg, "SDKService");
  }
  void OnResetSDKState(int code, const char* msg) override {
    emit_event("OnResetSDKState", code, msg, "SDKService");
  }
  void OnSetProxyResult(int code, const char* msg) override {
    emit_event("OnSetProxyResult", code, msg, "SDKService");
  }
  void OnHandleSchemaResult(int code, const char* msg) override {
    emit_event("OnHandleSchemaResult", code, msg, "SDKService");
  }
};

class AuthCallback : public IAuthenticationCallback {
 public:
  void OnLogin(int code, const char* msg) override {
    emit_event("OnLogin", code, msg, "AccountService");
  }
  void OnLogout(int type, int code, const char* msg) override {
    emit_event("OnLogout", code, msg, "AccountService",
               type == 2 ? "forced" : "manual");
  }
  void OnJumpUrlWithLoginStatus(int code, const char* msg) override {
    emit_event("OnJumpUrlWithLoginStatus", code, msg, "AccountService");
  }
};

class PreMeetingCallback : public IPreMeetingCallback {
 public:
  void OnJoinMeeting(int code, const char* msg, const char* meeting_code) override {
    emit_event("OnJoinMeeting", code, msg, "PreMeetingService", meeting_code);
  }
  void OnShowScreenCastViewResult(int code, const char* msg) override {
    emit_event("OnShowScreenCastViewResult", code, msg, "PreMeetingService");
  }
  void OnActionResult(int action_type, int code, const char* msg) override {
    emit_event("OnActionResult", code, msg, "PreMeetingService",
               std::to_string(action_type).c_str());
  }
  void OnShowAddressBook(int user_type, const char* json_data) override {
    emit_event("OnShowAddressBook", user_type, "invite", "PreMeetingService",
               json_data);
  }
  void OnRingInvitationEvent(int ring_state, const char* msg) override {
    emit_event("OnRingInvitationEvent", ring_state, "ring", "PreMeetingService",
               msg);
  }
};

class InMeetingCallback : public IInMeetingCallback {
 public:
  void OnLeaveMeeting(int type, int code, const char* msg,
                      const char* meeting_code) override {
    emit_event("OnLeaveMeeting", code, msg, "InMeetingService", meeting_code);
  }
  void OnInviteMeeting(const char* invite_info) override {
    emit_event("OnInviteMeeting", 0, "invite", "InMeetingService", invite_info);
  }
  void OnShowMeetingInfo(const char* meeting_info) override {
    emit_event("OnShowMeetingInfo", 0, "meeting", "InMeetingService",
               meeting_info);
  }
  void OnActionResult(int action_type, int code, const char* msg) override {
    emit_event("OnActionResult", code, msg, "InMeetingService",
               std::to_string(action_type).c_str());
  }
  void OnCaptionSwitchChanged(bool is_open) override {
    emit_event("OnCaptionSwitchChanged", is_open ? 1 : 0, "", "InMeetingService");
  }
  void OnCaptionSettingChanged(const char* json_param) override {
    emit_event("OnCaptionSettingChanged", 0, "", "InMeetingService", json_param);
  }
};

SdkCallback g_sdk_cb;
AuthCallback g_auth_cb;
PreMeetingCallback g_pre_cb;
InMeetingCallback g_in_cb;

void wire_services() {
  if (!g_sdk) return;
  if (auto* account = g_sdk->GetAccountService()) {
    account->SetCallback(&g_auth_cb);
  }
  if (auto* pre = g_sdk->GetPreMeetingService()) {
    pre->SetCallback(&g_pre_cb);
  }
  if (auto* in = g_sdk->GetInMeetingService()) {
    in->SetCallback(&g_in_cb);
  }
}

}  // namespace

extern "C" {

void yx_wemeet_set_event_callback(yx_wemeet_event_cb cb) {
  std::lock_guard<std::mutex> lock(g_mu);
  g_cb = cb;
}

int yx_wemeet_load_library(const char* dylib_path) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (g_get_instance && g_release_instance) return 0;
  if (!dylib_path || !dylib_path[0]) {
    g_load_error = "未提供 TMSDK 动态库路径";
    return -1;
  }
  void* handle = dlopen(dylib_path, RTLD_NOW | RTLD_LOCAL);
  if (!handle) {
    const char* err = dlerror();
    g_load_error = err ? err : "dlopen 失败";
    return -1;
  }
  auto get_instance =
      reinterpret_cast<GetInstanceFn>(dlsym(handle, "GetWemeetSDKInstance"));
  auto release_instance = reinterpret_cast<ReleaseInstanceFn>(
      dlsym(handle, "ReleaseWemeetSDKInstance"));
  if (!get_instance || !release_instance) {
    dlclose(handle);
    g_load_error = "TMSDK 缺少 GetWemeetSDKInstance/ReleaseWemeetSDKInstance 导出符号";
    return -2;
  }
  g_version = reinterpret_cast<VersionFn>(dlsym(handle, "GetWemeetSDKVersion"));
  g_get_instance = get_instance;
  g_release_instance = release_instance;
  g_load_error.clear();
  return 0;
}

const char* yx_wemeet_library_error(void) {
  std::lock_guard<std::mutex> lock(g_mu);
  return g_load_error.c_str();
}

const char* yx_wemeet_version(void) {
  static thread_local char buf[64];
  buf[0] = '\0';
  if (g_version) g_version(buf, static_cast<int>(sizeof(buf)));
  return buf;
}

int yx_wemeet_init(const char* sdk_id, const char* sdk_token,
                   const char* data_path, const char* app_name,
                   const char* server_host) {
  if (!g_get_instance) {
    emit_event("OnShimError", -100, "会议组件未加载：请先安装 TMSDK 组件");
    return -100;
  }
  IWemeetSDK* sdk = g_get_instance();
  if (!sdk) {
    emit_event("OnShimError", -1, "GetWemeetSDKInstance() 返回空");
    return -1;
  }
  g_sdk = sdk;
  g_released = false;

  InitParams params;
  params.sdk_id = sdk_id ? sdk_id : "";
  params.sdk_token = sdk_token ? sdk_token : "";
  params.server_host = server_host ? server_host : "";
  params.org_domain = "";
  params.language = "zh-cn";
  params.data_path = data_path ? data_path : "";
  params.app_name = app_name ? app_name : "网络会议";
  params.app_icon = "";
  params.res_dir = "";
  params.proxy_info = "";

  emit_event("OnShimInitCall", 0, "调用 Initialize");
  sdk->Initialize(params, &g_sdk_cb);
  return 0;
}

int yx_wemeet_is_initialized(void) {
  if (!g_sdk) return 0;
  return g_sdk->IsInitialized() ? 1 : 0;
}

int yx_wemeet_is_logged_in(void) {
  if (!g_sdk) return 0;
  auto* account = g_sdk->GetAccountService();
  return (account && account->IsLoggedIn()) ? 1 : 0;
}

int yx_wemeet_refresh_token(const char* sdk_token) {
  if (!g_sdk) return -1;
  return g_sdk->RefreshSDKToken(sdk_token ? sdk_token : "");
}

int yx_wemeet_login(const char* sso_url) {
  if (!g_sdk) return -1;
  wire_services();
  auto* account = g_sdk->GetAccountService();
  if (!account) {
    emit_event("OnShimError", -1, "AccountService 为空（SDK 可能尚未初始化完成）");
    return -2;
  }
  account->Login(sso_url ? sso_url : "");
  return 0;
}

int yx_wemeet_join(const char* meeting_code, const char* display_name,
                   const char* password, bool mic_on, bool camera_on,
                   bool face_beauty_on) {
  if (!g_sdk) return -1;
  wire_services();
  auto* pre = g_sdk->GetPreMeetingService();
  if (!pre) {
    emit_event("OnShimError", -1, "PreMeetingService 为空");
    return -2;
  }
  JoinMeetingParams params;
  params.meeting_code = meeting_code ? meeting_code : "";
  params.user_display_name = display_name ? display_name : "";
  params.password = password ? password : "";
  params.invite_url = "";
  params.meeting_window_title = "";
  params.mic_on = mic_on;
  params.camera_on = camera_on;
  params.speaker_on = false;
  params.face_beauty_on = face_beauty_on;
  pre->JoinMeeting(params);
  return 0;
}

int yx_wemeet_quick(const char* window_title) {
  if (!g_sdk) return -1;
  wire_services();
  auto* pre = g_sdk->GetPreMeetingService();
  if (!pre) {
    emit_event("OnShimError", -1, "PreMeetingService 为空");
    return -2;
  }
  if (window_title && window_title[0]) {
    std::string json = "{\"meeting_window_title\":\"";
    json += json_escape(window_title);
    json += "\"}";
    pre->QuickMeetingByJSON(json.c_str());
  } else {
    pre->QuickMeeting();
  }
  return 0;
}

int yx_wemeet_show_home(void) {
  if (!g_sdk) return -1;
  wire_services();
  auto* pre = g_sdk->GetPreMeetingService();
  if (!pre) {
    emit_event("OnShimError", -1, "PreMeetingService 为空");
    return -2;
  }
  pre->ShowPreMeetingView(WM_PRE_MEETING_VIEW_STYLE_CLASSIC);
  return 0;
}

int yx_wemeet_bring_top(void) {
  if (!g_sdk) return -1;
  g_sdk->BringViewTop();
  return 0;
}

int yx_wemeet_enable_ring(int enable) {
  if (!g_sdk) return -1;
  auto* pre = g_sdk->GetPreMeetingService();
  if (!pre) {
    emit_event("OnShimError", -1, "PreMeetingService 为空");
    return -2;
  }
  // 响铃邀请是 SDK 的独立通道（不是 IM 消息）：开启后由 SDK 自绘接听窗口，
  // 拒绝/超时由它处理；`OnRingInvitationEvent` 只用于诊断。
  pre->EnableRingInvitationView(enable != 0);
  return 0;
}

int yx_wemeet_logout(void) {
  if (!g_sdk) return -1;
  if (auto* account = g_sdk->GetAccountService()) account->Logout();
  return 0;
}

void yx_wemeet_release(void) {
  g_released = true;
  if (g_sdk) {
    g_sdk->Uninitialize("{\"force\": true}");
    if (g_release_instance) g_release_instance();
  }
  g_sdk = nullptr;
}

}  // extern "C"
