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


/// Derive local-calendar year/month/day from a unix timestamp.
pub fn ymd(ts: i64, fallback: i64) -> (i32, u32, u32) {
    let dt = Local
        .timestamp_opt(ts, 0)
        .single()
        .or_else(|| Local.timestamp_opt(fallback, 0).single());
    match dt {
        Some(d) => (d.year(), d.month(), d.day()),
        None => (1970, 1, 1),
    }
}

#[derive(Default)]
pub struct ImageExif {
    pub datetime: Option<i64>,
    pub camera: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Read capture time, camera make/model and pixel dimensions from an image's
/// EXIF in a single pass.
pub fn extract_exif(path: &Path) -> ImageExif {
    let mut out = ImageExif::default();
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return out,
    };
    let mut reader = BufReader::new(file);
    let exif = match exif::Reader::new().read_from_container(&mut reader) {
        Ok(e) => e,
        Err(_) => return out,
    };

    for tag in [
        exif::Tag::DateTimeOriginal,
        exif::Tag::DateTimeDigitized,
        exif::Tag::DateTime,
    ] {
        if let Some(field) = exif.get_field(tag, exif::In::PRIMARY) {
            if let exif::Value::Ascii(ref vec) = field.value {
                if let Some(ts) = vec.first().and_then(|b| parse_exif_dt(b)) {
                    out.datetime = Some(ts);
                    break;
                }
            }
        }
    }

    let make = str_field(&exif, exif::Tag::Make);
    let model = str_field(&exif, exif::Tag::Model);
    out.camera = match (make, model) {
        (Some(mk), Some(md)) => Some(combine_camera(&mk, &md)),
        (None, Some(md)) => Some(md),
        (Some(mk), None) => Some(mk),
        _ => None,
    };

    out.width = uint_field(&exif, exif::Tag::PixelXDimension)
        .or_else(|| uint_field(&exif, exif::Tag::ImageWidth));
    out.height = uint_field(&exif, exif::Tag::PixelYDimension)
        .or_else(|| uint_field(&exif, exif::Tag::ImageLength));
    out
}

fn str_field(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    if let exif::Value::Ascii(ref v) = field.value {
        let s = v
            .first()
            .and_then(|b| std::str::from_utf8(b).ok())?
            .trim()
            .trim_end_matches('\0')
            .trim()
            .to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    } else {
        None
    }
}

fn uint_field(exif: &exif::Exif, tag: exif::Tag) -> Option<u32> {
    let field = exif.get_field(tag, exif::In::PRIMARY)?;
    match &field.value {
        exif::Value::Short(v) => v.first().map(|x| *x as u32),
        exif::Value::Long(v) => v.first().copied(),
        _ => None,
    }
}

fn combine_camera(make: &str, model: &str) -> String {
    if model.to_lowercase().starts_with(&make.to_lowercase()) {
        model.to_string()
    } else {
        format!("{make} {model}")
    }
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
pub fn mp4_creation(path: &Path) -> Option<i64> {
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
