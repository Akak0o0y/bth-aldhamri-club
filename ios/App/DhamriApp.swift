// The host app: sign in with the site's streamer account, pick the quality,
// and start the broadcast. The broadcast itself runs in the Broadcast Upload
// Extension (ios/Broadcast), which iOS keeps alive while the screen is shared.
import SwiftUI

@main
struct DhamriApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                // The site is Arabic and right-to-left; so is the app.
                .environment(\.layoutDirection, .rightToLeft)
                .tint(Color(red: 0.84, green: 0.67, blue: 0.30))
                .preferredColorScheme(.dark)
        }
    }
}
