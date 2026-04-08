# ──────────────────────────────────────────────────────────────────────────────
# meet-translator-server Makefile
#
# Usage:
#   make                   auto-detect GPU and build (official llama.cpp: gemma4 対応)
#   make GPU=cuda          force NVIDIA CUDA
#   make GPU=metal         force Apple Metal
#   make GPU=cpu           CPU only
#   make prism             PrismML ビルド (bonsai-8b / Q1_0_g128 対応) → server-prism
#   make all               両バリアント (server + server-prism) をビルド
#   make rebuild           re-run cmake + go build (keep vendor clone)
#   make clean             remove binary + cmake build
#   make distclean         remove vendor as well
# ──────────────────────────────────────────────────────────────────────────────

# ── Standard build (official llama.cpp: gemma4 support) ──────────────────────
LLAMA_VERSION   := b8699
LLAMA_REPO      := https://github.com/ggml-org/llama.cpp.git

# ── PrismML build (Q1_0_g128 support for bonsai-8b) ──────────────────────────
LLAMA_VERSION_PRISM := prism-b8201-ba7e817
LLAMA_REPO_PRISM    := https://github.com/PrismML-Eng/llama.cpp.git

WHISPER_VERSION := v1.8.4

OS_NAME   := $(shell uname -s 2>/dev/null || echo Windows_NT)
ARCH_NAME := $(shell uname -m 2>/dev/null || echo x86_64)

# normalize MSYS2/MinGW/Cygwin uname (returns MINGW.../MSYS.../CYGWIN...) to Windows_NT
ifneq ($(filter MINGW% MSYS% CYGWIN%,$(OS_NAME)),)
  OS_NAME := Windows_NT
endif

VENDOR_DIR       := vendor
BUILD_DIR        := $(VENDOR_DIR)/build
LLAMA_DIR        := $(VENDOR_DIR)/llama.cpp
WHISPER_DIR      := $(VENDOR_DIR)/whisper.cpp

# PrismML バリアント用ディレクトリ (標準と共存)
VENDOR_PRISM_DIR := vendor-prism
BUILD_PRISM_DIR  := $(VENDOR_PRISM_DIR)/build
LLAMA_PRISM_DIR  := $(VENDOR_PRISM_DIR)/llama.cpp
WHISPER_PRISM_DIR := $(VENDOR_PRISM_DIR)/whisper.cpp

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

# PrismML バリアント用 CGo パス
CGO_CFLAGS_PRISM_VAL  := -I$(abspath $(LLAMA_PRISM_DIR)/include) -I$(abspath $(WHISPER_PRISM_DIR)/include) -I$(abspath $(LLAMA_PRISM_DIR)/ggml/include)

CGO_LDFLAGS_PRISM_VAL := -L$(abspath $(BUILD_PRISM_DIR)/llama.cpp/src) \
                          -L$(abspath $(BUILD_PRISM_DIR)/whisper.cpp/src) \
                          -L$(abspath $(BUILD_PRISM_DIR)/llama.cpp/ggml/src) \
                          -L$(abspath $(BUILD_PRISM_DIR)/llama.cpp/ggml/src/ggml-metal) \
                          -L$(abspath $(BUILD_PRISM_DIR)/llama.cpp/ggml/src/ggml-blas)

# ,のエスケープ (GNU Make で GO_TAGS に , を含める際に必要)
comma := ,

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

BIN       := server$(BIN_EXT)
BIN_PRISM := server-prism$(BIN_EXT)

# ── targets ───────────────────────────────────────────────────────────────────
.PHONY: all build prism deps deps-prism test bench-build bench clean rebuild distclean

## all: 両バリアント (server + server-prism) をビルド
all: build prism

## build: 標準ビルド (gemma4 対応, 公式 ggml-org/llama.cpp)
build: deps
	@echo "[go build] tags=$(GO_TAGS) GPU=$(GPU_TARGET) variant=standard"
	CGO_ENABLED=1 \
	CGO_CFLAGS="$(CGO_CFLAGS_VAL)" \
	CGO_LDFLAGS="$(CGO_LDFLAGS_VAL) $(CGO_EXTRA_LDFLAGS)" \
	go build $(if $(GO_TAGS),-tags $(GO_TAGS)) -o $(BIN) .

