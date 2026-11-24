fn main() {
    // 图标由 Tauri 宏嵌入程序；替换资源后也必须重新编译。
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=wemeet/wemeet_shim.cc");
    println!("cargo:rerun-if-changed=wemeet/wemeet_shim.h");
    println!("cargo:rerun-if-changed=wemeet/wemeet_stub.cc");
    println!("cargo:rerun-if-changed=vendor/TMSDK.framework");

    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"),
    );
    let vendor = manifest_dir.join("vendor");
    let framework = vendor.join("TMSDK.framework").join("Versions").join("A");
    let nested = framework.join("Frameworks");
    let headers = framework.join("Headers");
    let ready = headers.join("wemeet_sdk.h").exists()
        && nested
            .join("tmsdk_wemeet_sdk.framework")
            .join("Versions")
            .join("A")
            .join("tmsdk_wemeet_sdk")
            .exists();

    let mut build = cc::Build::new();
    build.cpp(true).std("c++17").warnings(false);

    if ready {
        build
            .file("wemeet/wemeet_shim.cc")
            .include(&headers)
            .compile("wemeet_shim");

        println!("cargo:rustc-link-search=framework={}", nested.display());
        println!("cargo:rustc-link-lib=framework=tmsdk_wemeet_sdk");

        // 打包后：Contents/MacOS/YX → Contents/Frameworks/TMSDK.framework/...
        // 注意：Tauri 自己已经加了 @executable_path/../Frameworks，这里只补嵌套目录。
        println!(
            "cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks/TMSDK.framework/Versions/A/Frameworks"
        );

        // 开发态：target/<profile>/YX 的 @executable_path 不在 .app 里，
        // 用软链把 target/Frameworks 与 target/<profile>/Frameworks 指到 vendor。
        link_dev_frameworks(&vendor);
    } else {
        build.file("wemeet/wemeet_stub.cc").compile("wemeet_shim");
        println!(
            "cargo:warning=TMSDK.framework 未就绪，使用 wemeet_stub（会议不可用）。运行 scripts/sync-wemeet.sh 后重新构建。"
        );
    }

    tauri_build::build()
}

/// 让 `cargo run` / `tauri dev` 也能按 `@executable_path/../Frameworks` 找到框架。
fn link_dev_frameworks(vendor: &std::path::Path) {
    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let out_dir = std::path::PathBuf::from(out_dir);
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    let Some(target_dir) = profile_dir.parent() else {
        return;
    };
    for link in [profile_dir.join("Frameworks"), target_dir.join("Frameworks")] {
        if link.symlink_metadata().is_ok() {
            continue;
        }
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(vendor, &link);
    }
}
