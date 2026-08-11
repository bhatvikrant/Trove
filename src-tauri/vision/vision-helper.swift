// macOS Vision CLI for Trove. Two modes:
//   vision-helper <image-path>     → one JSON object for that image
//   vision-helper                  → reads image paths from stdin (one per line),
//                                     prints one JSON line per image
// JSON: {"path":"…","labels":[{"label":"…","confidence":0.9}],"text":"…"}
// Batch/stdin mode loads the Vision models once and amortizes them over many images.
import Foundation
import Vision
import AppKit

func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
        let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{}")
    }
    fflush(stdout)
}

let classify = VNClassifyImageRequest()
let ocr = VNRecognizeTextRequest()
ocr.recognitionLevel = .accurate
ocr.usesLanguageCorrection = true

func process(_ path: String) {
    guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else {
        emit(["path": path, "labels": [], "text": ""])
        return
    }
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
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
    emit(["path": path, "labels": labels, "text": text])
}

let args = CommandLine.arguments
if args.count >= 2 {
    process(args[1])
} else {
    while let line = readLine(strippingNewline: true) {
        if !line.isEmpty { process(line) }
    }
}
