fn main() {
    // 图标由 Tauri 宏嵌入程序；替换资源后也必须重新编译。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
