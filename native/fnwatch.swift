import Cocoa
import CoreGraphics

// Wake Echo with the Fn (globe) key.
//
//   fnwatch
//
// Prints a line "fn" on stdout every time Fn is TAPPED ON ITS OWN, and nothing
// otherwise. Runs until killed.
//
// Why a native helper at all: Electron's globalShortcut takes an accelerator,
// and Fn is not one — the accelerator grammar has no Fn modifier, because Fn
// is handled below the window server and never reaches an app as a normal
// key. A CGEventTap is the only way to see it, and it needs Accessibility
// permission, which Echo already asks for to move the mouse and type.
//
// "On its own" is the whole difficulty. Fn is a real modifier: Fn+F5, Fn+left
// for Home, Fn+delete for forward-delete. Waking on every Fn press would make
// Echo start listening every time the user adjusted the volume. So a tap only
// counts when Fn goes down and comes back up with NO other key pressed in
// between, no other modifier held with it, and inside a short window. Holding
// Fn as a modifier therefore never wakes anything, because the key it modifies
// arrives while Fn is still down and disqualifies the press.
//
// macOS may also claim a bare Fn press itself (System Settings > Keyboard >
// "Press globe key to"). That setting runs alongside this one; set it to
// "Do Nothing" to avoid the emoji picker opening every time Echo wakes.

/// A press longer than this is someone holding Fn, not tapping it.
let tapWindow: CFAbsoluteTime = 0.4

var fnDownAt: CFAbsoluteTime?
/// Set when anything else happens while Fn is down, which disqualifies the press.
var usedAsModifier = false

func note(_ message: String) {
    FileHandle.standardError.write(("[fnwatch] " + message + "\n").data(using: .utf8)!)
}

/// Held so the callback can re-enable the tap if the system disables it.
var tapRef: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
    // The tap is disabled by the system if it ever runs too slowly, and a
    // disabled tap goes silent rather than erroring. Turn it back on.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = tapRef { CGEvent.tapEnable(tap: tap, enable: true) }
        note("tap re-enabled after the system disabled it")
        return Unmanaged.passUnretained(event)
    }

    if type == .keyDown || type == .leftMouseDown || type == .rightMouseDown || type == .scrollWheel {
        // Fn is being used to modify something, or the user moved on.
        if fnDownAt != nil { usedAsModifier = true }
        return Unmanaged.passUnretained(event)
    }

    if type == .flagsChanged {
        let flags = event.flags
        let others: CGEventFlags = [.maskCommand, .maskShift, .maskControl, .maskAlternate, .maskHelp]
        if flags.contains(.maskSecondaryFn) {
            // Fn down. A chord that already holds another modifier is not a tap.
            if flags.intersection(others).isEmpty {
                fnDownAt = CFAbsoluteTimeGetCurrent()
                usedAsModifier = false
            } else {
                fnDownAt = nil
            }
        } else if let down = fnDownAt {
            // Fn up. Arrow and function keys also carry the Fn flag on this
            // keyboard, but they arrive as keyDown and have already set
            // usedAsModifier, so only a bare tap reaches this line.
            if !usedAsModifier && CFAbsoluteTimeGetCurrent() - down < tapWindow {
                print("fn")
                fflush(stdout)
            }
            fnDownAt = nil
        }
    }
    return Unmanaged.passUnretained(event)
}

let mask = (1 << CGEventType.flagsChanged.rawValue)
    | (1 << CGEventType.keyDown.rawValue)
    | (1 << CGEventType.leftMouseDown.rawValue)
    | (1 << CGEventType.rightMouseDown.rawValue)
    | (1 << CGEventType.scrollWheel.rawValue)

// listenOnly: this must never swallow or alter a key. If Echo's tap dies the
// keyboard keeps working exactly as before.
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(mask),
    callback: callback,
    userInfo: nil
) else {
    note("could not create the event tap — grant Accessibility permission to the app that launches Echo")
    exit(1)
}
tapRef = tap

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
note("watching for a bare Fn tap")
CFRunLoopRun()
