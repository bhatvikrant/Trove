use base64::Engine;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Deserialize)]
struct RawLabel {
    label: String,
}

#[derive(Deserialize)]
struct RawFace {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    embedding: String, // base64 of little-endian f32 bytes
}

#[derive(Deserialize)]
struct RawResult {
    path: String,
    #[serde(default)]
    labels: Vec<RawLabel>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    faces: Vec<RawFace>,
}

pub struct Face {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub embedding: Vec<u8>, // raw f32 bytes
}

pub struct VisionData {
    pub labels: Vec<String>,
    pub text: String,
    pub faces: Vec<Face>,
}

/// Run the macOS Vision helper over a batch of image paths (piped via stdin,
/// one per line) and collect path → {labels, text}. A writer thread feeds
/// stdin while we read stdout, so large batches can't deadlock on pipe buffers.
pub fn run_batch(helper: &Path, paths: &[String], accurate: bool) -> HashMap<String, VisionData> {
    let mut out = HashMap::new();
    if paths.is_empty() {
        return out;
    }
    let mut child = match Command::new(helper)
        .env("TROVE_OCR_MODE", if accurate { "accurate" } else { "fast" })
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return out,
    };

    if let Some(mut stdin) = child.stdin.take() {
        let owned: Vec<String> = paths.to_vec();
        std::thread::spawn(move || {
            for p in &owned {
                if writeln!(stdin, "{p}").is_err() {
                    break;
                }
            }
            // stdin dropped here → EOF for the helper
        });
    }

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(r) = serde_json::from_str::<RawResult>(&line) {
                let faces = r
                    .faces
                    .into_iter()
                    .filter_map(|f| {
                        base64::engine::general_purpose::STANDARD
                            .decode(f.embedding.as_bytes())
                            .ok()
                            .map(|embedding| Face {
                                x: f.x,
                                y: f.y,
                                w: f.w,
                                h: f.h,
                                embedding,
                            })
                    })
                    .collect();
                out.insert(
                    r.path,
                    VisionData {
                        labels: r.labels.into_iter().map(|l| l.label).collect(),
                        text: r.text,
                        faces,
                    },
                );
            }
        }
    }
    let _ = child.wait();
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_text_and_labels() {
        let img = match std::env::var("AV_VISION_IMG") {
            Ok(p) => p,
            _ => return, // no fixture provided
        };
        let helper = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin/vision-helper");
        if !helper.exists() {
            return;
        }
        let res = super::run_batch(&helper, &[img.clone()], true);
        let d = res.get(&img).expect("result for image");
        assert!(
            !d.text.is_empty() || !d.labels.is_empty(),
            "expected some labels or text"
        );
    }
}
