# ──────────────────────────────────────────────────────────────────────────────
# meet-translator-server Makefile
#
# Usage:
#   make                   auto-detect GPU and build
#   make GPU=cuda          force NVIDIA CUDA
#   make GPU=metal         force Apple Metal
#   make GPU=cpu           CPU only
#   make rebuild           re-run cmake + go build (keep vendor clone)
#   make clean             remove binary + cmake build
#   make distclean         remove vendor as well
# ──────────────────────────────────────────────────────────────────────────────

# pinned versions
# llama.cpp: PrismML fork (adds Q1_0_g128 1-bit quantization support for Bonsai-8B)
LLAMA_VERSION   := v0.0.2-prism
LLAMA_REPO      := https://github.com/PrismML-Eng/llama.cpp.git
WHISPER_VERSION := v1.8.4

OS_NAME   := $(shell uname -s 2>/dev/null || echo Windows_NT)
ARCH_NAME := $(shell uname -m 2>/dev/null || echo x86_64)

# normalize MSYS2/MinGW/Cygwin uname (returns MINGW.../MSYS.../CYGWIN...) to Windows_NT
ifneq ($(filter MINGW% MSYS% CYGWIN%,$(OS_NAME)),)
  OS_NAME := Windows_NT
endif

VENDOR_DIR  := vendor
BUILD_DIR   := $(VENDOR_DIR)/build
LLAMA_DIR   := $(VENDOR_DIR)/llama.cpp
WHISPER_DIR := $(VENDOR_DIR)/whisper.cpp

# ── GPU target detection ──────────────────────────────────────────────────────
GPU ?= auto

ifeq ($(GPU),auto)
  ifeq ($(OS_NAME),Darwin)
    GPU_TARGET := metal
  else ifneq ($(shell which nvcc 2>/dev/null),)
    GPU_TARGET := cuda
  else
    GPU_TARGET := cpu
  endif
else
  GPU_TARGET := $(GPU)
endif

# ── cmake GPU flags & Go build tags ──────────────────────────────────────────
CMAKE_GPU_FLAGS :=
GO_TAGS         :=
CGO_EXTRA_LDFLAGS :=

ifeq ($(GPU_TARGET),metal)
  # GGML_NATIVE=OFF: avoid i8mm/sve/sme CPU feature errors on GitHub Actions runners
  CMAKE_GPU_FLAGS    := -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=ON -DGGML_NATIVE=OFF
  GO_TAGS            := metal
  CGO_EXTRA_LDFLAGS  := -framework Foundation -framework Metal -framework MetalKit \
	-framework Accelerate -framework CoreGraphics

else ifeq ($(GPU_TARGET),cuda)
  CMAKE_GPU_FLAGS    := -DGGML_CUDA=ON -DGGML_CUDA_F16=ON
  GO_TAGS            := cuda

else
  # disable native CPU optimizations (avoids i8mm issue on macOS arm64 runners)
  CMAKE_GPU_FLAGS    := -DGGML_METAL=OFF -DGGML_BLAS=OFF -DGGML_NATIVE=OFF
endif

# ── include/library paths for CGo ─────────────────────────────────────────────
# cmake mirrors add_subdirectory structure: libs end up under build/vendor/...
CGO_CFLAGS_VAL  := -I$(abspath $(LLAMA_DIR)/include) -I$(abspath $(WHISPER_DIR)/include) -I$(abspath $(LLAMA_DIR)/ggml/include)

CGO_LDFLAGS_VAL := -L$(abspath $(BUILD_DIR)/vendor/llama.cpp/src) \
                   -L$(abspath $(BUILD_DIR)/vendor/whisper.cpp/src) \
                   -L$(abspath $(BUILD_DIR)/vendor/llama.cpp/ggml/src) \
                   -L$(abspath $(BUILD_DIR)/vendor/llama.cpp/ggml/src/ggml-metal) \
                   -L$(abspath $(BUILD_DIR)/vendor/llama.cpp/ggml/src/ggml-blas)

