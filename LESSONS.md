# LESSONS

记录在本项目中反复出现、值得复用的问题与结论。

## Tauri dev 进程随窗口关闭而退出

- **现象**：我以 `pnpm tauri dev` 后台启动后，用户关闭应用窗口，进程结束；下次需要重新启动，反复多次。
- **原因**：`tauri dev` 会 `cargo run` 应用，窗口关闭 → 进程退出 → `tauri dev` 退出。这是预期行为，不是崩溃（日志无 panic）。
- **应对**：
  - 用户自行在终端运行 `pnpm tauri dev`，自行控制窗口生命周期，避免代理反复重启。
  - 需要“关窗后不再退出”的常驻形态时，改用 `pnpm tauri build --debug` 生成 `.app` 后从访达启动。
  - 看到窗口关闭后的 echo 通知时，先看日志有无 panic；无 panic 就只是正常退出，不必反复排查。

## 登录后在"用户信息接口"上阻塞导致不跳转

- **现象**：登录成功但页面不跳转。
- **原因**：store 中 `await authService.getCurrentUser()` 阻塞；当该接口慢或挂起时登录 Promise 永不 resolve。
- **应对**：登录主流程只依赖 token 获取，用户信息等附加请求一律异步/带超时，不得阻塞路由跳转。

## 登录成功后被弹回登录页（自动登录时无限循环）

- **现象**：账号密码验证通过、token 已写入，但页面立刻回到登录页；勾选“自动登录”时登录页反复闪现。
- **原因**：`useAuthStore` 里 `isLoggedIn = computed(() => authService.isLoggedIn())`，computed 内部只读 localStorage、没有任何响应式依赖。`App.vue` 启动时先读了一次（此时未登录）→ 结果被永久缓存为 `false`；登录成功后 `ChatView`/`DiskView` 再读仍是 `false`，于是 `router.replace('/login')`，自动登录又发起下一次登录，形成死循环。
- **应对**：登录态必须存成 `ref`（见 `stores/auth.ts` 的 `token`/`expiresAt` + `syncSession()`），登录、退出、刷新 token 后同步；不要在 computed 里直接读 localStorage。另：`expires_in` 缺失时 `expires_at` 要写 0（视为未知），不能写 `Date.now()`，否则会被当成已过期。
## 应用图标设计与开发模式验证

- 用户提供明确的 SVG 参考时，以该 SVG 为源文件，仅修改指定图形；字母标识使用路径，避免字体依赖。
- 应用图标源文件为 `YX/app-icon.svg`，通过 `pnpm tauri icon` 导出 PNG、ICNS、ICO；系统托盘使用默认窗口图标，也应同步更新。
- macOS 开发模式将 ICNS 嵌入可执行文件。仅更新图片、运行 `cargo check` 或前端构建不足以确认生效；`build.rs` 必须追踪 `icons` 目录，并通过 `cargo build` 验证新 ICNS 已嵌入程序。
