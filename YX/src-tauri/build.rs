fn main() {
    // 图标由 Tauri 宏嵌入程序；替换资源后也必须重新编译。
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=wemeet/wemeet_shim.h");
    println!("cargo:rerun-if-changed=wemeet/macos");
    println!("cargo:rerun-if-changed=wemeet/stub");
    println!("cargo:rerun-if-changed=vendor/TMSDK.framework/Versions/A/Headers");

    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
    );
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // 组件化之后，TMSDK 只在编译期用到头文件（实现改为运行时 dlopen，见
    // wemeet/macos/wemeet_shim.cc）。头文件缺失时编占位实现，保证任何平台都能构建；
    // 真实构建（CI / 本机）由 scripts/fetch-wemeet-headers.sh 或 sync-wemeet.sh 备好。
    let headers = manifest_dir
        .join("vendor")
        .join("TMSDK.framework")
        .join("Versions")
        .join("A")
        .join("Headers");
    let has_headers = target_os == "macos" && headers.join("wemeet_sdk.h").exists();

    let mut build = cc::Build::new();
    build.cpp(true).std("c++17").warnings(false).include("wemeet");

    if has_headers {
        build.file("wemeet/macos/wemeet_shim.cc").include(&headers);
    } else {
        build.file("wemeet/stub/wemeet_stub.cc");
        println!(
            "cargo:warning=TMSDK 头文件缺失，使用 wemeet_stub（会议组件不可用）。\
             本机可运行 scripts/sync-wemeet.sh 准备。"
        );
    }
    build.compile("wemeet_shim");

    tauri_build::build()
}
