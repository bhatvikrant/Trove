use std::path::PathBuf;
use std::process::Command;

fn main() {
    compile_vision_helper();
    tauri_build::build()
}

// Compile the macOS Vision helper (Swift) into bin/vision-helper. If swiftc
// isn't available, warn and continue — scene/OCR just stays disabled.
fn compile_vision_helper() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join("vision/vision-helper.swift");
    let bin_dir = manifest.join("bin");
    let out = bin_dir.join("vision-helper");
    println!("cargo:rerun-if-changed={}", src.display());

    if !src.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&bin_dir);
    match Command::new("swiftc")
        .args(["-O"])
        .arg(&src)
        .arg("-o")
        .arg(&out)
        .status()
    {
        Ok(s) if s.success() => {}
        _ => println!(
            "cargo:warning=vision-helper not compiled (swiftc unavailable); scene/OCR disabled"
        ),
    }
}
