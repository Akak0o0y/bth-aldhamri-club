// Windows input is confined to an attended, single-display desktop session.
// No service, elevation, persistence, clipboard, file access or shell execution.
package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Akak0o0y/bth-aldhamri-club/tools/dhamri/native/internal/inputcontrol"
	"golang.org/x/sys/windows"
	"os"
	"runtime"
	"strconv"
	"time"
	"unsafe"
)

var user32 = windows.NewLazySystemDLL("user32.dll")
var sendInput = user32.NewProc("SendInput")
var engine *inputcontrol.Engine
var window uintptr

func emit(value any)            { _ = json.NewEncoder(os.Stdout).Encode(value) }
func wide(value string) *uint16 { p, _ := windows.UTF16PtrFromString(value); return p }
func call(name string, args ...uintptr) uintptr {
	r, _, _ := user32.NewProc(name).Call(args...)
	return r
}

type input struct {
	Type uint32
	Pad  uint32
	Data [32]byte
}

func inject(in input) error {
	r, _, _ := sendInput.Call(1, uintptr(unsafe.Pointer(&in)), unsafe.Sizeof(in))
	if r != 1 {
		return errors.New("Windows refused input; control stopped")
	}
	return nil
}

type desktop struct{}

func (desktop) Move(x, y float64) error {
	in := input{}
	binary.LittleEndian.PutUint32(in.Data[0:], uint32(x*65535))
	binary.LittleEndian.PutUint32(in.Data[4:], uint32(y*65535))
	binary.LittleEndian.PutUint32(in.Data[12:], 0x8001)
	return inject(in)
}
func (desktop) Button(button int, down bool) error {
	flags := []uint32{2, 32, 8}[button]
	if !down {
		flags *= 2
	}
	in := input{}
	binary.LittleEndian.PutUint32(in.Data[12:], flags)
	return inject(in)
}
func (desktop) Wheel(delta int) error {
	in := input{}
	binary.LittleEndian.PutUint32(in.Data[8:], uint32(int32(delta)))
	binary.LittleEndian.PutUint32(in.Data[12:], 0x800)
	return inject(in)
}
func virtualKey(code string) uint16 {
	if len(code) == 4 && code[:3] == "Key" {
		return uint16(code[3])
	}
	if len(code) == 6 && code[:5] == "Digit" {
		return uint16(code[5])
	}
	if len(code) >= 2 && code[0] == 'F' {
		if n, err := strconv.Atoi(code[1:]); err == nil && n >= 1 && n <= 12 {
			return uint16(0x70 + n - 1)
		}
	}
	return map[string]uint16{"ArrowLeft": 0x25, "ArrowUp": 0x26, "ArrowRight": 0x27, "ArrowDown": 0x28, "Enter": 0x0d, "Escape": 0x1b, "Backspace": 8, "Tab": 9, "Space": 0x20, "Delete": 0x2e, "Insert": 0x2d, "Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22, "ShiftLeft": 0xa0, "ShiftRight": 0xa1, "ControlLeft": 0xa2, "ControlRight": 0xa3, "AltLeft": 0xa4, "AltRight": 0xa5, "MetaLeft": 0x5b, "MetaRight": 0x5c, "CapsLock": 0x14, "Minus": 0xbd, "Equal": 0xbb, "BracketLeft": 0xdb, "BracketRight": 0xdd, "Backslash": 0xdc, "Semicolon": 0xba, "Quote": 0xde, "Backquote": 0xc0, "Comma": 0xbc, "Period": 0xbe, "Slash": 0xbf}[code]
}
func (desktop) Key(code string, down bool) error {
	vk := virtualKey(code)
	if vk == 0 {
		return errors.New("unknown key")
	}
	scan := call("MapVirtualKeyW", uintptr(vk), 0)
	flags := uint32(8)
	switch code {
	case "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "ControlRight", "AltRight", "MetaLeft", "MetaRight":
		flags |= 1
	}
	if !down {
		flags |= 2
	}
	in := input{Type: 1}
	binary.LittleEndian.PutUint16(in.Data[2:], uint16(scan))
	binary.LittleEndian.PutUint32(in.Data[4:], flags)
	return inject(in)
}

type wndClass struct {
	Size, Style                        uint32
	Proc                               uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	Menu, Class                        *uint16
	SmallIcon                          uintptr
}
type point struct{ X, Y int32 }
type message struct {
	Window  uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   point
	Private uint32
}

func revoke() {
	if engine != nil {
		engine.Disable()
	}
	if window != 0 {
		call("ShowWindow", window, 0)
	}
	emit(map[string]string{"t": "revoked"})
}
func windowProc(hwnd uintptr, msg uint32, wparam, lparam uintptr) uintptr {
	if msg == 0x10 || (msg == 0x111 && wparam&0xffff == 1) {
		revoke()
		return 0
	}
	r, _, _ := user32.NewProc("DefWindowProcW").Call(hwnd, uintptr(msg), wparam, lparam)
	return r
}
func makeIndicator() error {
	var instance windows.Handle
	if err := windows.GetModuleHandleEx(0, nil, &instance); err != nil {
		return err
	}
	class := wide("DhamriAttendedControl")
	wc := wndClass{Proc: windows.NewCallback(windowProc), Instance: uintptr(instance), Background: 6, Class: class}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if call("RegisterClassExW", uintptr(unsafe.Pointer(&wc))) == 0 {
		return errors.New("could not register control indicator")
	}
	window = call("CreateWindowExW", 8, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(wide("Dhamri - REMOTE CONTROL ACTIVE"))), 0x00c00000|0x00080000, 20, 20, 590, 120, 0, 0, uintptr(instance), 0)
	if window == 0 {
		return errors.New("could not show control indicator")
	}
	label := call("CreateWindowExW", 0, uintptr(unsafe.Pointer(wide("STATIC"))), uintptr(unsafe.Pointer(wide("Mouse + keyboard shared. Ctrl+Alt+F10 stops control."))), 0x50000000, 12, 10, 550, 25, window, 0, uintptr(instance), 0)
	button := call("CreateWindowExW", 0, uintptr(unsafe.Pointer(wide("BUTTON"))), uintptr(unsafe.Pointer(wide("Stop control"))), 0x50010000, 12, 40, 180, 28, window, 1, uintptr(instance), 0)
	if label == 0 || button == 0 {
		return errors.New("control indicator incomplete")
	}
	return nil
}

