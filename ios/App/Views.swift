import SwiftUI
import UIKit
import DhamriCore

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var phase

    var body: some View {
        NavigationStack {
            Group {
                if model.session == nil { LoginView() } else { ChannelView() }
            }
            .navigationTitle("بث الضمري")
        }
        .onAppear { model.startWatching() }
        .task { await model.refresh() }
        .onChange(of: phase) { phase in
            guard phase == .active else { return }
            model.reload()
            Task { await model.refresh() }
        }
    }
}

struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @State private var name = ""
    @State private var pass = ""

    private var ready: Bool {
        !model.busy && !name.trimmingCharacters(in: .whitespaces).isEmpty && !pass.isEmpty
    }

    var body: some View {
        Form {
            Section {
                TextField("اسم المستخدم", text: $name)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("كلمة المرور", text: $pass)
                    .textContentType(.password)
                    .onSubmit(submit)
            } header: {
                Text("حساب المذيع نفسه الذي تدخل به في الموقع")
            }
            if let error = model.error {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                Button(action: submit) {
                    if model.busy { ProgressView() } else { Text("دخول") }
                }
                .disabled(!ready)
            } footer: {
                Text("المشاهدة لا تحتاج حساباً. للحصول على حساب مذيع اطلب رابط دعوة من صاحب المجلس.")
            }
        }
    }

    private func submit() {
        guard ready else { return }
        Task { await model.login(name: name, pass: pass) }
    }
}

struct ChannelView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Form {
            if let session = model.session, let channel = model.channel {
                Section("الحساب") {
                    LabeledContent("المذيع", value: session.name)
                    LabeledContent("القناة", value: channel.room)
                }

                Section {
                    BroadcastButton()
                    StatusRow(status: model.status)
                } header: {
                    Text("البث")
                } footer: {
                    Text("أو من مركز التحكم: اضغط مطولاً على زر تسجيل الشاشة، اختر «بث الضمري» ثم «بدء البث». زر الميكروفون في نفس الشاشة يضيف صوتك، وصوت الألعاب والتطبيقات يُرسل تلقائياً.")
                }

                Section {
                    Picker("الدقة", selection: $model.settings.preset) {
                        ForEach(QualityPreset.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    Picker("عند ضعف الشبكة", selection: $model.settings.hint) {
                        Text("حافظ على الوضوح").tag(ContentHint.detail)
                        Text("حافظ على السلاسة").tag(ContentHint.motion)
                    }
                    LabeledContent("المعدل", value: String(format: "%ld إطار · %.1f Mbps", model.settings.fps, Double(model.settings.videoKbps) / 1000))
                } header: {
                    Text("الجودة")
                } footer: {
                    Text("الوضوح للنصوص والشاشات، والسلاسة للألعاب. التغيير يسري على البث القادم.")
                }

                Section("الروابط") {
                    CopyRow(title: "رابط المشاهدة", url: channel.watchURL())
                    CopyRow(title: "رابط WHIP (للبرامج مثل OBS)", url: channel.whipURL)
                    ShareLink(item: channel.watchURL()) {
                        Label("شارك رابط المشاهدة", systemImage: "square.and.arrow.up")
                    }
                }

                Section {
                    Button("تسجيل الخروج", role: .destructive) { model.signOut() }
                }
            }
        }
    }
}

struct StatusRow: View {
    let status: BroadcastStatus?

    private var state: BroadcastStatus.State {
        guard let status else { return .idle }
        // A status the extension stopped refreshing belongs to a broadcast
        // that is over.
        if status.isStale, status.state != .error { return .idle }
        return status.state
    }

    private var label: String {
        switch state {
        case .idle: return "لا يوجد بث الآن"
        case .connecting: return "جارٍ الاتصال بسيرفر البث…"
        case .live: return "على الهواء"
        case .reconnecting: return "جارٍ إعادة الاتصال…"
        case .paused: return "البث متوقف مؤقتاً"
        case .error: return "تعذر البث"
        }
    }

    private var color: Color {
        switch state {
        case .live: return .red
        case .connecting, .reconnecting, .paused: return .orange
        case .error: return .yellow
        case .idle: return .gray
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(color).frame(width: 10, height: 10)
                Text(label)
            }
            if let message = status?.message, !message.isEmpty, state != .idle {
                Text(message).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct CopyRow: View {
    let title: String
    let url: URL
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = url.absoluteString
            copied = true
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(copied ? "تم النسخ" : title).font(.subheadline)
                Text(url.absoluteString)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .environment(\.layoutDirection, .leftToRight)
            }
        }
    }
}
