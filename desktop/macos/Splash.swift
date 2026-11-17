import Foundation

/// The page shown in the window while the gateway starts, restarts or cannot start. Pure: it only
/// builds the HTML text.
enum SplashPage {
    /// `status` is one line of progress; `problem` replaces it with a title and an explanation. Both
    /// are escaped here because they carry file paths.
    static func html(
        status: String?, problem: (title: String, body: String)? = nil, lang: ShellLanguage = .current
    ) -> String {
        let detail: String
        if let problem {
            detail = "<div class=\"problem\"><h2>\(htmlEscape(problem.title))</h2><pre>\(htmlEscape(problem.body))</pre></div>"
        } else {
            detail = "<p>\(htmlEscape(status ?? ""))</p>"
        }
        // Brand splash: the O + A interlocked line mark, following the window appearance.
        return """
            <!doctype html>
            <html lang="\(lang.htmlLang)">
            <head>
              <meta charset="utf-8" />
              <style>
                :root { color-scheme: light dark; }
                body {
                  margin: 0;
                  height: 100vh;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  justify-content: center;
                  background: #191919;
                  color: #efefef;
                  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
                  -webkit-font-smoothing: antialiased;
                  user-select: none;
                  cursor: default;
                }
                .drag { position: fixed; inset: 0 0 auto 0; height: 52px; }
                .mark { width: 92px; height: 89px; margin-bottom: 22px; }
                .mark g { fill: none; stroke: currentColor; stroke-width: 8; stroke-linecap: round; stroke-linejoin: round; }
                h1 { margin: 0; font: italic 400 34px/1.1 "Instrument Serif", "Iowan Old Style", Georgia, serif; letter-spacing: -0.01em; }
                .sub { margin: 10px 0 28px 0; color: #b0b0b0; font-size: 13px; letter-spacing: 0.24em; }
                p { display: flex; align-items: center; gap: 8px; margin: 0; color: #bcbcbc; font: 12px ui-monospace, "SF Mono", Menlo, monospace; }
                p::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #81d8d0; animation: tide 1.4s ease-in-out infinite; }
                @keyframes tide { 50% { opacity: 0.3; } }
                .problem { max-width: 560px; padding: 0 28px; text-align: center; }
                .problem h2 { margin: 0 0 12px 0; font-size: 15px; font-weight: 600; }
                .problem pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: #bcbcbc; font: 12px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; user-select: text; cursor: text; }
                @media (prefers-color-scheme: light) {
                  body { background: #ece9e1; color: #132220; }
                  .sub { color: #66726e; }
                  p, .problem pre { color: #5b6864; }
                }
              </style>
            </head>
            <body>
              <div class="drag"></div>
              <svg class="mark" viewBox="40.11 43 175.78 170" aria-hidden="true"><g><path d="M209.89 207L150.11 49L108.57 155"/><path d="M94.7 190.38L88.19 207"/><path d="M143.36 106.65A50 50 0 1 1 119.1 78.6"/></g></svg>
              <h1>Open Agent API</h1>
              <div class="sub">\(L10n.text(.splashTagline, lang: lang))</div>
              \(detail)
              <script>
                document.querySelector('.drag').addEventListener('mousedown', function () {
                  try { window.webkit.messageHandlers.oaa.postMessage({ type: 'drag' }); } catch (e) {}
                });
              </script>
            </body>
            </html>
            """
    }
}
