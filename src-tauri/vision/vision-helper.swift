// macOS Vision CLI for Trove. Two modes:
//   vision-helper <image-path>   → one JSON object for that image
//   vision-helper                → read image paths from stdin (one per line),
//                                  process them concurrently (all cores),
//                                  print one JSON line per image (any order)
// JSON: {"path":"…","labels":[{"label":"…","confidence":0.9}],"text":"…"}
import CoreGraphics
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
    let faceReq = VNDetectFaceRectanglesRequest()

    var labels: [[String: Any]] = []
    var text = ""
    var faces: [[String: Any]] = []
    do {
        try handler.perform([classify, ocr, faceReq])
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
        faces = detectFaces(faceReq.results ?? [], in: cg)
    } catch {}
    return ["path": path, "labels": labels, "text": text, "faces": faces]
}

// For each detected face: a top-left-origin normalized box plus an embedding
// (Vision feature print of a tight crop, base64 of its float bytes).
func detectFaces(_ observations: [VNFaceObservation], in cg: CGImage) -> [[String: Any]] {
    let W = CGFloat(cg.width)
    let H = CGFloat(cg.height)
    var out: [[String: Any]] = []
    for f in observations {
        let b = f.boundingBox // normalized, origin bottom-left
        // Stored box (top-left origin) for the thumbnail.
        let sx = Double(b.origin.x)
        let sw = Double(b.width)
        let sh = Double(b.height)
        let sy = Double(1 - (b.origin.y + b.height))

        // Crop with margin (still bottom-left) → pixel rect (top-left) for print.
        let m: CGFloat = 0.25
        let cx = max(0, b.origin.x - b.width * m)
        let cyb = max(0, b.origin.y - b.height * m)
        let cw = min(1 - cx, b.width * (1 + 2 * m))
        let ch = min(1 - cyb, b.height * (1 + 2 * m))
        let rect = CGRect(
            x: Int(cx * W),
            y: Int((1 - (cyb + ch)) * H),
            width: max(1, Int(cw * W)),
            height: max(1, Int(ch * H))
        )
        guard let crop = cg.cropping(to: rect) else { continue }

        let fpReq = VNGenerateImageFeaturePrintRequest()
        let fh = VNImageRequestHandler(cgImage: crop, options: [:])
        do {
            try fh.perform([fpReq])
            if let fp = fpReq.results?.first as? VNFeaturePrintObservation {
                out.append([
                    "x": sx, "y": sy, "w": sw, "h": sh,
                    "embedding": fp.data.base64EncodedString(),
                ])
            }
        } catch {}
    }
    return out
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
