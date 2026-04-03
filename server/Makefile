UNAME_S := $(shell uname -s)

WHISPER_REPO    := https://github.com/ggerganov/whisper.cpp.git
WHISPER_VERSION := v1.7.4
WHISPER_DIR     := vendor/whisper.cpp
BUILD_DIR       := $(WHISPER_DIR)/build

INCLUDE_PATH := $(abspath $(WHISPER_DIR)/include):$(abspath $(WHISPER_DIR)/ggml/include)
LIBRARY_PATH := $(abspath $(BUILD_DIR)/src):$(abspath $(BUILD_DIR)/ggml/src)

ifeq ($(UNAME_S),Darwin)
  LIBRARY_PATH += :$(abspath $(BUILD_DIR)/ggml/src/ggml-metal):$(abspath $(BUILD_DIR)/ggml/src/ggml-blas)
  EXTRA_LDFLAGS := -framework Foundation -framework Metal -framework MetalKit \
                   -framework Accelerate -framework CoreGraphics \
                   -lggml-metal -lggml-blas
endif

# --- ターゲット ---

.PHONY: all build whisper clean

## all: whisper.cpp ライブラリをビルドして Go バイナリを生成する
all: build

## whisper: vendor/whisper.cpp のクローンと静的ライブラリのビルド
whisper: $(BUILD_DIR)/src/libwhisper.a

$(WHISPER_DIR):
	git clone --depth=1 --branch $(WHISPER_VERSION) $(WHISPER_REPO) $(WHISPER_DIR)

$(BUILD_DIR)/src/libwhisper.a: $(WHISPER_DIR)
	cmake -S $(WHISPER_DIR) -B $(BUILD_DIR) \
		-DCMAKE_BUILD_TYPE=Release \
		-DBUILD_SHARED_LIBS=OFF \
		-DWHISPER_BUILD_SERVER=OFF \
		-DWHISPER_BUILD_TESTS=OFF \
		-DWHISPER_BUILD_EXAMPLES=OFF
	cmake --build $(BUILD_DIR) --target whisper -j

## build: whisper ライブラリをビルドし、Go バイナリをコンパイルする
build: whisper
	C_INCLUDE_PATH="$(INCLUDE_PATH)" \
	LIBRARY_PATH="$(LIBRARY_PATH)" \
	CGO_ENABLED=1 \
	go build \
	  $(if $(EXTRA_LDFLAGS),-ldflags "-extldflags '$(EXTRA_LDFLAGS)'") \
	  -o meet-translator-server .

## clean: ビルド成果物を削除する (whisper.cpp ソースは残す)
clean:
	rm -f meet-translator-server
	rm -rf $(BUILD_DIR)

## distclean: vendor を含め全削除
distclean: clean
	rm -rf $(WHISPER_DIR)