## prism: PrismML ビルド (bonsai-8b / Q1_0_g128 対応) → server-prism
prism: deps-prism
	@echo "[go build] tags=$(GO_TAGS),prism GPU=$(GPU_TARGET) variant=prism"
	CGO_ENABLED=1 \
	CGO_CFLAGS="$(CGO_CFLAGS_PRISM_VAL)" \
	CGO_LDFLAGS="$(CGO_LDFLAGS_PRISM_VAL) $(CGO_EXTRA_LDFLAGS)" \
	go build $(if $(GO_TAGS),-tags $(GO_TAGS)$(comma)prism,-tags prism) -o $(BIN_PRISM) .

## deps: 標準ビルド用ライブラリをクローン＆ビルド
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
	@echo "[cmake] Building standard variant with GPU=$(GPU_TARGET)..."
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

## deps-prism: PrismML ビルド用ライブラリをクローン＆ビルド
deps-prism: $(BUILD_PRISM_DIR)/.built

$(LLAMA_PRISM_DIR):
	@echo "[deps-prism] Cloning llama.cpp PrismML fork ($(LLAMA_VERSION_PRISM))..."
	git clone --depth=1 --branch $(LLAMA_VERSION_PRISM) \
	$(LLAMA_REPO_PRISM) $(LLAMA_PRISM_DIR)

$(WHISPER_PRISM_DIR):
	@echo "[deps-prism] Cloning whisper.cpp ($(WHISPER_VERSION))..."
	git clone --depth=1 --branch $(WHISPER_VERSION) \
	https://github.com/ggerganov/whisper.cpp.git $(WHISPER_PRISM_DIR)

$(BUILD_PRISM_DIR)/.built: $(LLAMA_PRISM_DIR) $(WHISPER_PRISM_DIR)
	@echo "[cmake] Building PrismML variant with GPU=$(GPU_TARGET)..."
	cmake -S . -B $(BUILD_PRISM_DIR) \
	-DVENDOR_DIR=$(abspath $(VENDOR_PRISM_DIR)) \
	$(CMAKE_GENERATOR) \
	$(CMAKE_EXTRA_FLAGS) \
	-DCMAKE_BUILD_TYPE=Release \
	-DBUILD_SHARED_LIBS=OFF \
	$(CMAKE_GPU_FLAGS)
	cmake --build $(BUILD_PRISM_DIR) $(CMAKE_BUILD_FLAGS) --target llama whisper
	@if [ "$(OS_NAME)" = "Windows_NT" ]; then \
		GGML_SRC="$(BUILD_PRISM_DIR)/llama.cpp/ggml/src"; \
		for lib in ggml ggml-base ggml-cpu; do \
			if [ -f "$$GGML_SRC/$$lib.a" ] && [ ! -f "$$GGML_SRC/lib$$lib.a" ]; then \
				echo "[fix] $$lib.a -> lib$$lib.a"; \
				cp "$$GGML_SRC/$$lib.a" "$$GGML_SRC/lib$$lib.a"; \
			fi; \
		done; \
	fi
	@touch $(BUILD_PRISM_DIR)/.built

## test: run go test with CGo include/library paths
test: deps
	@echo "[go test] tags=$(GO_TAGS) GPU=$(GPU_TARGET)"
	CGO_ENABLED=1 \
	CGO_CFLAGS="$(CGO_CFLAGS_VAL)" \
	CGO_LDFLAGS="$(CGO_LDFLAGS_VAL) $(CGO_EXTRA_LDFLAGS)" \
	go test $(if $(GO_TAGS),-tags $(GO_TAGS)) -v -count=1 -timeout=120s ./...

## bench-build: ベンチマークツールをビルドする (CGo 不要)
bench-build:
	@echo "[go build] benchmark tool"
	go build -o benchmark ./cmd/benchmark/

## bench: 起動中のサーバー (localhost:7070) に対してベンチマークを実行する
##        事前に ./server --llama-model <model> でサーバーを起動しておくこと
##        例: make bench OUTPUT=results/bonsai-8b.json
bench: bench-build
	./benchmark $(if $(OUTPUT),--output $(OUTPUT),)

## clean: remove binary and cmake build artifacts
clean:
	rm -f $(BIN) $(BIN_PRISM)
	rm -rf $(BUILD_DIR) $(BUILD_PRISM_DIR)

## rebuild: force cmake rebuild + go build without re-cloning vendor
##          use after: git pull changes bridge C++ files or cmake settings
rebuild:
	rm -f $(BUILD_DIR)/.built $(BIN)
	$(MAKE) build

## distclean: remove everything including vendor
distclean: clean
	rm -rf $(VENDOR_DIR) $(VENDOR_PRISM_DIR)
