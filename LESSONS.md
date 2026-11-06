# LESSONS

记录在本项目中反复出现、值得复用的问题与结论。

## 关闭窗口与退出应用应分开处理

- **旧行为**：未拦截关闭事件时，关闭最后一个窗口会让应用和 `tauri dev` 进程正常退出，不代表崩溃。
- **当前行为**：主窗口通过 `CloseRequested` 隐藏并阻止销毁，保留 WebView、IM 连接及后台服务；开发模式和打包版本均适用。
- **恢复与退出**：托盘点击或“显示主窗口”菜单恢复窗口；macOS 点击 Dock 图标也能恢复。托盘“退出应用”和 macOS 的系统退出操作用于真正结束进程，不拦截应用退出事件。
- **验证**：Rust 改动需要重启原生进程后生效。关闭窗口后应仍有进程，恢复后会话和草稿应保留；明确退出后进程才结束。

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

## 执行命令前固定工作目录

- 仓库根目录与 `YX/` 的相对路径不可混用：在 `YX/` 执行命令时，文件路径应为 `src/...`、`scripts/...`，不要再加 `YX/` 前缀。
- 编辑与验证分开执行，并给每次命令显式指定工作目录；`pnpm build` 和前端回归脚本统一在 `YX/` 运行，避免生成嵌套目录或在根目录找不到脚本。
