import Cocoa
import ApplicationServices

// Press the real Accessibility element at a global desktop point without
// moving the physical cursor.
//
//   hooking <pid> <x> <y>
//
// AXUIElementCopyElementAtPosition performs the native hit-test. The element
// directly under a label is often static text, so the search walks up through
// parents until it finds an enabled object that supports AXPress. It never
// falls back to an unrelated coordinate click.

func jsonString(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) }
            else { out.unicodeScalars.append(scalar) }
        }
    }
    return out + "\""
}

func emit(_ status: String, _ message: String, label: String? = nil) {
    let extra = label.map { ",\"label\":\(jsonString($0))" } ?? ""
    print("{\"status\":\(jsonString(status)),\"message\":\(jsonString(message))\(extra)}")
}

func copyAttr(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}

func textAttr(_ element: AXUIElement, _ key: String) -> String? {
    (copyAttr(element, key) as? String).flatMap { $0.isEmpty ? nil : $0 }
}

func label(_ element: AXUIElement) -> String {
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel",
                kAXValueAttribute, kAXHelpAttribute] {
        if let value = textAttr(element, key as String) { return value }
    }
    return ""
}

func supportsPress(_ element: AXUIElement) -> Bool {
    var values: CFArray?
    guard AXUIElementCopyActionNames(element, &values) == .success,
          let actions = values as? [String] else { return false }
    return actions.contains(kAXPressAction as String)
}

func isEnabled(_ element: AXUIElement) -> Bool {
    (copyAttr(element, kAXEnabledAttribute as String) as? Bool) ?? true
}

func parent(_ element: AXUIElement) -> AXUIElement? {
    guard let value = copyAttr(element, kAXParentAttribute as String),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

func parseArgs() -> (pid: pid_t, x: Float, y: Float)? {
    let args = CommandLine.arguments
    guard args.count == 4,
          let pid = Int32(args[1]),
          let x = Float(args[2]), x.isFinite,
          let y = Float(args[3]), y.isFinite else { return nil }
    return (pid, x, y)
}

func pressElement(pid: pid_t, x: Float, y: Float) {
    guard AXIsProcessTrusted() else {
        emit("error", "Accessibility permission is not enabled")
        return
    }

    let application = AXUIElementCreateApplication(pid)
    var hit: AXUIElement?
    let hitResult = AXUIElementCopyElementAtPosition(application, x, y, &hit)
    guard hitResult == .success, var current = hit else {
        emit("error", "No accessibility element exists at \(Int(x)),\(Int(y))")
        return
    }

    // A hit commonly lands on AXStaticText nested inside its button. Eight
    // ancestors comfortably covers ordinary controls while preventing a bad
    // tree from walking forever.
    for _ in 0..<8 {
        if supportsPress(current) {
            let name = label(current)
            guard isEnabled(current) else {
                emit("error", name.isEmpty ? "The target control is disabled" : "\(name) is disabled", label: name)
                return
            }
            let result = AXUIElementPerformAction(current, kAXPressAction as CFString)
            if result == .success {
                emit("success", "Pressed the control at \(Int(x)),\(Int(y))", label: name)
            } else {
                emit("error", "The target stopped accepting AXPress (code \(result.rawValue))", label: name)
            }
            return
        }
        guard let next = parent(current) else { break }
        current = next
    }

    emit("error", "The element at \(Int(x)),\(Int(y)) is not pressable")
}

if let args = parseArgs() {
    pressElement(pid: args.pid, x: args.x, y: args.y)
} else {
    emit("error", "Usage: hooking <pid> <x> <y>")
}
