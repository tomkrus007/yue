// 系统通知的 macOS 后端：只做两件事——展示通知、把点击回给 Rust。
//
// 不用 tauri-plugin-notification，是因为它（notify-rust 的 NSUserNotification 后端）
// 在有点击监听时会给每条通知挂一个等待线程，直到用户点击或清掉通知才释放，而且
// 无法移除已展示的通知。这里自建 delegate：展示即返回，点击回调直接把 key 交回去。
//
// 注意：NSUserNotification 从 macOS 10.14 起标记弃用，但通知中心仍在投递；
// 未打包的 dev 二进制没有 bundle id，通知中心不会投递，前端在 dev 下仍走插件。

#import <AppKit/AppKit.h>
#include <stdbool.h>

typedef void (*YXNotifyClickCallback)(const char *key);

static YXNotifyClickCallback g_callback = NULL;
static id g_delegate = nil;

@interface YXNotificationDelegate : NSObject <NSUserNotificationCenterDelegate>
@end

@implementation YXNotificationDelegate

- (void)userNotificationCenter:(NSUserNotificationCenter *)center
       didActivateNotification:(NSUserNotification *)notification {
    if (notification.activationType == NSUserNotificationActivationTypeNone) return;
    // 点正文、点按钮都算交互：立即从通知中心移除，避免点完跳走了通知还挂着。
    // 系统不一定替我们做这件事，重复移除是幂等的。
    [center removeDeliveredNotification:notification];
    if (g_callback == NULL) return;
    NSString *identifier = notification.identifier;
    if (identifier.length == 0) return;
    const char *key = identifier.UTF8String;
    if (key != NULL) g_callback(key);
}

// 应用在前台时也展示：前端已经按「不在当前会话」筛过一遍。
- (BOOL)userNotificationCenter:(NSUserNotificationCenter *)center
       shouldPresentNotification:(NSUserNotification *)notification {
    return YES;
}

@end

void yx_notify_init(YXNotifyClickCallback callback) {
    @autoreleasepool {
        g_callback = callback;
        if (g_delegate == nil) {
            g_delegate = [[YXNotificationDelegate alloc] init];
            [NSUserNotificationCenter defaultUserNotificationCenter].delegate = g_delegate;
        }
    }
}

void yx_notify_show(const char *title, const char *body, const char *key) {
    @autoreleasepool {
        NSString *titleString = title ? [NSString stringWithUTF8String:title] : @"";
        NSString *bodyString = body ? [NSString stringWithUTF8String:body] : @"";
        NSString *keyString = key ? [NSString stringWithUTF8String:key] : @"";
        if (keyString.length == 0) keyString = [[NSUUID UUID] UUIDString];

        NSUserNotification *notification = [[NSUserNotification alloc] init];
        notification.title = titleString;
        notification.informativeText = bodyString;
        notification.identifier = keyString;
        // 默认会带一个「显示」按钮，和点正文是同一个动作；去掉，点正文即可打开。
        notification.hasActionButton = NO;
        [[NSUserNotificationCenter defaultUserNotificationCenter] deliverNotification:notification];
    }
}
