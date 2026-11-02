import AppKit
import ApplicationServices
import CoreGraphics

// Pointer ONLY. There are deliberately no click, key, scroll or drag commands.
// Source: https://developer.apple.com/documentation/coregraphics/cgevent
func emit(_ value: [String: Any], _ status: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) { print(text) }
    exit(status)
}
let args = Array(CommandLine.arguments.dropFirst())
if args == ["position"] {
    guard let position = CGEvent(source: nil)?.location else { emit(["ok": false, "error": "Cursor position unavailable"], 1) }
    emit(["ok": true, "x": position.x, "y": position.y])
}
guard args.count == 4, args[0] == "move", let x = Double(args[1]), let y = Double(args[2]), x.isFinite, y.isFinite else {
    emit(["ok": false, "error": "Usage: echo-pointer move finite-x finite-y approved-app | position"], 1)
}
let target = args[3].lowercased()
guard let front = NSWorkspace.shared.frontmostApplication,
      [front.bundleIdentifier, front.localizedName, front.bundleURL?.path].compactMap({ $0?.lowercased() }).contains(target) else {
    emit(["ok": false, "error": "The approved target is no longer frontmost. Reinspect it before moving."], 1)
}
guard AXIsProcessTrusted() else { emit(["ok": false, "error": "Echo pointer extension needs Accessibility permission."], 1) }
// A mouseMoved event during a held button could become an unintended drag.
guard ![CGMouseButton.left, .right, .center].contains(where: { CGEventSource.buttonState(.combinedSessionState, button: $0) }) else {
    emit(["ok": false, "error": "A mouse button is held. Release it before Echo moves the pointer."], 1)
}
var displays = [CGDirectDisplayID](repeating: 0, count: 32)
var displayCount: UInt32 = 0
guard CGGetActiveDisplayList(UInt32(displays.count), &displays, &displayCount) == .success,
      displays.prefix(Int(displayCount)).contains(where: { CGDisplayBounds($0).contains(CGPoint(x: x, y: y)) }) else {
    emit(["ok": false, "error": "Pointer target is outside the active displays."], 1)
}
guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else {
    emit(["ok": false, "error": "Could not create pointer event."], 1)
}
event.post(tap: .cgSessionEventTap)
Thread.sleep(forTimeInterval: 0.02)
guard let actual = CGEvent(source: nil)?.location, abs(actual.x - x) <= 1, abs(actual.y - y) <= 1 else {
    emit(["ok": false, "error": "Pointer did not reach the requested position; input may have been refused or interrupted."], 1)
}
emit(["ok": true, "x": actual.x, "y": actual.y])
