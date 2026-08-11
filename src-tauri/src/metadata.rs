use chrono::{Datelike, Local, NaiveDateTime, TimeZone};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Classify a file into a coarse asset kind from its lowercased extension.
pub fn classify(ext_lower: &str) -> &'static str {
    match ext_lower {
        "jpg" | "jpeg" | "jfif" | "png" | "gif" | "heic" | "heif" | "tif" | "tiff" | "bmp"
        | "webp" | "avif" | "psd" | "raw" | "cr2" | "cr3" | "nef" | "arw" | "dng" | "orf"
        | "rw2" | "raf" | "sr2" | "pef" | "nrw" => "image",
        "mp4" | "mov" | "m4v" | "avi" | "mkv" | "webm" | "wmv" | "flv" | "mpg" | "mpeg"
        | "3gp" | "3g2" | "m2ts" | "mts" | "ts" => "video",
        "mp3" | "wav" | "aac" | "flac" | "m4a" | "ogg" | "oga" | "opus" | "aiff" | "aif"
        | "alac" | "wma" | "aifc" => "audio",
        "pdf" => "pdf",
        _ => "other",
    }
}

/// Whether this kind is something the viewer indexes and shows.
pub fn is_media(kind: &str) -> bool {
    matches!(kind, "image" | "video" | "audio" | "pdf")
}

pub struct Capture {
    pub ts: i64,
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

/// Determine the capture timestamp for a file, falling back to `mtime`, and
/// derive the local-calendar year/month/day used for grouping.
pub fn capture_info(path: &Path, kind: &str, mtime: i64) -> Capture {
    let ts = match kind {
        "image" => exif_datetime(path).unwrap_or(mtime),
        "video" => mp4_creation(path).unwrap_or(mtime),
        _ => mtime,
    };
    let local = Local
        .timestamp_opt(ts, 0)
        .single()
        .or_else(|| Local.timestamp_opt(mtime, 0).single());
    match local {
        Some(dt) => Capture {
            ts,
            year: dt.year(),
            month: dt.month(),
            day: dt.day(),
        },
        None => Capture {
            ts,
            year: 1970,
            month: 1,
            day: 1,
        },
    }
}

/// Read EXIF DateTimeOriginal (or fallbacks) from an image. Interpreted as
/// local wall-clock time, since EXIF timestamps carry no timezone.
fn exif_datetime(path: &Path) -> Option<i64> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()?;
    for tag in [
        exif::Tag::DateTimeOriginal,
        exif::Tag::DateTimeDigitized,
        exif::Tag::DateTime,
    ] {
        if let Some(field) = exif.get_field(tag, exif::In::PRIMARY) {
            if let exif::Value::Ascii(ref vec) = field.value {
                if let Some(bytes) = vec.first() {
                    if let Some(ts) = parse_exif_dt(bytes) {
                        return Some(ts);
                    }
                }
            }
        }
    }
    None
}

fn parse_exif_dt(b: &[u8]) -> Option<i64> {
    let s = std::str::from_utf8(b).ok()?.trim();
    let naive = NaiveDateTime::parse_from_str(s, "%Y:%m:%d %H:%M:%S").ok()?;
    Local.from_local_datetime(&naive).single().map(|d| d.timestamp())
}

/// Read the creation time from an MP4/MOV `moov/mvhd` atom.
///
/// Values are seconds since 1904-01-01 UTC. We only read small atom headers and
/// seek across large payloads (like `mdat`), so this stays fast even for large
/// videos where `moov` sits at the end of the file.
fn mp4_creation(path: &Path) -> Option<i64> {
    const EPOCH_1904_TO_1970: i64 = 2_082_844_800;
    let mut f = File::open(path).ok()?;
    let flen = f.metadata().ok()?.len();

    let (moov_start, moov_end) = find_atom(&mut f, 0, flen, b"moov")?;
    let (mvhd_start, _) = find_atom(&mut f, moov_start, moov_end, b"mvhd")?;

    f.seek(SeekFrom::Start(mvhd_start)).ok()?;
    let mut version = [0u8; 1];
    f.read_exact(&mut version).ok()?;
    // skip remaining 3 flag bytes
    f.seek(SeekFrom::Current(3)).ok()?;

    let creation = if version[0] == 1 {
        let mut b = [0u8; 8];
        f.read_exact(&mut b).ok()?;
        u64::from_be_bytes(b) as i64
    } else {
        let mut b = [0u8; 4];
        f.read_exact(&mut b).ok()?;
        u32::from_be_bytes(b) as i64
    };
    if creation == 0 {
        return None;
    }
    let unix = creation - EPOCH_1904_TO_1970;
    if unix <= 0 {
        None
    } else {
        Some(unix)
    }
}

/// Scan atoms in [start, end) at one nesting level, returning the (content
/// start, content end) byte range of the first atom whose type matches.
fn find_atom(f: &mut File, start: u64, end: u64, target: &[u8; 4]) -> Option<(u64, u64)> {
    let mut off = start;
    while off + 8 <= end {
        f.seek(SeekFrom::Start(off)).ok()?;
        let mut hdr = [0u8; 8];
        if f.read_exact(&mut hdr).is_err() {
            break;
        }
        let mut size = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
        let typ = &hdr[4..8];
        let mut header_len = 8u64;
        if size == 1 {
            let mut ext = [0u8; 8];
            f.read_exact(&mut ext).ok()?;
            size = u64::from_be_bytes(ext);
            header_len = 16;
        } else if size == 0 {
            size = end - off;
        }
        if size < header_len || off + size > end {
            break;
        }
        if typ == target {
            return Some((off + header_len, off + size));
        }
        off += size;
    }
    None
}
