package main

import (
	"golang.org/x/sys/windows"
	"os"
	"runtime"
	"testing"
	"time"
	"unsafe"
)

func TestWindowsInputLayout(t *testing.T) {
	if unsafe.Sizeof(input{}) != 40 {
		t.Fatal("INPUT must be 40 bytes on Windows x64")
	}
	for _, key := range []string{"KeyA", "Digit5", "F12", "ControlLeft", "ArrowDown", "Slash"} {
		if virtualKey(key) == 0 {
			t.Fatalf("missing mapping: %s", key)
		}
	}
	if virtualKey("exec") != 0 {
		t.Fatal("invalid key mapped")
	}
}

// Opt-in desktop integration: the only keystroke goes into this test's own
// edit control. Abort before injection if Windows does not grant it focus.
func TestSendInputIntoOwnedWindow(t *testing.T) {
	if os.Getenv("DHAMRI_WINDOWS_INPUT_TEST") != "1" {
		t.Skip("interactive owned-window test")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	old := call("GetForegroundWindow")
	var instance windows.Handle
	if err := windows.GetModuleHandleEx(0, nil, &instance); err != nil {
		t.Fatal(err)
	}
	parent := call("CreateWindowExW", 0, uintptr(unsafe.Pointer(wide("STATIC"))), uintptr(unsafe.Pointer(wide("Dhamri input integration test"))), 0x10c80000, 200, 200, 500, 160, 0, 0, uintptr(instance), 0)
	if parent == 0 {
		t.Fatal("test window failed")
	}
	defer func() {
		call("DestroyWindow", parent)
		if old != 0 {
			call("SetForegroundWindow", old)
		}
	}()
	edit := call("CreateWindowExW", 0, uintptr(unsafe.Pointer(wide("EDIT"))), uintptr(unsafe.Pointer(wide(""))), 0x50810000, 20, 20, 400, 35, parent, 0, uintptr(instance), 0)
	if edit == 0 {
		t.Fatal("test input failed")
	}
	call("SetForegroundWindow", parent)
	call("SetFocus", edit)
	var msg message
	pump := func() {
		for call("PeekMessageW", uintptr(unsafe.Pointer(&msg)), 0, 0, 0, 1) != 0 {
			call("TranslateMessage", uintptr(unsafe.Pointer(&msg)))
			call("DispatchMessageW", uintptr(unsafe.Pointer(&msg)))
		}
	}
	pump()
	if call("GetForegroundWindow") != parent || call("GetFocus") != edit {
		t.Fatal("Windows did not focus the owned test window; no input sent")
	}
	// VK_A becomes the physical key for the active layout, so assert one
	// character arrived without changing the user's keyboard layout.
	if err := (desktop{}).Key("KeyA", true); err != nil {
		t.Fatal(err)
	}
	if err := (desktop{}).Key("KeyA", false); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		pump()
		if call("GetWindowTextLengthW", edit) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("SendInput did not reach the owned edit control")
}
