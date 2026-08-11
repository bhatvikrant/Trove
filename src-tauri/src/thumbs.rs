use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Deterministic on-disk location for a thumbnail, keyed by source path + mtime
/// so that edited/replaced files get fresh thumbnails automatically.
pub fn thumb_file(cache_dir: &Path, src: &str, mtime: i64) -> PathBuf {
    let mut h = DefaultHasher::new();
    src.hash(&mut h);
    mtime.hash(&mut h);
    cache_dir.join(format!("{:016x}.jpg", h.finish()))
}

/// Ensure a JPEG thumbnail exists for `src`, generating it if needed.
/// Returns the thumbnail path, or None if none could be produced.
pub fn ensure(
    cache_dir: &Path,
    src: &str,
    kind: &str,
    mtime: i64,
    size: u32,
) -> Option<PathBuf> {
    let out = thumb_file(cache_dir, src, mtime);
    if out.exists() {
        return Some(out);
    }
    std::fs::create_dir_all(cache_dir).ok()?;

    let ok = match kind {
        "image" => gen_image(src, &out, size),
        "video" => gen_video(src, &out, size),
        "audio" => gen_video(src, &out, size) || gen_quicklook(cache_dir, src, &out),
        _ => gen_quicklook(cache_dir, src, &out),
    };

    if ok && out.exists() {
        Some(out)
    } else {
        None
    }
}

/// Downscale an image (incl. HEIC/RAW) with macOS `sips`.
fn gen_image(src: &str, out: &Path, size: u32) -> bool {
    Command::new("sips")
        .args([
            "-Z",
            &size.to_string(),
            "-s",
            "format",
            "jpeg",
            src,
            "--out",
            &out.to_string_lossy(),
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Grab a representative frame (or embedded album art) with ffmpeg.
fn gen_video(src: &str, out: &Path, size: u32) -> bool {
    let scale = format!("scale={}:-2:force_original_aspect_ratio=decrease", size);
    let run = |args: &[&str]| {
        Command::new("ffmpeg")
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    let out_s = out.to_string_lossy().to_string();
    // Seek a little in to skip black intro frames; fall back to frame 0.
    run(&[
        "-y", "-loglevel", "error", "-ss", "1", "-i", src, "-frames:v", "1", "-vf", &scale,
        &out_s,
    ]) && out.exists()
        || run(&[
            "-y", "-loglevel", "error", "-i", src, "-frames:v", "1", "-vf", &scale, &out_s,
        ]) && out.exists()
}

/// Fall back to macOS QuickLook, which renders PDFs and many other types.
fn gen_quicklook(cache_dir: &Path, src: &str, out: &Path) -> bool {
    let tmpdir = cache_dir.join(".qltmp");
    let _ = std::fs::create_dir_all(&tmpdir);
    let ok = Command::new("qlmanage")
        .args(["-t", "-s", "512", "-o", &tmpdir.to_string_lossy(), src])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        return false;
    }
    // qlmanage writes "<filename-with-ext>.png" into the output directory.
    let base = Path::new(src)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let produced = tmpdir.join(format!("{}.png", base));
    if !produced.exists() {
        return false;
    }
    let converted = Command::new("sips")
        .args([
            "-s",
            "format",
            "jpeg",
            &produced.to_string_lossy(),
            "--out",
            &out.to_string_lossy(),
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&produced);
    converted && out.exists()
}
