package main

import "testing"

func TestLocalEndpoint(t *testing.T) {
	for _, value := range []string{"https://example.com/whip", "http://user:secret@127.0.0.1:42/whip", "http://127.0.0.1/whip", "file:///x", "http://0.0.0.0:42/whip"} {
		if _, err := localEndpoint(value); err == nil {
			t.Fatalf("accepted unsafe endpoint %q", value)
		}
	}
	if _, err := localEndpoint("http://127.0.0.1:54321/nonce/whip"); err != nil {
		t.Fatal(err)
	}
}
