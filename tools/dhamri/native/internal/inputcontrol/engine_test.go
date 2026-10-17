package inputcontrol

import (
	"strings"
	"testing"
	"time"
)

type fakeSink struct{ down, up, moves int }

func (s *fakeSink) Move(float64, float64) error { s.moves++; return nil }
func (s *fakeSink) Key(_ string, down bool) error {
	if down {
		s.down++
	} else {
		s.up++
	}
	return nil
}
func (s *fakeSink) Button(_ int, down bool) error {
	if down {
		s.down++
	} else {
		s.up++
	}
	return nil
}
func (s *fakeSink) Wheel(int) error { return nil }
func TestConsentAndRelease(t *testing.T) {
	sink := &fakeSink{}
	e := &Engine{Sink: sink}
	now := time.Now()
	session := strings.Repeat("a", 32)
	if e.Input(session, Event{Kind: "key", Code: "KeyA", Down: true}, now) == nil {
		t.Fatal("input before consent")
	}
	if err := e.Enable(session, now); err != nil {
		t.Fatal(err)
	}
	if e.Input("another", Event{Kind: "key", Code: "KeyA", Down: true}, now) == nil {
		t.Fatal("wrong session")
	}
	for _, event := range []Event{{Kind: "key", Code: "ControlLeft", Down: true}, {Kind: "button", Button: 0, Down: true, X: 0.5, Y: 0.5}} {
		if err := e.Input(session, event, now); err != nil {
			t.Fatal(err)
		}
	}
	e.Disable()
	if sink.up != 2 || e.Session != "" {
		t.Fatal("held inputs not released")
	}
	if e.Input(session, Event{Kind: "move"}, now) == nil {
		t.Fatal("stale consent reused")
	}
}
func TestWatchdogAndValidation(t *testing.T) {
	e := &Engine{Sink: &fakeSink{}}
	now := time.Now()
	session := strings.Repeat("b", 32)
	_ = e.Enable(session, now)
	for _, event := range []Event{{Kind: "exec", Code: "cmd"}, {Kind: "key", Code: "made-up"}, {Kind: "move", X: 2}, {Kind: "wheel", Delta: 50000}} {
		if e.Input(session, event, now) == nil {
			t.Fatalf("accepted %+v", event)
		}
	}
	e.Heartbeat("wrong", now.Add(2*time.Second))
	if !e.Expired(now.Add(4 * time.Second)) {
		t.Fatal("wrong-session heartbeat refreshed lease")
	}
	_ = e.Enable(session, now)
	e.Heartbeat(session, now.Add(2*time.Second))
	if e.Expired(now.Add(4 * time.Second)) {
		t.Fatal("valid heartbeat failed")
	}
	e.Heartbeat(session, now.Add(11*time.Minute))
	if !e.Expired(now.Add(11 * time.Minute)) {
		t.Fatal("consent did not expire")
	}
}
