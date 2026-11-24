# vendor：腾讯会议原生框架（本地开发用，不入库）

P0 验证需要官方安装包里的 `TMSDK.framework`（355 MB，arm64-only）。

```bash
# 1. 挂载安装包（或直接双击 dmg）
hdiutil attach /Users/tom/Documents/code/old/yue/yx-packages/yuexiu_*.dmg

# 2. 拷到 vendor
./scripts/sync-wemeet.sh

# 3. 打 .app 后运行（不能用 pnpm tauri dev，见下）
pnpm tauri build --debug
open src-tauri/target/debug/bundle/macos/YX.app
```

- `TMSDK.framework` 不提交 Git（见 `YX/.gitignore`），也不随公开构建分发。
- 框架内含 `TMSDKHelper.app` 与 40+ 嵌套 framework，必须整体拷贝、保持目录层级。
- 许可证归腾讯所有，仅限本地验证；生产分发前需确认企业授权。

## 为什么不能用 `pnpm tauri dev`

`tauri dev` 跑的是裸二进制 `target/debug/YX`，没有 `CFBundleIdentifier`。
TMSDK 在 `Initialize` 时会用 `NSBundle` 定位容器目录，裸进程里拿到
`Containers/(null)`，随后直接 SIGSEGV（已实测）。

放进带 `Info.plist` 的 `.app` 后，同样的调用会正常回调
`OnSDKInitializeResult code=0`。`wemeet_init` 已加检查，在裸二进制下返回
可读错误而不是崩溃。

详细验证记录见 `doc/腾讯会议P0验证记录.md`。
