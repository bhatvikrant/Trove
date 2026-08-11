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
struct RawResult {
    path: String,
    #[serde(default)]
    labels: Vec<RawLabel>,
    #[serde(default)]
    text: String,
}

pub struct VisionData {
    pub labels: Vec<String>,
    pub text: String,
}

/// Run the macOS Vision helper over a batch of image paths (piped via stdin,
/// one per line) and collect path → {labels, text}. A writer thread feeds
/// stdin while we read stdout, so large batches can't deadlock on pipe buffers.
pub fn run_batch(helper: &Path, paths: &[String]) -> HashMap<String, VisionData> {
    let mut out = HashMap::new();
    if paths.is_empty() {
        return out;
    }
    let mut child = match Command::new(helper)
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
                out.insert(
                    r.path,
                    VisionData {
                        labels: r.labels.into_iter().map(|l| l.label).collect(),
                        text: r.text,
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
        let res = super::run_batch(&helper, &[img.clone()]);
        let d = res.get(&img).expect("result for image");
        assert!(
            !d.text.is_empty() || !d.labels.is_empty(),
            "expected some labels or text"
        );
    }
}