# ── OS-specific settings ──────────────────────────────────────────────────────
ifeq ($(OS_NAME),Windows_NT)
  # Ninja: use C:\mingw64\bin\gcc (same as Go CGo) to avoid MSYS2 toolchain mix
  # GGML_OPENMP=OFF: avoid GOMP_* undefined references on Windows
  CMAKE_GENERATOR   := -G Ninja
  CMAKE_EXTRA_FLAGS := -DCMAKE_STATIC_LIBRARY_PREFIX=lib -DGGML_OPENMP=OFF
  CMAKE_BUILD_FLAGS :=
  BIN_EXT           := .exe
else
  # -j2: cap parallel compilation to avoid OOM on CI runners (arm64: 2-core/8GB)
  CMAKE_BUILD_FLAGS := -j2
  CMAKE_GENERATOR   :=
  CMAKE_EXTRA_FLAGS :=
  BIN_EXT           :=
endif

BIN := server$(BIN_EXT)

# ── targets ───────────────────────────────────────────────────────────────────
.PHONY: all build deps test clean rebuild distclean

all: build

## deps: clone whisper.cpp + llama.cpp and build with cmake
deps: $(BUILD_DIR)/.built

$(LLAMA_DIR):
	@echo "[deps] Cloning llama.cpp ($(LLAMA_VERSION))..."
	git clone --depth=1 --branch $(LLAMA_VERSION) \
	$(LLAMA_REPO) $(LLAMA_DIR)

$(WHISPER_DIR):
	@echo "[deps] Cloning whisper.cpp ($(WHISPER_VERSION))..."
	git clone --depth=1 --branch $(WHISPER_VERSION) \
	https://github.com/ggerganov/whisper.cpp.git $(WHISPER_DIR)

$(BUILD_DIR)/.built: $(LLAMA_DIR) $(WHISPER_DIR)
	@echo "[cmake] Building with GPU=$(GPU_TARGET)..."
	cmake -S . -B $(BUILD_DIR) \
	$(CMAKE_GENERATOR) \
	$(CMAKE_EXTRA_FLAGS) \
	-DCMAKE_BUILD_TYPE=Release \
	-DBUILD_SHARED_LIBS=OFF \
	$(CMAKE_GPU_FLAGS)
	cmake --build $(BUILD_DIR) $(CMAKE_BUILD_FLAGS) --target llama whisper
	@if [ "$(OS_NAME)" = "Windows_NT" ]; then \
		GGML_SRC="$(BUILD_DIR)/vendor/llama.cpp/ggml/src"; \
		for lib in ggml ggml-base ggml-cpu; do \
			if [ -f "$$GGML_SRC/$$lib.a" ] && [ ! -f "$$GGML_SRC/lib$$lib.a" ]; then \
				echo "[fix] $$lib.a -> lib$$lib.a"; \
				cp "$$GGML_SRC/$$lib.a" "$$GGML_SRC/lib$$lib.a"; \
			fi; \
		done; \
	fi
	@touch $(BUILD_DIR)/.built

## build: build Go binary after deps
build: deps
	@echo "[go build] tags=$(GO_TAGS) GPU=$(GPU_TARGET)"
	CGO_ENABLED=1 \
	CGO_CFLAGS="$(CGO_CFLAGS_VAL)" \
	CGO_LDFLAGS="$(CGO_LDFLAGS_VAL) $(CGO_EXTRA_LDFLAGS)" \
	go build $(if $(GO_TAGS),-tags $(GO_TAGS)) -o $(BIN) .

## test: run go test with CGo include/library paths
test: deps
	@echo "[go test] tags=$(GO_TAGS) GPU=$(GPU_TARGET)"
	CGO_ENABLED=1 \
	CGO_CFLAGS="$(CGO_CFLAGS_VAL)" \
	CGO_LDFLAGS="$(CGO_LDFLAGS_VAL) $(CGO_EXTRA_LDFLAGS)" \
	go test $(if $(GO_TAGS),-tags $(GO_TAGS)) -v -count=1 -timeout=120s ./...

## clean: remove binary and cmake build artifacts
clean:
	rm -f $(BIN)
	rm -rf $(BUILD_DIR)

## rebuild: force cmake rebuild + go build without re-cloning vendor
##          use after: git pull changes bridge C++ files or cmake settings
rebuild:
	rm -f $(BUILD_DIR)/.built $(BIN)
	$(MAKE) build

## distclean: remove everything including vendor
distclean: clean
	rm -rf $(VENDOR_DIR)
