import Foundation

/// What the shell hands to the console page. Pure: it only builds script text.
enum ConsoleBridge {
    /// The one place the console looks for the admin key: `sessionStorage['oaa-token']`, read once
    /// when web/lib/state.js loads (test/desktop-shell.test.ts runs the real state.js against this
    /// script). Nothing reads the key from `localStorage`.
    static let sessionKey = "oaa-token"

    /// Entries that earlier versions of the app also wrote. The console never read them; they only
    /// left a copy of the admin key in persistent web storage. They are removed on every page load.
    static let legacyLocalStorageKeys = ["oaa-token", "oaa_token", "oaa_admin_token"]
    static let legacySessionStorageKeys = ["oaa_token"]

    /// The origin (`location.origin`) of the gateway at `port`. A default port is not part of it.
    static func origin(port: Int) -> String {
        port == 80 ? "http://127.0.0.1" : "http://127.0.0.1:\(port)"
    }

    /// Runs at document start, in the main frame only, and only on the gateway's own origin: a page
    /// the window might be sent to must never receive the key. The key goes into `sessionStorage`
    /// (it belongs to the window's page; unlike localStorage it is not persistent web storage), and the copies old
    /// versions left in `localStorage` are deleted. With no key (nothing to inject) it still cleans up.
    static func tokenScript(token: String, origin: String) -> String {
        var body = ""
        if !token.isEmpty {
            body += "  try { sessionStorage.setItem(\(jsString(sessionKey)), \(jsString(token))); } catch (e) {}\n"
        }
        let cleanup =
            legacyLocalStorageKeys.map { "localStorage.removeItem(\(jsString($0)));" }
            + legacySessionStorageKeys.map { "sessionStorage.removeItem(\(jsString($0)));" }
        body += "  try { \(cleanup.joined(separator: " ")) } catch (e) {}\n"
        return "if (location.origin === \(jsString(origin))) {\n\(body)}\n"
    }

    /// A string as a JavaScript string literal (JSON is a subset of JavaScript string syntax).
    static func jsString(_ text: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed, .withoutEscapingSlashes]),
            let literal = String(data: data, encoding: .utf8)
        else { return "\"\"" }
        // U+2028 / U+2029 are legal in JSON strings but older engines reject them in script text.
        return literal.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
}
