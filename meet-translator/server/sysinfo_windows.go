//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// memoryStatusEx は GlobalMemoryStatusEx が埋める MEMORYSTATUSEX 構造体。
// dwLength フィールドを事前にセットしてから呼び出す。
type memoryStatusEx struct {
	dwLength                uint32
	dwMemoryLoad            uint32
	ullTotalPhys            uint64
	ullAvailPhys            uint64
	ullTotalPageFile        uint64
	ullAvailPageFile        uint64
	ullTotalVirtual         uint64
	ullAvailVirtual         uint64
	ullAvailExtendedVirtual uint64
}

// totalSystemRAMBytes は GlobalMemoryStatusEx を使って Windows の総物理 RAM バイト数を返す。
// 取得できない場合は 0 を返す。
func totalSystemRAMBytes() uint64 {
	dll, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return 0
	}
	proc, err := dll.FindProc("GlobalMemoryStatusEx")
	if err != nil {
		return 0
	}
	var ms memoryStatusEx
	ms.dwLength = uint32(unsafe.Sizeof(ms))
	ret, _, _ := proc.Call(uintptr(unsafe.Pointer(&ms)))
	if ret == 0 {
		return 0
	}
	return ms.ullTotalPhys
}
