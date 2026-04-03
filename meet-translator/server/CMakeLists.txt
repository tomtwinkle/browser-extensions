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

cmake_minimum_required(VERSION 3.14)
project(meet-translator-deps C CXX)

# ── 共通設定 ──────────────────────────────────────────────────────────────────
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_BUILD_TYPE  Release CACHE STRING "" FORCE)

# ── llama.cpp（ggml を提供するため先にビルド）────────────────────────────────
set(LLAMA_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
add_subdirectory(vendor/llama.cpp)

# ── whisper.cpp（ggml は llama.cpp のものを再利用）───────────────────────────
set(WHISPER_BUILD_SERVER   OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS    OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TOOLS    OFF CACHE BOOL "" FORCE)
add_subdirectory(vendor/whisper.cpp)