type command struct {
	T, Session string
	Event      inputcontrol.Event
}

func run() error {
	if runtime.GOARCH != "amd64" {
		return errors.New("Windows x64 is required")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	call("SetProcessDPIAware")
	if call("GetSystemMetrics", 80) != 1 {
		return errors.New("Remote control currently requires one active display. Disconnect external monitors first.")
	}
	width, height := call("GetSystemMetrics", 0), call("GetSystemMetrics", 1)
	if width < 320 || height < 180 {
		return errors.New("interactive display unavailable")
	}
	if call("RegisterHotKey", 0, 1, 0x4003, 0x79) == 0 {
		return errors.New("Ctrl+Alt+F10 is unavailable; remote control was not enabled")
	}
	defer call("UnregisterHotKey", 0, 1)
	engine = &inputcontrol.Engine{Sink: desktop{}}
	defer engine.Disable()
	if err := makeIndicator(); err != nil {
		return err
	}
	defer call("DestroyWindow", window)
	emit(map[string]any{"t": "ready", "display": map[string]any{"width": width, "height": height}})
	commands := make(chan command, 64)
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 4096)
		for scanner.Scan() {
			var c command
			if json.Unmarshal(scanner.Bytes(), &c) != nil {
				return
			}
			select {
			case commands <- c:
			default:
				return
			}
		}
	}()
	ticker := time.NewTicker(8 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ended:
			return nil
		case c := <-commands:
			switch c.T {
			case "enable":
				if err := engine.Enable(c.Session, time.Now()); err != nil {
					return err
				}
				call("ShowWindow", window, 4)
			case "disable":
				engine.Disable()
				call("ShowWindow", window, 0)
			case "heartbeat":
				engine.Heartbeat(c.Session, time.Now())
			case "input":
				if err := engine.Input(c.Session, c.Event, time.Now()); err != nil {
					revoke()
				}
			default:
				return errors.New("unknown control command")
			}
		case <-ticker.C:
			if engine.Expired(time.Now()) {
				revoke()
			}
			if call("GetSystemMetrics", 80) != 1 || call("GetSystemMetrics", 0) != width || call("GetSystemMetrics", 1) != height {
				return errors.New("display changed; control stopped")
			}
			var msg message
			for call("PeekMessageW", uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1) != 0 {
				if msg.Message == 0x312 {
					revoke()
				}
				call("TranslateMessage", uintptr(unsafe.Pointer(&msg)))
				call("DispatchMessageW", uintptr(unsafe.Pointer(&msg)))
			}
		}
	}
}
func main() {
	if err := run(); err != nil {
		emit(map[string]string{"t": "error", "message": fmt.Sprint(err)})
		os.Exit(1)
	}
}
