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