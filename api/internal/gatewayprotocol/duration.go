package gatewayprotocol

import "net/http"

// LongRunningOperation identifies streams and transfers whose response headers
// may arrive only after lengthy work. Caller cancellation and gateway lifetime
// limits still apply; ordinary operations keep their short timeouts.
func LongRunningOperation(method, path string) bool {
	if method == http.MethodGet {
		return Streaming(path) || path == "/files/download" || path == "/files/archive" || path == "/logs/download"
	}
	return method == http.MethodPost && (path == "/files/upload" || path == "/files/zip" || path == "/mods/upload" || path == "/mods/install")
}
