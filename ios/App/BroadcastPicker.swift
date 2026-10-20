// Apple lets an app start a system-wide broadcast only through the system
// picker (or Control Center). RPSystemBroadcastPickerView is a small icon, so
// it sits in the hierarchy almost invisible and a full-width button taps it.
import ReplayKit
import SwiftUI
import UIKit

struct BroadcastButton: View {
    @State private var picker = BroadcastPickerHolder()

    var body: some View {
        Button {
            picker.open()
        } label: {
            Label("ابدأ البث أو أوقفه", systemImage: "dot.radiowaves.left.and.right")
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .background(PickerHost(picker: picker.view).frame(width: 1, height: 1).opacity(0.02))
    }
}

final class BroadcastPickerHolder {
    /// The extension's bundle id: the app's plus ".broadcast" (project.yml).
    static var extensionID: String { (Bundle.main.bundleIdentifier ?? "") + ".broadcast" }

    let view: RPSystemBroadcastPickerView = {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        picker.preferredExtension = BroadcastPickerHolder.extensionID
        picker.showsMicrophoneButton = true
        return picker
    }()

    func open() {
        for case let button as UIButton in view.subviews {
            button.sendActions(for: .allTouchEvents)
        }
    }
}

private struct PickerHost: UIViewRepresentable {
    let picker: RPSystemBroadcastPickerView

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView { picker }
    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
