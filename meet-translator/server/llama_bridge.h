/* llama_bridge.h – llama.cpp への最小 C ブリッジ (CGo から呼ぶ C インターフェース)
 *
 * このヘッダーは CGo (C コンパイラ) からインクルードされるため
 * C++ 構文を使わず、extern "C" ガードを付ける。
 */
#ifndef LLAMA_BRIDGE_H
#define LLAMA_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* 不透明モデルハンドル */
typedef struct llama_bridge_model_s* llama_bridge_model;

/*
 * llama_bridge_backend_init
 *   プロセス起動時に一度だけ呼ぶ。llama_backend_init() を呼ぶ。
 */
void llama_bridge_backend_init(void);

/*
 * llama_bridge_backend_free
 *   プロセス終了時に一度だけ呼ぶ。
 */
void llama_bridge_backend_free(void);

/*
 * llama_bridge_load_model
 *   model_path: GGUF モデルファイルパス
 *   n_gpu_layers: GPU にオフロードするレイヤ数 (0=CPU only, -1=全レイヤ)
 *   戻り値: NULL = 失敗
 */
llama_bridge_model llama_bridge_load_model(const char* model_path, int n_gpu_layers);

/*
 * llama_bridge_free_model
 */
void llama_bridge_free_model(llama_bridge_model model);

/*
 * llama_bridge_generate
 *   1 つのテキスト補完を行いテキストを output_buf に書き込む。
 *   戻り値: 0=成功, 負=失敗 (error_buf にメッセージ)
 */
int llama_bridge_generate(
    llama_bridge_model model,
    const char*  prompt,
    int          max_tokens,
    float        temperature,
    char*        output_buf,
    int          output_buf_size,
    char*        error_buf,
    int          error_buf_size
);

#ifdef __cplusplus
}
#endif

#endif /* LLAMA_BRIDGE_H */
