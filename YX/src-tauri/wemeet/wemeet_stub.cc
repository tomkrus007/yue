// TMSDK.framework 未就绪时的占位实现：保证 cargo check / 前端构建能通过。
// 所有接口返回 -100，并在事件流里提示原因；不会加载任何原生库。

#include "wemeet_shim.h"

#include <cstring>

namespace {
yx_wemeet_event_cb g_cb = nullptr;
}

extern "C" {

void yx_wemeet_set_event_callback(yx_wemeet_event_cb cb) { g_cb = cb; }

int yx_wemeet_init(const char*, const char*, const char*, const char*, const char*) {
  if (g_cb) {
    g_cb("{\"func\":\"OnShimError\",\"code\":\"-100\",\"msg\":\"TMSDK.framework 未就绪：请运行 scripts/sync-wemeet.sh 后重新构建\"}");
  }
  return -100;
}

int yx_wemeet_is_initialized(void) { return 0; }
int yx_wemeet_is_logged_in(void) { return 0; }
int yx_wemeet_refresh_token(const char*) { return -100; }
int yx_wemeet_login(const char*) { return -100; }
int yx_wemeet_join(const char*, const char*, const char*, bool, bool, bool) { return -100; }
int yx_wemeet_quick(const char*) { return -100; }
int yx_wemeet_show_home(void) { return -100; }
int yx_wemeet_bring_top(void) { return -100; }
int yx_wemeet_enable_ring(int) { return -100; }
int yx_wemeet_logout(void) { return -100; }
void yx_wemeet_release(void) {}

}  // extern "C"
