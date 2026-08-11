// macOS Vision CLI for Trove. Two modes:
//   vision-helper <image-path>   → one JSON object for that image
//   vision-helper                → read image paths from stdin (one per line),
//                                  process them concurrently (all cores),
//                                  print one JSON line per image (any order)
// JSON: {"path":"…","labels":[{"label":"…","confidence":0.9}],"text":"…"}
import Foundation
import ImageIO
import Vision

let outLock = NSLock()
let MAX_DIM = 2560 // downsample cap — plenty for classification and most OCR
// OCR quality is chosen by the app: "accurate" (default, slower) or "fast".
let fastOCR = ProcessInfo.processInfo.environment["TROVE_OCR_MODE"] == "fast"

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let s = String(data: data, encoding: .utf8)
    else { return }
    outLock.lock()
    print(s)
    outLock.unlock()
}

// Decode a downsampled image straight from disk via ImageIO — much cheaper than
// fully decoding a 12MP+ photo, and it applies the EXIF orientation.
func loadDownsampled(_ path: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil)
    else { return nil }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: MAX_DIM,
        kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
}

// Each call builds its own requests so workers don't share Vision state.
func process(_ path: String) -> [String: Any] {
    guard let cg = loadDownsampled(path) else {
        return ["path": path, "labels": [], "text": ""]
    }
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    let classify = VNClassifyImageRequest()
    let ocr = VNRecognizeTextRequest()
    // .accurate is best for text but ANE-bound (serializes); .fast is CPU-based
    // (parallelizes) and much quicker. Chosen via the app's setting.
    ocr.recognitionLevel = fastOCR ? .fast : .accurate
    ocr.usesLanguageCorrection = !fastOCR

    var labels: [[String: Any]] = []
    var text = ""
    do {
        try handler.perform([classify, ocr])
        if let results = classify.results {
            for o in results where o.confidence > 0.2 {
                labels.append(["label": o.identifier, "confidence": Double(o.confidence)])
                if labels.count >= 8 { break }
            }
        }
        if let results = ocr.results {
            text = results
                .compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: " ")
        }
    } catch {}
    return ["path": path, "labels": labels, "text": text]
}

let args = CommandLine.arguments
if args.count >= 2 {
    emit(process(args[1]))
} else {
    var paths: [String] = []
    while let line = readLine(strippingNewline: true) {
        if !line.isEmpty { paths.append(line) }
    }
    DispatchQueue.concurrentPerform(iterations: paths.count) { i in
        emit(process(paths[i]))
    }
    fflush(stdout)
}
