# ──────────────────────────────────────────────────────────────────────────────
# meet-translator-server Makefile
#
# 使い方:
#   make                   GPU を自動検出してビルド
#   make GPU=cuda          NVIDIA CUDA を強制有効
#   make GPU=metal         Apple Metal を強制有効
#   make GPU=cpu           CPU のみ
#   make clean             バイナリ + cmake ビルドを削除
#   make distclean         vendor も含め全削除
# ──────────────────────────────────────────────────────────────────────────────

# バージョン固定
LLAMA_VERSION   := b5192
WHISPER_VERSION := v1.7.4

OS_NAME   := $(shell uname -s 2>/dev/null || echo Windows_NT)
ARCH_NAME := $(shell uname -m 2>/dev/null || echo x86_64)

VENDOR_DIR  := vendor
BUILD_DIR   := $(VENDOR_DIR)/build
LLAMA_DIR   := $(VENDOR_DIR)/llama.cpp
WHISPER_DIR := $(VENDOR_DIR)/whisper.cpp

# ── GPU ターゲット検出 ────────────────────────────────────────────────────────
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

# ── cmake GPU フラグ & Go build tags ──────────────────────────────────────────
CMAKE_GPU_FLAGS :=
GO_TAGS         :=
CGO_EXTRA_LDFLAGS :=

ifeq ($(GPU_TARGET),metal)
  CMAKE_GPU_FLAGS    := -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=ON
  GO_TAGS            := metal
  CGO_EXTRA_LDFLAGS  := -framework Foundation -framework Metal -framework MetalKit \
	-framework Accelerate -framework CoreGraphics

else ifeq ($(GPU_TARGET),cuda)
  CMAKE_GPU_FLAGS    := -DGGML_CUDA=ON -DGGML_CUDA_F16=ON
  GO_TAGS            := cuda

else
  CMAKE_GPU_FLAGS    := -DGGML_METAL=OFF -DGGML_BLAS=OFF
endif

# ── インクルード / ライブラリパス ──────────────────────────────────────────────
INCLUDE_PATH := $(abspath $(LLAMA_DIR)/include):$(abspath $(WHISPER_DIR)/include):$(abspath $(LLAMA_DIR)/ggml/include)

LIBRARY_PATH := $(abspath $(BUILD_DIR)/src):$(abspath $(BUILD_DIR)/ggml/src)

ifeq ($(GPU_TARGET),metal)
  LIBRARY_PATH := $(LIBRARY_PATH):$(abspath $(BUILD_DIR)/ggml/src/ggml-metal):$(abspath $(BUILD_DIR)/ggml/src/ggml-blas)
endif

ifeq ($(GPU_TARGET),cuda)
  LIBRARY_PATH := $(LIBRARY_PATH):$(abspath $(BUILD_DIR)/ggml/src/ggml-cuda)
endif

# ── OS 固有設定 ────────────────────────────────────────────────────────────────
ifeq ($(OS_NAME),Windows_NT)
  CMAKE_BUILD_FLAGS := --config Release
  BIN_EXT           := .exe
else
  CMAKE_BUILD_FLAGS := -j
  BIN_EXT           :=
endif

BIN := meet-translator-server$(BIN_EXT)

# ── ターゲット ────────────────────────────────────────────────────────────────
.PHONY: all build deps test clean distclean

all: build

## deps: whisper.cpp + llama.cpp をクローンして cmake でビルド
deps: $(BUILD_DIR)/.built

$(LLAMA_DIR):
	@echo "[deps] llama.cpp をクローン中 ($(LLAMA_VERSION))..."
	git clone --depth=1 --branch $(LLAMA_VERSION) \
	https://github.com/ggerganov/llama.cpp.git $(LLAMA_DIR)

$(WHISPER_DIR):
	@echo "[deps] whisper.cpp をクローン中 ($(WHISPER_VERSION))..."
	git clone --depth=1 --branch $(WHISPER_VERSION) \
	https://github.com/ggerganov/whisper.cpp.git $(WHISPER_DIR)

$(BUILD_DIR)/.built: $(LLAMA_DIR) $(WHISPER_DIR)
	@echo "[cmake] GPU=$(GPU_TARGET) でビルド中..."
	cmake -S . -B $(BUILD_DIR) \
	-DCMAKE_BUILD_TYPE=Release \
	-DBUILD_SHARED_LIBS=OFF \
	$(CMAKE_GPU_FLAGS)
	cmake --build $(BUILD_DIR) $(CMAKE_BUILD_FLAGS) --target llama whisper
	@touch $(BUILD_DIR)/.built

## build: deps の後に Go バイナリをビルド
build: deps
	@echo "[go build] tags=$(GO_TAGS) GPU=$(GPU_TARGET)"
	C_INCLUDE_PATH="$(INCLUDE_PATH)" \
	LIBRARY_PATH="$(LIBRARY_PATH)" \
	CGO_ENABLED=1 \
	CGO_LDFLAGS="$(CGO_EXTRA_LDFLAGS)" \
	go build $(if $(GO_TAGS),-tags $(GO_TAGS)) -o $(BIN) .

## test: CGo ヘッダーとライブラリパスを設定して go test を実行
test: deps
	@echo "[go test] tags=$(GO_TAGS) GPU=$(GPU_TARGET)"
	C_INCLUDE_PATH="$(INCLUDE_PATH)" \
	LIBRARY_PATH="$(LIBRARY_PATH)" \
	CGO_ENABLED=1 \
	CGO_LDFLAGS="$(CGO_EXTRA_LDFLAGS)" \
	go test $(if $(GO_TAGS),-tags $(GO_TAGS)) -v -count=1 -timeout=120s ./...

## clean: バイナリと cmake ビルド成果物を削除
clean:
	rm -f $(BIN)
	rm -rf $(BUILD_DIR)

## distclean: vendor を含め全削除
distclean: clean
	rm -rf $(VENDOR_DIR)
