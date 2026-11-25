# vendor：腾讯会议原生框架（本地开发用，不入库）

P0 验证需要官方安装包里的 `TMSDK.framework`（355 MB，arm64-only）。

```bash
# 1. 挂载安装包（或直接双击 dmg）
hdiutil attach /Users/tom/Documents/code/old/yue/yx-packages/yuexiu_*.dmg

# 2. 拷到 vendor
./scripts/sync-wemeet.sh

# 3. 打 .app，把框架装进去，再运行（不能用 pnpm tauri dev，见下）
pnpm tauri build --debug
./scripts/install-wemeet.sh src-tauri/target/debug/bundle/macos/YX.app
open src-tauri/target/debug/bundle/macos/YX.app
```

- `TMSDK.framework` 不提交 Git（见 `YX/.gitignore`）：355 MB，仓库里只放打包脚本与头文件流程。
- 只想编译 shim（不需要 355 MB 框架、也不装进 app）时，只取头文件即可：
  `./scripts/fetch-tmsdk-headers.sh macos-arm64`（从组件包 Release 里解出 `Headers`，地址取自 `components.json`；
  `TMSDK_ARCHIVE=dist-components/TMSDK-*.tar.zst` 可离线执行）。CI 用的就是这条路径。
- 框架内含 `TMSDKHelper.app` 与 40+ 嵌套 framework，必须整体拷贝、保持目录层级。
- 腾讯 SDK 为公开可获取的组件，可按 `scripts/pack-tmsdk.sh` 打成 `TMSDK-<ver>-macos-arm64.tar.zst`
  发布到 GitHub Release，由应用内的组件安装器按需下载（见 `doc/TMSDK组件化与跨平台设计.md`）。
- 本地开发把框架装进 `YX.app` 用 `./scripts/install-wemeet.sh`（不要在构建期塞进包）。

## 为什么不能用 `pnpm tauri dev`

`tauri dev` 跑的是裸二进制 `target/debug/YX`，没有 `CFBundleIdentifier`。
TMSDK 在 `Initialize` 时会用 `NSBundle` 定位容器目录，裸进程里拿到
`Containers/(null)`，随后直接 SIGSEGV（已实测）。

放进带 `Info.plist` 的 `.app` 后，同样的调用会正常回调
`OnSDKInitializeResult code=0`。`wemeet_init` 已加检查，在裸二进制下返回
可读错误而不是崩溃。

详细验证记录见 `doc/腾讯会议P0验证记录.md`。
