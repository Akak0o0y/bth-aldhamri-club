package inputcontrol

import (
	"errors"
	"math"
	"regexp"
	"time"
)

type Event struct {
	Kind   string  `json:"kind"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Button int     `json:"button"`
	Down   bool    `json:"down"`
	Code   string  `json:"code"`
	Delta  int     `json:"delta"`
}

type Sink interface {
	Move(float64, float64) error
	Key(string, bool) error
	Button(int, bool) error
	Wheel(int) error
}

var keys = regexp.MustCompile(`^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Enter|Escape|Backspace|Tab|Space|Delete|Insert|Home|End|PageUp|PageDown|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$`)

type Engine struct {
	Sink              Sink
	Session           string
	lastBeat, expires time.Time
	heldKeys          map[string]bool
	heldButtons       map[int]bool
}

func (e *Engine) Enable(session string, now time.Time) error {
	e.Disable()
	if len(session) != 32 {
		return errors.New("invalid session")
	}
	e.Session = session
	e.lastBeat, e.expires = now, now.Add(10*time.Minute)
	e.heldKeys, e.heldButtons = map[string]bool{}, map[int]bool{}
	return nil
}

func (e *Engine) Release() {
	for key := range e.heldKeys {
		_ = e.Sink.Key(key, false)
	}
	for button := range e.heldButtons {
		_ = e.Sink.Button(button, false)
	}
	e.heldKeys, e.heldButtons = map[string]bool{}, map[int]bool{}
}

func (e *Engine) Disable() { e.Release(); e.Session = "" }
func (e *Engine) Heartbeat(session string, now time.Time) {
	if session != "" && session == e.Session {
		e.lastBeat = now
	}
}
func (e *Engine) Expired(now time.Time) bool {
	return e.Session != "" && (now.Sub(e.lastBeat) > 3*time.Second || !now.Before(e.expires))
}

func (e *Engine) Input(session string, event Event, now time.Time) error {
	if e.Session == "" || session != e.Session || e.Expired(now) {
		return errors.New("no active control consent")
	}
	point := !math.IsNaN(event.X) && !math.IsNaN(event.Y) && event.X >= 0 && event.X <= 1 && event.Y >= 0 && event.Y <= 1
	switch event.Kind {
	case "move":
		if !point {
			return errors.New("invalid pointer")
		}
		return e.Sink.Move(event.X, event.Y)
	case "button":
		if !point || event.Button < 0 || event.Button > 2 {
			return errors.New("invalid button")
		}
		if err := e.Sink.Move(event.X, event.Y); err != nil {
			return err
		}
		if e.heldButtons[event.Button] == event.Down {
			return nil
		}
		if err := e.Sink.Button(event.Button, event.Down); err != nil {
			return err
		}
		if event.Down {
			e.heldButtons[event.Button] = true
		} else {
			delete(e.heldButtons, event.Button)
		}
	case "key":
		if !keys.MatchString(event.Code) {
			return errors.New("invalid key")
		}
		if !event.Down && !e.heldKeys[event.Code] {
			return nil
		}
		if err := e.Sink.Key(event.Code, event.Down); err != nil {
			return err
		}
		if event.Down {
			e.heldKeys[event.Code] = true
		} else {
			delete(e.heldKeys, event.Code)
		}
	case "wheel":
		if event.Delta < -1200 || event.Delta > 1200 {
			return errors.New("invalid wheel")
		}
		return e.Sink.Wheel(event.Delta)
	case "reset":
		e.Release()
	default:
		return errors.New("unsupported input")
	}
	return nil
}
