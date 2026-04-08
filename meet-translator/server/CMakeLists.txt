# CMakeLists.txt – whisper.cpp + llama.cpp を ggml 共有でまとめてビルド
#
# ggml は llama.cpp が先にビルドし、whisper.cpp は "if(NOT TARGET ggml)" ガードで
# 既存ターゲットを再利用する。これにより最終バイナリに ggml 実装が 1 つだけ含まれる。
#
# GPU オプション (cmake -D フラグで渡す):
#   -DGGML_METAL=ON                   Apple Metal (macOS)
#   -DGGML_METAL_EMBED_LIBRARY=ON     Metal シェーダーをバイナリに埋め込む
#   -DGGML_BLAS=ON                    BLAS 加速 (macOS Accelerate)
#   -DGGML_CUDA=ON                    NVIDIA CUDA
#   -DGGML_CUDA_F16=ON                CUDA FP16 (精度向上)
#
# バリアント切り替え:
#   -DVENDOR_DIR=<path>  使用する vendor ディレクトリを指定 (デフォルト: vendor)
#                        PrismML ビルド時は vendor-prism を指定する

cmake_minimum_required(VERSION 3.14)
project(meet-translator-deps C CXX)

# ── 共通設定 ──────────────────────────────────────────────────────────────────
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_BUILD_TYPE  Release CACHE STRING "" FORCE)

# VENDOR_DIR: デフォルトは vendor。PrismML ビルド時は Makefile から vendor-prism を渡す。
# 注意: ここでは VENDOR_DIR を設定しない。Makefile が -DVENDOR_DIR=<abs-path> で渡すか、
#       渡さない場合は下記の else ブランチで相対パス (vendor/) を使用する。

# ── llama.cpp（ggml を提供するため先にビルド）────────────────────────────────
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
if(DEFINED VENDOR_DIR)
  # カスタム vendor ディレクトリ (PrismML ビルド: vendor-prism/ など)
  # 絶対パスの add_subdirectory には明示的なバイナリディレクトリが必要
  add_subdirectory(${VENDOR_DIR}/llama.cpp ${CMAKE_BINARY_DIR}/llama.cpp)
else()
  # 標準ビルド: 相対パスで cmake がミラー構造を作る (build/vendor/llama.cpp/)
  add_subdirectory(vendor/llama.cpp)
endif()

# ── whisper.cpp（ggml は llama.cpp のものを再利用）───────────────────────────
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
if(DEFINED VENDOR_DIR)
  add_subdirectory(${VENDOR_DIR}/whisper.cpp ${CMAKE_BINARY_DIR}/whisper.cpp)
else()
  add_subdirectory(vendor/whisper.cpp)
endif()
